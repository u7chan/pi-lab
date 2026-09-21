/**
 * Skill dispatch PoC — Pi integration.
 *
 * The hook sits in front of every user turn, so this adapter is written as a
 * set of gates rather than a router.  A prompt leaves the machine only when all
 * of the following hold:
 *
 *   1. `enabled` in config (persistent, default false)
 *   2. session mode `live` (`off` and `dry-run` are the other two states)
 *   3. the input is interactive text, not a slash command
 *   4. `ctx.cwd` is inside `projectAllowlist` (empty means nothing is allowed)
 *   5. the session dispatch budget is not exhausted
 *   6. the roster is non-empty and the API key resolves
 *
 * `dry-run` walks the same path, builds the same request, and logs what it
 * would have sent without opening a connection.  `skillRoots` are also
 * published to Pi through `resources_discover`, but only when the session is
 * enabled and in scope, so an unrelated project does not even gain the skills.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
	buildDispatchRequest,
	buildTransformText,
	formatDecision,
	INSTRUCTION_VERSION,
	interpretDispatch,
	OTHER_CHOICE,
	type DispatchDecision,
	type DispatchThresholds,
} from "../../src/dispatcher.ts";
import {
	evaluateGate,
	evaluateReadiness,
	isCwdAllowed,
	type SendMode,
} from "../../src/gate.ts";
import {
	POC_CONFIG_FILE,
	POC_KEY_FILE,
	POC_MARKER_FILE,
	describeKeySource,
	expandHome,
	hashText,
	pocPaths,
	resolveApiKey,
	type PocPaths,
} from "../../src/key-source.ts";
import {
	KEY_FILE_TEMPLATE,
	POC_MARKER_TEXT,
	defaultConfig,
	isPocMarker,
	parseConfig,
	serializeConfig,
	type SkillDispatchConfig,
} from "../../src/poc-store.ts";
import {
	estimateTokens,
	rosterText,
	scanSkillRoots,
	type SkillScan,
} from "../../src/skill-source.ts";
import { createTypeSafeClient } from "../../src/typesafe-client.ts";

export {
	DEFAULT_GATE,
	DEFAULT_NOUL_THRESHOLD,
	DEFAULT_OTHER_THRESHOLD,
	DEFAULT_THRESHOLD,
	KEY_FILE_TEMPLATE,
	POC_MARKER_TEXT,
	defaultConfig,
	isPocMarker,
	parseConfig,
	serializeConfig,
} from "../../src/poc-store.ts";
export {
	describeKeySource,
	expandHome,
	extractApiKeyFromEnvFile,
	fingerprintKey,
	hashText,
	parseKeySourceSpec,
	pocPaths,
	redactSecrets,
	resolveApiKey,
} from "../../src/key-source.ts";
export {
	createTypeSafeClient,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	DEFAULT_TIMEOUT_MS,
	describeHttpFailure,
	isSystemOneResponse,
	SYSTEM_ONE_PATH,
} from "../../src/typesafe-client.ts";
export {
	buildDispatchRequest,
	buildTransformText,
	INSTRUCTION_VERSION,
	interpretDispatch,
	INTERPRET_REASONS,
	OTHER_CHOICE,
	formatDecision,
} from "../../src/dispatcher.ts";
export { evaluateGate, evaluateReadiness, isCwdAllowed, isWithin } from "../../src/gate.ts";
export {
	estimateTokens,
	MAX_DESCRIPTION_CHARS,
	MAX_SKILLS,
	parseSkillFrontmatter,
	rosterText,
	scanSkillRoots,
} from "../../src/skill-source.ts";
export type { SendMode } from "../../src/gate.ts";

const STATUS_KEY = "skill-dispatch";
const MODE_PRIVATE_DIR = 0o700;
const MODE_PRIVATE_FILE = 0o600;
/** Roster cache lifetime; long enough to stay off the per-turn path. */
const ROSTER_TTL_MS = 5 * 60 * 1000;
const ROSTER_PREVIEW = 8;

const PROBE_STATE = "こんにちは。今日はいい天気ですね。";
const PROBE_QUESTION = "このテキストは挨拶ですか。";

/** The thresholds `interpretDispatch` needs, taken from config. */
function dispatchThresholds(config: SkillDispatchConfig): DispatchThresholds {
	return {
		gate: config.gate,
		confidenceThreshold: config.threshold,
		otherThreshold: config.otherThreshold,
		noulThreshold: config.noulThreshold,
	};
}

