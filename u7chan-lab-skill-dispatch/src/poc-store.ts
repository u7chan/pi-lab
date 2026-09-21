/**
 * PoC configuration and owned-directory rules for the Skill dispatcher.
 *
 * The experiment keeps every file it owns under one marker-guarded directory
 * (`~/.pi/agent/skill-dispatch-poc/` by default) so removing the PoC is a
 * single `rm -rf` that cannot touch existing user files.  Nothing in the
 * config file is secret: the key is referenced through `typesafe.apiKeySource`
 * and resolved on demand.
 *
 * Parsing is deliberately forgiving about *unknown* fields (they are ignored
 * with a warning) and strict about *invalid* ones (the default is kept).  A
 * typo must never silently disable a safety rule such as the skill root list.
 */

import { POC_MARKER, parseKeySourceSpec, type PocPaths } from "./key-source.ts";
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from "./typesafe-client.ts";

/** Confidence at or above which a dispatch rewrites the input. */
export const DEFAULT_THRESHOLD = 0.7;

/** Minimum mean of the two action gates; below this, nothing is dispatched. */
export const DEFAULT_NOUL_THRESHOLD = 0.5;

/**
 * Maximum `P(other)` accepted when the abstain gate is probability based.
 * Chosen from the first measurement run: positives scored 0.00 and negatives
 * 0.31 or higher, so this sits well inside the gap.
 */
export const DEFAULT_OTHER_THRESHOLD = 0.15;

/** Abstain signal used by default.  See `DispatchThresholds.gate`. */
export const DEFAULT_GATE = "other" as const;

export interface TypeSafeSettings {
	/** `file:`, `env:`, or `command:` reference.  Literal keys are not supported. */
	readonly apiKeySource: string;
	readonly model: string;
	readonly timeoutMs: number;
}

export interface SkillDispatchConfig {
	/** Dispatches only run while this is true; the default is off. */
	readonly enabled: boolean;
	/** Roots scanned for SKILL.md folders; also published to Pi as skill paths. */
	readonly skillRoots: readonly string[];
	/**
	 * Working directories where dispatching is allowed, as path prefixes.
	 * An empty list allows nothing: a prompt is never sent from a project that
	 * was not named here.
	 */
	readonly projectAllowlist: readonly string[];
	/** Minimum `choice.confidence` for the selected skill. */
	readonly threshold: number;
	/** Minimum mean of the two action gates.  Used when `gate` is "noul". */
	readonly noulThreshold: number;
	/** Abstain signal: `other` probability (default) or the action gates. */
	readonly gate: "other" | "noul";
	/** Maximum `P(other)` accepted when `gate` is "other". */
	readonly otherThreshold: number;
	/** Dispatches allowed per session; 0 means unlimited. */
	readonly maxDispatchesPerSession: number;
	/** When true, decision logs include the prompt text.  Off by default. */
	readonly logPrompts: boolean;
	readonly typesafe: TypeSafeSettings;
}

export interface ConfigLoadResult {
	readonly config: SkillDispatchConfig;
	readonly warnings: readonly string[];
}

/** Marker file contents.  `purge` only deletes a directory whose marker matches. */
export const POC_MARKER_TEXT = `${JSON.stringify(POC_MARKER, null, 2)}\n`;

/** Comment-only key file written by `init`; the key is added by hand. */
export const KEY_FILE_TEMPLATE = [
	"# TypeSafe API key for the Skill dispatch PoC.",
	"# Replace the empty value below, then run: chmod 600 key.env",
	"",
	"TYPESAFE_API_KEY=",
	"",
].join("\n");

export function defaultConfig(paths: PocPaths): SkillDispatchConfig {
	return {
		enabled: false,
		skillRoots: [],
		projectAllowlist: [],
		threshold: DEFAULT_THRESHOLD,
		noulThreshold: DEFAULT_NOUL_THRESHOLD,
		gate: DEFAULT_GATE,
		otherThreshold: DEFAULT_OTHER_THRESHOLD,
		maxDispatchesPerSession: 0,
		logPrompts: false,
		typesafe: {
			apiKeySource: `file:${paths.keyFile}`,
			model: DEFAULT_MODEL,
			timeoutMs: DEFAULT_TIMEOUT_MS,
		},
	};
}

