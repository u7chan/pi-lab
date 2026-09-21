/**
 * Skill dispatch PoC — command surface.
 *
 * The routing hook is not wired up yet; this adapter currently exposes the
 * operational commands only, so the key path and the TypeSafe request can be
 * verified inside Pi before anything runs on every turn:
 *
 *   /skill-dispatch status   config, key source, fingerprint
 *   /skill-dispatch init     create the PoC directory and an empty key file
 *   /skill-dispatch probe    one real System One call, reported with latency
 *   /skill-dispatch on|off   toggle dispatching
 *   /skill-dispatch purge    delete the PoC directory (marker-guarded)
 *
 * Nothing here displays, logs, or returns the API key.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	POC_CONFIG_FILE,
	POC_KEY_FILE,
	POC_MARKER_FILE,
	describeKeySource,
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
import { createTypeSafeClient } from "../../src/typesafe-client.ts";

export {
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

const MODE_PRIVATE_DIR = 0o700;
const MODE_PRIVATE_FILE = 0o600;

/** Probe state: short, Japanese, and unambiguous, so it also checks that path. */
const PROBE_STATE = "こんにちは。今日はいい天気ですね。";
const PROBE_QUESTION = "このテキストは挨拶ですか。";

interface ConfigLoad {
	readonly config: SkillDispatchConfig;
	readonly warnings: readonly string[];
	readonly fromFile: boolean;
}

function readTextIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function writePrivateFile(path: string, contents: string): void {
	// The mode argument only applies when the file is created, so enforce it.
	writeFileSync(path, contents, { mode: MODE_PRIVATE_FILE });
	chmodSync(path, MODE_PRIVATE_FILE);
}

function loadConfig(paths: PocPaths): ConfigLoad {
	const base = defaultConfig(paths);
	const text = readTextIfExists(paths.configFile);
	if (text === undefined) return { config: base, warnings: [], fromFile: false };
	const parsed = parseConfig(text, base);
	return { ...parsed, fromFile: true };
}

/** Create the PoC directory (and defaults) if absent.  Idempotent. */
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

/**
 * Delete the PoC directory.
 *
 * Refuses unless the marker proves the directory belongs to this PoC, so a
 * mistaken path can never remove unrelated files.
 */
function purgePocDir(paths: PocPaths): { ok: true } | { ok: false; reason: string } {
	const marker = readTextIfExists(paths.marker);
	if (marker === undefined) {
		return { ok: false, reason: `no PoC marker at ${paths.marker}` };
	}
	if (!isPocMarker(marker)) {
		return { ok: false, reason: `refusing to delete ${paths.dir}: marker does not match this PoC` };
	}
	rmSync(paths.dir, { recursive: true, force: true });
	return { ok: true };
}

function report(ctx: ExtensionContext, lines: readonly string[], level: "info" | "error"): void {
	const text = lines.join("\n");
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else console.log(text);
}

function statusLines(paths: PocPaths, load: ConfigLoad, keyLine: string): string[] {
	const { config } = load;
	const roots = config.skillRoots.length === 0 ? "(unset)" : config.skillRoots.join(", ");
	return [
		`skill-dispatch: ${config.enabled ? "on" : "off"}`,
		`config: ${load.fromFile ? paths.configFile : `${paths.configFile} (defaults, not created)`}`,
		`key: ${keyLine}`,
		`model: ${config.typesafe.model}  timeout: ${config.typesafe.timeoutMs}ms  threshold: ${config.threshold}`,
		`skillRoots: ${roots}`,
		...(load.warnings.length > 0 ? [`warnings: ${load.warnings.join("; ")}`] : []),
	];
}

export default function skillDispatchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("skill-dispatch", {
		description: "Skill dispatch PoC: status, key probe, toggle, cleanup",
		handler: async (args, ctx) => {
			const paths = pocPaths();
			const subcommand = (args.trim().split(/\s+/)[0] ?? "status").toLowerCase();

			if (subcommand === "status") {
				const load = loadConfig(paths);
				const resolved = await resolveApiKey(load.config.typesafe.apiKeySource, {
					env: process.env,
				});
				const keyLine = resolved.ok
					? `${resolved.resolved.source} → ok sha256:${resolved.resolved.fingerprint}`
					: `${describeKeySource(load.config.typesafe.apiKeySource)} → ${resolved.error}`;
				report(ctx, statusLines(paths, load, keyLine), "info");
				return;
			}

			if (subcommand === "init") {
				const created = ensurePocDir(paths);
				report(
					ctx,
					[
						created ? `created ${paths.dir}` : `${paths.dir} already exists`,
						`key file: ${paths.keyFile}`,
						"Add the key to the key file, then run: /skill-dispatch probe",
					],
					"info",
				);
				return;
			}

			if (subcommand === "on" || subcommand === "off") {
				const load = loadConfig(paths);
				ensurePocDir(paths);
				const next = { ...load.config, enabled: subcommand === "on" };
				writePrivateFile(paths.configFile, serializeConfig(next));
				report(ctx, [`skill-dispatch: ${next.enabled ? "on" : "off"}`, ...load.warnings], "info");
				return;
			}

			if (subcommand === "probe") {
				const load = loadConfig(paths);
				const { config } = load;
				const resolved = await resolveApiKey(config.typesafe.apiKeySource, {
					env: process.env,
				});
				if (!resolved.ok) {
					report(
						ctx,
						[
							`probe failed: cannot resolve the API key`,
							`key: ${resolved.source} → ${resolved.error}`,
							`hint: /skill-dispatch init, then write the key into the key file`,
						],
						"error",
					);
					return;
				}

				const client = createTypeSafeClient({
					apiKey: resolved.resolved.key,
					model: config.typesafe.model,
					timeoutMs: config.typesafe.timeoutMs,
				});
				const outcome = await client.systemOne({
					state: PROBE_STATE,
					questions: {
						greeting: { type: "noul", instructions: PROBE_QUESTION },
					},
				});

				if (!outcome.ok) {
					report(
						ctx,
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
				const noul = answer?.type === "noul" ? answer.noul.toFixed(3) : "(missing)";
				const usage = outcome.response.usage;
				report(
					ctx,
					[
						`probe ok: ${outcome.latencyMs}ms`,
						`model: ${outcome.response.model}`,
						`greeting noul: ${noul}`,
						`tokens: in ${usage?.input_tokens ?? "?"} / out ${usage?.output_tokens ?? "?"}`,
						`key: ${resolved.resolved.source} sha256:${resolved.resolved.fingerprint}`,
					],
					"info",
				);
				return;
			}

			if (subcommand === "purge") {
				if (ctx.hasUI && !(await ctx.ui.confirm("Delete the Skill dispatch PoC?", paths.dir))) {
					ctx.ui.notify("purge cancelled", "info");
					return;
				}
				if (!ctx.hasUI) {
					report(ctx, ["purge needs a confirmation prompt; run it in the TUI"], "error");
					return;
				}
				const result = purgePocDir(paths);
				report(
					ctx,
					result.ok
						? [`deleted ${paths.dir}`, "disable or remove the extension to finish cleanup"]
						: [`purge refused: ${result.reason}`],
					result.ok ? "info" : "error",
				);
				return;
			}

			report(
				ctx,
				[
					"usage: /skill-dispatch status | init | probe | on | off | purge",
					`files: ${paths.dir}`,
				],
				"info",
			);
		},
	});
}