const USAGE = [
	"usage: /skill-dispatch <command>",
	"  status            config, scope, roster, key, last decision",
	"  init              create the PoC directory and an empty key file",
	"  roster            scan skillRoots and show sizes",
	"  probe             one real System One call, reported with latency",
	"  on [--save]       enable (session only unless --save; adds cwd to the allowlist)",
	"  off [--save]      disable",
	"  dry               session mode: build and log, never send",
	"  live              session mode: send, decide, rewrite the input",
	"  purge             delete the PoC directory (marker-guarded)",
].join("\n");

interface SessionState {
	config: SkillDispatchConfig;
	warnings: readonly string[];
	mode: SendMode;
	roster: SkillScan;
	rosterAt: number;
	dispatched: number;
	lastDecision?: string;
}

interface LogEntry {
	readonly at: string;
	readonly mode: SendMode;
	readonly kind: "dry-run" | "dispatch" | "abstain" | "error" | "gate";
	readonly reason: string;
	readonly skill?: string;
	readonly confidence?: number;
	readonly otherProbability?: number;
	readonly gates?: { wantsAction: number; specificTask: number; mean: number };
	readonly model?: string;
	readonly latencyMs?: number;
	readonly inputTokens?: number;
	readonly rosterSize?: number;
	readonly promptChars: number;
	readonly promptHash: string;
	readonly truncated?: boolean;
	readonly instructionVersion: string;
	readonly cwd: string;
	readonly prompt?: string;
}

function readTextIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function writePrivateFile(path: string, contents: string): void {
	writeFileSync(path, contents, { mode: MODE_PRIVATE_FILE });
	chmodSync(path, MODE_PRIVATE_FILE);
}

/** Resolve a path for scope checks so a symlinked cwd cannot slip past. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolvePath(path);
	}
}

function loadConfig(paths: PocPaths): { config: SkillDispatchConfig; warnings: readonly string[] } {
	const base = defaultConfig(paths);
	const text = readTextIfExists(paths.configFile);
	if (text === undefined) return { config: base, warnings: [] };
	return parseConfig(text, base);
}

function ensurePocDir(paths: PocPaths): boolean {
	const existed = existsSync(paths.marker);
	mkdirSync(paths.dir, { recursive: true, mode: MODE_PRIVATE_DIR });
	if (!existed) chmodSync(paths.dir, MODE_PRIVATE_DIR);
	if (!existsSync(paths.marker)) writePrivateFile(paths.marker, POC_MARKER_TEXT);
	if (!existsSync(paths.keyFile)) writePrivateFile(paths.keyFile, KEY_FILE_TEMPLATE);
	if (!existsSync(paths.configFile)) {
		writePrivateFile(paths.configFile, serializeConfig(defaultConfig(paths)));
	}
	return !existed;
}

function purgePocDir(paths: PocPaths): { ok: true } | { ok: false; reason: string } {
	const marker = readTextIfExists(paths.marker);
	if (marker === undefined) return { ok: false, reason: `no PoC marker at ${paths.marker}` };
	if (!isPocMarker(marker)) {
		return { ok: false, reason: `refusing to delete ${paths.dir}: marker does not match this PoC` };
	}
	rmSync(paths.dir, { recursive: true, force: true });
	return { ok: true };
}

/** Expand and resolve the configured roots and allowlist entries. */
function resolveEntries(entries: readonly string[], home: string): string[] {
	return entries
		.map((entry) => realPath(resolvePath(expandHome(entry, home))))
		.filter((entry, index, all) => all.indexOf(entry) === index);
}

function appendLog(paths: PocPaths, entry: LogEntry): void {
	try {
		appendFileSync(paths.logFile, `${JSON.stringify(entry)}\n`, { mode: MODE_PRIVATE_FILE });
	} catch {
		// Logging is best-effort: a full disk must not break a turn.
	}
}

