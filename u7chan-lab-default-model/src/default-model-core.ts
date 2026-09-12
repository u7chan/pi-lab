/**
 * Default-model selection and settings persistence primitives.
 *
 * Pi has no runtime API for rewriting the startup defaults, so this module
 * owns the settings.json read-modify-write and the model matching rules.
 * It deliberately avoids Pi runtime imports (only structural `ModelLike`
 * shapes) so the rules can be unit-tested without a Pi process; the extension
 * adapter bridges them to commands, tools, and the model registry.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** Score from which a query is treated as an unambiguous model reference. */
export const DIRECT_MATCH_SCORE = 900;

export const SETTINGS_FILE_NAME = "settings.json";

/**
 * The subset of `Model` this module needs.  A real `Model<Api>` from
 * `@earendil-works/pi-ai` is structurally assignable to it.
 */
export interface ModelLike {
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	thinkingLevelMap?: Partial<Record<Level, string | null>>;
}

export interface Defaults {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: Level;
}

export function isLevel(value: string): value is Level {
	return (LEVELS as readonly string[]).includes(value);
}

export function modelKey(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Thinking levels the model accepts.  `null` in `thinkingLevelMap` marks a
 * level as unsupported; missing keys fall back to the provider default, so
 * they stay selectable.
 */
export function supportedLevels(model: ModelLike): Level[] {
	if (!model.reasoning) return ["off"];

	const map = model.thinkingLevelMap;
	if (!map) return [...LEVELS];
	return LEVELS.filter((level) => map[level] !== null);
}

/** One-line description for pickers, e.g. "DeepSeek V4.1 Flash · 1000K ctx · reasoning". */
export function describeModel(model: ModelLike): string {
	const parts = [model.name];
	if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
		parts.push(`${Math.round(model.contextWindow / 1000)}K ctx`);
	}
	if (model.reasoning) parts.push("reasoning");
	return parts.join(" · ");
}

/**
 * Relevance of a model for a query.
 *
 * Exact `provider/id` > exact id > `id` suffix > id substring > key substring
 * > name substring > squashed name/key > subsequence.
 */
export function scoreModel(model: ModelLike, query: string): number {
	const full = modelKey(model).toLowerCase();
	const id = model.id.toLowerCase();
	const name = model.name.toLowerCase();
	const q = query.toLowerCase();

	if (full === q) return 1000;
	if (id === q) return 900;
	if (full.endsWith(`/${q}`)) return 800;
	if (id.includes(q)) return 600;
	if (full.includes(q)) return 500;
	if (name.includes(q)) return 400;

	const squash = (value: string) => value.replace(/[\s._\-/]+/g, "");
	const squashed = squash(q);
	if (squashed.length >= 2 && squash(name).includes(squashed)) return 350;
	if (squashed.length >= 2 && squash(full).includes(squashed)) return 300;

	// Subsequence match, e.g. "dv41f" -> "opencode-go/deepseek-v4.1-flash".
	let cursor = 0;
	for (const char of full) {
		if (char === q[cursor]) cursor += 1;
		if (cursor === q.length) return 100;
	}
	return 0;
}

/** Matching models, best first.  Ties are broken by `provider/id`. */
export function rankModels<T extends ModelLike>(models: T[], query: string): T[] {
	return models
		.map((model) => ({ model, score: scoreModel(model, query) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || modelKey(a.model).localeCompare(modelKey(b.model)))
		.map((entry) => entry.model);
}

export interface ModelMatch<T extends ModelLike> {
	/** Set when the query is already unambiguous. */
	direct?: T;
	/** Ranked candidates; more than one means the user should pick. */
	candidates: T[];
}

export function matchModels<T extends ModelLike>(models: T[], query: string): ModelMatch<T> {
	const candidates = rankModels(models, query);
	if (candidates.length === 0) return { candidates };
	if (candidates.length === 1 || scoreModel(candidates[0], query) >= DIRECT_MATCH_SCORE) {
		return { direct: candidates[0], candidates };
	}
	return { candidates };
}

/**
 * Split an optional trailing thinking level from a model reference.
 * The suffix is only removed when it names a known level, so ids that contain
 * a colon survive untouched.
 */
export function parseTarget(raw: string): { query: string; level?: Level } {
	const match = /^(.*):([a-z]+)$/.exec(raw.trim());
	if (match?.[1] && match[2] && isLevel(match[2])) {
		return { query: match[1], level: match[2] };
	}
	return { query: raw.trim() };
}

export function settingsPath(agentDir: string): string {
	return join(agentDir, SETTINGS_FILE_NAME);
}

/** Missing or unreadable settings are treated as empty so callers can merge. */
export function readSettingsFile(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge the startup model defaults into settings.json without touching any
 * other key (packages, theme, ...).  Writes to a sibling temp file and
 * renames, so a crash cannot leave a truncated settings file behind.
 */
export function writeDefaultModel(path: string, model: ModelLike, level?: Level): void {
	const patch: Defaults = {
		defaultProvider: model.provider,
		defaultModel: model.id,
		...(level ? { defaultThinkingLevel: level } : {}),
	};
	const next = { ...readSettingsFile(path), ...patch };
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	renameSync(tempPath, path);
}

export function readDefaults(settings: Record<string, unknown>): Defaults {
	const provider = settings.defaultProvider;
	const model = settings.defaultModel;
	const level = settings.defaultThinkingLevel;
	return {
		defaultProvider: typeof provider === "string" ? provider : undefined,
		defaultModel: typeof model === "string" ? model : undefined,
		defaultThinkingLevel: typeof level === "string" && isLevel(level) ? level : undefined,
	};
}

export function describeDefaults(settings: Record<string, unknown>): string {
	const { defaultProvider, defaultModel, defaultThinkingLevel } = readDefaults(settings);
	return `${defaultProvider ?? "(unset)"} / ${defaultModel ?? "(unset)"} (thinking: ${defaultThinkingLevel ?? "(unset)"})`;
}

/**
 * Warn when the saved startup thinking level does not exist on the newly
 * selected model.  Without this the mismatch only shows up on the next start.
 */
export function thinkingLevelWarning(model: ModelLike, settings: Record<string, unknown>): string | undefined {
	const level = readDefaults(settings).defaultThinkingLevel;
	if (!level || !model.reasoning) return undefined;

	const supported = supportedLevels(model);
	if (supported.includes(level)) return undefined;
	return `defaultThinkingLevel=${level} is not supported by ${modelKey(model)} (supported: ${supported.join(", ")})`;
}