export function isPocMarker(text: string): boolean {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return false;
		const record = parsed as Record<string, unknown>;
		return record.name === POC_MARKER.name && record.version === POC_MARKER.version;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Field names that would put the secret itself into a config file. */
const FORBIDDEN_SECRET_FIELDS = ["apiKey", "key", "token", "secret", "password"];

function findSecretField(value: Record<string, unknown>, path: string): string | undefined {
	for (const [name, entry] of Object.entries(value)) {
		if (FORBIDDEN_SECRET_FIELDS.includes(name)) return `${path}${name}`;
		if (isRecord(entry)) {
			const nested = findSecretField(entry, `${path}${name}.`);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

/**
 * Parse `config.json` on top of the defaults.
 *
 * Every accepted field is validated against the base value's type.  Invalid
 * values keep the default and add a warning, so a broken field can never turn
 * an unset key source into an authenticated one or lower the threshold to
 * zero unnoticed.
 */
export function parseConfig(text: string, base: SkillDispatchConfig): ConfigLoadResult {
	const warnings: string[] = [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { config: base, warnings: ["config.json is not valid JSON; using defaults"] };
	}

	if (!isRecord(parsed)) {
		return { config: base, warnings: ["config.json must be a JSON object; using defaults"] };
	}

	const secretField = findSecretField(parsed, "");
	if (secretField !== undefined) {
		warnings.push(
			`config.json sets "${secretField}"; literals are not supported, use typesafe.apiKeySource`,
		);
	}

	let enabled = base.enabled;
	if (parsed.enabled !== undefined) {
		if (typeof parsed.enabled === "boolean") enabled = parsed.enabled;
		else warnings.push('"enabled" must be true or false; keeping the default');
	}

	let skillRoots = base.skillRoots;
	if (parsed.skillRoots !== undefined) {
		if (
			Array.isArray(parsed.skillRoots) &&
			parsed.skillRoots.every((root) => typeof root === "string" && root.trim().length > 0)
		) {
			skillRoots = parsed.skillRoots.map((root: string) => root.trim());
		} else {
			warnings.push('"skillRoots" must be a list of non-empty paths; keeping the default');
		}
	}

	let threshold = base.threshold;
	if (parsed.threshold !== undefined) {
		if (typeof parsed.threshold === "number" && parsed.threshold >= 0 && parsed.threshold <= 1) {
			threshold = parsed.threshold;
		} else {
			warnings.push('"threshold" must be between 0 and 1; keeping the default');
		}
	}

	let noulThreshold = base.noulThreshold;
	if (parsed.noulThreshold !== undefined) {
		if (typeof parsed.noulThreshold === "number" && parsed.noulThreshold >= 0 && parsed.noulThreshold <= 1) {
			noulThreshold = parsed.noulThreshold;
		} else {
			warnings.push('"noulThreshold" must be between 0 and 1; keeping the default');
		}
	}

	let otherThreshold = base.otherThreshold;
	if (parsed.otherThreshold !== undefined) {
		if (typeof parsed.otherThreshold === "number" && parsed.otherThreshold >= 0 && parsed.otherThreshold <= 1) {
			otherThreshold = parsed.otherThreshold;
		} else {
			warnings.push('"otherThreshold" must be between 0 and 1; keeping the default');
		}
	}

	let gate = base.gate;
	if (parsed.gate !== undefined) {
		if (parsed.gate === "other" || parsed.gate === "noul") gate = parsed.gate;
		else warnings.push('"gate" must be "other" or "noul"; keeping the default');
	}

	let projectAllowlist = base.projectAllowlist;
	if (parsed.projectAllowlist !== undefined) {
		if (
			Array.isArray(parsed.projectAllowlist) &&
			parsed.projectAllowlist.every((root) => typeof root === "string" && root.trim().length > 0)
		) {
			projectAllowlist = parsed.projectAllowlist.map((root: string) => root.trim());
		} else {
			warnings.push('"projectAllowlist" must be a list of non-empty paths; keeping the default');
		}
	}

	let maxDispatchesPerSession = base.maxDispatchesPerSession;
	if (parsed.maxDispatchesPerSession !== undefined) {
		if (
			typeof parsed.maxDispatchesPerSession === "number" &&
			Number.isInteger(parsed.maxDispatchesPerSession) &&
			parsed.maxDispatchesPerSession >= 0
		) {
			maxDispatchesPerSession = parsed.maxDispatchesPerSession;
		} else {
			warnings.push('"maxDispatchesPerSession" must be a non-negative integer; keeping the default');
		}
	}

	let logPrompts = base.logPrompts;
	if (parsed.logPrompts !== undefined) {
		if (typeof parsed.logPrompts === "boolean") logPrompts = parsed.logPrompts;
		else warnings.push('"logPrompts" must be true or false; keeping the default');
	}

	let typesafe = base.typesafe;
	if (parsed.typesafe !== undefined) {
		if (!isRecord(parsed.typesafe)) {
			warnings.push('"typesafe" must be an object; keeping the default');
		} else {
			const typesafeRecord = parsed.typesafe;
			let apiKeySource = typesafe.apiKeySource;
			let model = typesafe.model;
			let timeoutMs = typesafe.timeoutMs;

			if (typesafeRecord.apiKeySource !== undefined) {
				if (
					typeof typesafeRecord.apiKeySource === "string" &&
					parseKeySourceSpec(typesafeRecord.apiKeySource) !== undefined
				) {
					apiKeySource = typesafeRecord.apiKeySource.trim();
				} else {
					warnings.push(
						'"typesafe.apiKeySource" must use file:, env:, or command:; keeping the default',
					);
				}
			}

			if (typesafeRecord.model !== undefined) {
				if (typeof typesafeRecord.model === "string" && typesafeRecord.model.trim().length > 0) {
					model = typesafeRecord.model.trim();
				} else {
					warnings.push('"typesafe.model" must be a non-empty string; keeping the default');
				}
			}

			if (typesafeRecord.timeoutMs !== undefined) {
				if (
					typeof typesafeRecord.timeoutMs === "number" &&
					Number.isInteger(typesafeRecord.timeoutMs) &&
					typesafeRecord.timeoutMs > 0
				) {
					timeoutMs = typesafeRecord.timeoutMs;
				} else {
					warnings.push('"typesafe.timeoutMs" must be a positive integer; keeping the default');
				}
			}

			typesafe = { apiKeySource, model, timeoutMs };
		}
	}

	return {
		config: {
			enabled,
			skillRoots,
			projectAllowlist,
			threshold,
			noulThreshold,
			gate,
			otherThreshold,
			maxDispatchesPerSession,
			logPrompts,
			typesafe,
		},
		warnings,
	};
}

export function serializeConfig(config: SkillDispatchConfig): string {
	return `${JSON.stringify(
		{
			enabled: config.enabled,
			skillRoots: [...config.skillRoots],
			projectAllowlist: [...config.projectAllowlist],
			threshold: config.threshold,
			noulThreshold: config.noulThreshold,
			gate: config.gate,
			otherThreshold: config.otherThreshold,
			maxDispatchesPerSession: config.maxDispatchesPerSession,
			logPrompts: config.logPrompts,
			typesafe: { ...config.typesafe },
		},
		null,
		2,
	)}\n`;
}