export default function skillDispatchExtension(pi: ExtensionAPI): void {
	const paths = pocPaths();
	const home = process.env.HOME ?? "";
	let state: SessionState | undefined;

	const resolvedAllowlist = (config: SkillDispatchConfig): string[] =>
		resolveEntries(config.projectAllowlist, home);

	const statusText = (session: SessionState): string => {
		if (!session.config.enabled) return "skill: off";
		if (session.mode === "off") return "skill: off (session)";
		if (session.mode === "dry-run") return `skill: dry (${session.roster.skills.length})`;
		const latency = session.lastDecision === undefined ? "" : ` ${session.lastDecision}`;
		return `skill: live ${session.dispatched}${latency}`;
	};

	const renderStatus = (session: SessionState, ctx: ExtensionContext): void => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusText(session));
	};

	const scanRoster = (session: SessionState, force = false): SkillScan => {
		if (!force && Date.now() - session.rosterAt < ROSTER_TTL_MS) return session.roster;
		const roots = resolveEntries(session.config.skillRoots, home);
		const scan = scanSkillRoots(roots);
		session.roster = scan;
		session.rosterAt = Date.now();
		return scan;
	};

	const ensureState = (ctx: ExtensionContext): SessionState => {
		if (state !== undefined) return state;
		const loaded = loadConfig(paths);
		state = {
			config: loaded.config,
			warnings: loaded.warnings,
			mode: loaded.config.enabled ? "dry-run" : "off",
			roster: { skills: [], warnings: [], truncated: false },
			rosterAt: 0,
			dispatched: 0,
		};
		scanRoster(state);
		return state;
	};

	/** Reason string for the footer when a gate stopped a prompt. */
	const noteGate = (session: SessionState, ctx: ExtensionContext, reason: string): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, `skill: blocked (${reason})`);
	};

	const describeStatus = async (session: SessionState, ctx: ExtensionContext): Promise<string[]> => {
		const { config } = session;
		const cwd = realPath(ctx.cwd);
		const allowlist = resolvedAllowlist(config);
		const inScope = allowlist.length > 0 && isCwdAllowed(cwd, allowlist);
		const roots = resolveEntries(config.skillRoots, home);
		const roster = scanRoster(session);
		const resolved = await resolveApiKey(config.typesafe.apiKeySource, { env: process.env });
		const keyLine = resolved.ok
			? `${resolved.resolved.source} → ok sha256:${resolved.resolved.fingerprint}`
			: `${describeKeySource(config.typesafe.apiKeySource)} → ${resolved.error}`;
		const tokens = estimateTokens(rosterText(roster.skills));

		return [
			`enabled: ${config.enabled ? "yes" : "no"}  session mode: ${session.mode}  dispatched: ${session.dispatched}`,
			`scope: ${inScope ? "in scope" : "out of scope"} (${cwd})`,
			`projectAllowlist: ${allowlist.length === 0 ? "(empty: nothing is allowed)" : allowlist.join(", ")}`,
			`skillRoots: ${roots.length === 0 ? "(unset)" : roots.join(", ")}`,
			`roster: ${roster.skills.length} skills, ~${tokens} tokens${roster.truncated ? " (truncated)" : ""}`,
			`thresholds: choice ${config.threshold}, gate ${config.gate} (other<=${config.otherThreshold} / noul>=${config.noulThreshold})  budget: ${config.maxDispatchesPerSession === 0 ? "unlimited" : config.maxDispatchesPerSession}`,
			`key: ${keyLine}`,
			`log: ${paths.logFile} (prompts ${config.logPrompts ? "logged" : "hashed only"})`,
			...(session.lastDecision === undefined
				? []
				: [`last decision: ${session.lastDecision}`]),
			...[...session.warnings, ...roster.warnings.slice(0, 3)],
		];
	};

	const saveConfig = (session: SessionState): void => {
		ensurePocDir(paths);
		writePrivateFile(paths.configFile, serializeConfig(session.config));
	};

	pi.on("session_start", async (_event, ctx) => {
		state = undefined;
		const session = ensureState(ctx);
		renderStatus(session, ctx);
	});

	/** Publish the same roots Pi uses for `/skill:<name>` — only when in scope. */
	pi.on("resources_discover", async (_event, ctx) => {
		const session = ensureState(ctx);
		if (!session.config.enabled) return;
		const allowlist = resolvedAllowlist(session.config);
		if (allowlist.length === 0 || !isCwdAllowed(realPath(ctx.cwd), allowlist)) return;
		const roots = resolveEntries(session.config.skillRoots, home).filter((root) => existsSync(root));
		if (roots.length === 0) return;
		return { skillPaths: roots };
	});

	pi.on("input", async (event, ctx) => {
		const session = ensureState(ctx);
		const { config } = session;

		const gate = evaluateGate({
			enabled: config.enabled,
			mode: session.mode,
			source: event.source,
			text: event.text,
			cwd: realPath(ctx.cwd),
			allowlist: resolvedAllowlist(config),
			dispatched: session.dispatched,
			maxDispatchesPerSession: config.maxDispatchesPerSession,
		});
		if (!gate.allowed) {
			noteGate(session, ctx, gate.reason);
			return { action: "continue" };
		}

		const roster = scanRoster(session);
		const readiness = evaluateReadiness({ skillCount: roster.skills.length, keyAvailable: true });
		if (!readiness.allowed) {
			noteGate(session, ctx, readiness.reason);
			return { action: "continue" };
		}

		const built = buildDispatchRequest(event.text, roster.skills);
		const baseLog = {
			at: new Date().toISOString(),
			mode: session.mode,
			cwd: realPath(ctx.cwd),
			rosterSize: roster.skills.length,
			promptChars: event.text.length,
			promptHash: hashText(event.text),
			truncated: built.truncated,
			instructionVersion: INSTRUCTION_VERSION,
			...(config.logPrompts ? { prompt: event.text } : {}),
		} as const;

		if (session.mode === "dry-run") {
			const tokens = estimateTokens(JSON.stringify(built.request));
			session.lastDecision = `dry ~${tokens} tokens`;
			appendLog(paths, {
				...baseLog,
				kind: "dry-run",
				reason: "dry-run",
				model: config.typesafe.model,
				inputTokens: tokens,
			});
			renderStatus(session, ctx);
			return { action: "continue" };
		}

		const resolved = await resolveApiKey(config.typesafe.apiKeySource, { env: process.env });
		if (!resolved.ok) {
			session.lastDecision = "key error";
			appendLog(paths, { ...baseLog, kind: "error", reason: "key-unresolved" });
			noteGate(session, ctx, resolved.error);
			return { action: "continue" };
		}

		const client = createTypeSafeClient({
			apiKey: resolved.resolved.key,
			model: config.typesafe.model,
			timeoutMs: config.typesafe.timeoutMs,
		});
		const outcome = await client.systemOne(built.request, { signal: ctx.signal });

		if (!outcome.ok) {
			session.lastDecision = `error ${outcome.failure.kind}`;
			appendLog(paths, {
				...baseLog,
				kind: "error",
				reason: `jev-${outcome.failure.kind}`,
				latencyMs: outcome.latencyMs,
			});
			noteGate(session, ctx, `${outcome.failure.kind}: ${outcome.failure.error}`);
			return { action: "continue" };
		}

		const decision: DispatchDecision = interpretDispatch(
			outcome.response,
			dispatchThresholds(config),
			built.truncated,
		);
		const other = decision.choice.probabilities[OTHER_CHOICE];
		appendLog(paths, {
			...baseLog,
			kind: decision.kind === "dispatch" ? "dispatch" : "abstain",
			reason: decision.reason,
			...(decision.skill === undefined ? {} : { skill: decision.skill }),
			confidence: decision.choice.confidence,
			...(other === undefined ? {} : { otherProbability: other }),
			gates: decision.gates,
			model: decision.model,
			latencyMs: outcome.latencyMs,
			...(decision.usage?.input_tokens === undefined ? {} : { inputTokens: decision.usage.input_tokens }),
		});

		session.lastDecision = `${formatDecision(decision)} ${outcome.latencyMs}ms`;
		renderStatus(session, ctx);

		if (decision.kind === "abstain" || decision.skill === undefined) {
			return { action: "continue" };
		}

		session.dispatched += 1;
		return { action: "transform", text: buildTransformText(decision.skill, event.text) };
	});

	pi.registerCommand("skill-dispatch", {
		description: "Skill dispatch PoC: status, scope, roster, probe, mode, cleanup",
		handler: async (args, ctx) => {
			const session = ensureState(ctx);
			const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
			const subcommand = (parts[0] ?? "status").toLowerCase();
			const save = parts.includes("--save");
			const report = (lines: readonly string[], level: "info" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), level);
				else console.log(lines.join("\n"));
			};

			if (subcommand === "status") {
				report(await describeStatus(session, ctx));
				return;
			}

			if (subcommand === "init") {
				const created = ensurePocDir(paths);
				report([
					created ? `created ${paths.dir}` : `${paths.dir} already exists`,
					`key file: ${paths.keyFile}`,
					"Add the key to the key file, then run: /skill-dispatch probe",
				]);
				return;
			}

			if (subcommand === "roster") {
				const roster = scanRoster(session, true);
				const tokens = estimateTokens(rosterText(roster.skills));
				report([
					`${roster.skills.length} skills, ~${tokens} tokens${roster.truncated ? " (truncated)" : ""}`,
					...roster.skills
						.slice(0, ROSTER_PREVIEW)
						.map((skill) => `${skill.name} (${skill.description.length} chars)`),
					...(roster.skills.length > ROSTER_PREVIEW
						? [`… and ${roster.skills.length - ROSTER_PREVIEW} more`]
						: []),
					...(roster.warnings.length === 0 ? [] : [`warnings: ${roster.warnings.length}`]),
				]);
				return;
			}

			if (subcommand === "on" || subcommand === "off") {
				const enabled = subcommand === "on";
				const allowlist =
					enabled && session.config.projectAllowlist.length === 0
						? [realPath(ctx.cwd)]
						: [...session.config.projectAllowlist];
				session.config = { ...session.config, enabled, projectAllowlist: allowlist };
				session.mode = enabled ? "dry-run" : "off";
				if (save) saveConfig(session);
				renderStatus(session, ctx);
				report([
					`enabled: ${enabled ? "yes" : "no"}  session mode: ${session.mode}${save ? "  (saved)" : "  (session only)"}`,
					`projectAllowlist: ${allowlist.length === 0 ? "(empty: nothing is allowed)" : allowlist.join(", ")}`,
					...(enabled ? ["nothing is sent until: /skill-dispatch live"] : []),
				]);
				return;
			}

			if (subcommand === "dry" || subcommand === "live") {
				if (!session.config.enabled) {
					report(["enable first: /skill-dispatch on [--save]"], "error");
					return;
				}
				session.mode = subcommand === "live" ? "live" : "dry-run";
				renderStatus(session, ctx);
				report([
					`session mode: ${session.mode}`,
					session.mode === "live"
						? "prompts in scope are now sent to TypeSafe"
						: "requests are built and logged only; nothing is sent",
				]);
				return;
			}

			if (subcommand === "probe") {
				const resolved = await resolveApiKey(session.config.typesafe.apiKeySource, { env: process.env });
				if (!resolved.ok) {
					report(
						[
							"probe failed: cannot resolve the API key",
							`key: ${resolved.source} → ${resolved.error}`,
							"hint: /skill-dispatch init, then write the key into the key file",
						],
						"error",
					);
					return;
				}
				const client = createTypeSafeClient({
					apiKey: resolved.resolved.key,
					model: session.config.typesafe.model,
					timeoutMs: session.config.typesafe.timeoutMs,
				});
				const outcome = await client.systemOne({
					state: PROBE_STATE,
					questions: { greeting: { type: "noul", instructions: PROBE_QUESTION } },
				});
				if (!outcome.ok) {
					report(
						[
							`probe failed: ${outcome.failure.kind} (${outcome.latencyMs}ms)`,
							outcome.failure.error,
							`key: ${resolved.resolved.source} sha256:${resolved.resolved.fingerprint}`,
						],
						"error",
					);
					return;
				}
				const answer = outcome.response.answers.greeting;
				report([
					`probe ok: ${outcome.latencyMs}ms`,
					`model: ${outcome.response.model}`,
					`greeting noul: ${answer?.type === "noul" ? answer.noul.toFixed(3) : "(missing)"}`,
					`tokens: in ${outcome.response.usage?.input_tokens ?? "?"} / out ${outcome.response.usage?.output_tokens ?? "?"}`,
					`key: ${resolved.resolved.source} sha256:${resolved.resolved.fingerprint}`,
				]);
				return;
			}

			if (subcommand === "purge") {
				if (!ctx.hasUI) {
					report(["purge needs a confirmation prompt; run it in the TUI"], "error");
					return;
				}
				if (!(await ctx.ui.confirm("Delete the Skill dispatch PoC?", paths.dir))) {
					ctx.ui.notify("purge cancelled", "info");
					return;
				}
				const result = purgePocDir(paths);
				report(
					result.ok
						? [`deleted ${paths.dir}`, "disable or remove the extension to finish cleanup"]
						: [`purge refused: ${result.reason}`],
					result.ok ? "info" : "error",
				);
				return;
			}

			report([USAGE, `files: ${paths.dir}`]);
		},
	});
}
