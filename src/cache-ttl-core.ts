/**
 * Prompt-cache TTL parsing and footer-clock primitives.
 *
 * Provider adapters do not expose one common cache-payload shape.  Keep the
 * parser deliberately conservative: a value that is present but cannot be
 * understood is reported as unknown instead of being replaced with a guess.
 */

export const STATUS_KEY = "cache-ttl";
export const SHORT_CACHE_TTL_MS = 5 * 60 * 1000;

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

export type CacheTtlState =
	| { kind: "unknown" }
	| { kind: "active"; ttlMs: number; expiresAt: number }
	| { kind: "expired" };

interface CacheDirectiveScan {
	ttls: number[];
	hasUnknownTtl: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the duration strings used by provider cache fields. */
function parseCacheTtl(value: unknown): number | null {
	if (typeof value !== "string") return null;

	const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
	if (!match) return null;

	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;

	const unitMs =
		match[2] === "ms"
			? 1
			: match[2] === "s"
				? MILLISECONDS_PER_SECOND
				: match[2] === "m"
					? MILLISECONDS_PER_MINUTE
					: match[2] === "h"
						? MILLISECONDS_PER_HOUR
						: MILLISECONDS_PER_DAY;
	const ttlMs = amount * unitMs;

	return Number.isSafeInteger(Math.round(ttlMs)) && ttlMs > 0 ? ttlMs : null;
}

function addTtl(value: unknown, scan: CacheDirectiveScan): void {
	const ttl = parseCacheTtl(value);
	if (ttl === null) {
		scan.hasUnknownTtl = true;
	} else {
		scan.ttls.push(ttl);
	}
}

function isDirectiveType(value: unknown, expected: string): boolean {
	return typeof value === "string" && value.toLowerCase() === expected;
}

/**
 * Collect Anthropic-style and Bedrock-style cache directives at any nesting
 * level.  Payloads are normally JSON-shaped, but the cycle guard keeps a
 * debugging/custom-provider payload from taking down the extension.
 */
function collectCacheDirectives(
	value: unknown,
	scan: CacheDirectiveScan,
	seen: WeakSet<object>,
): void {
	if (Array.isArray(value)) {
		if (seen.has(value)) return;
		seen.add(value);
		for (const item of value) collectCacheDirectives(item, scan, seen);
		return;
	}
	if (!isRecord(value) || seen.has(value)) return;
	seen.add(value);

	for (const [key, child] of Object.entries(value)) {
		if (isRecord(child)) {
			const hasTtl = child.ttl !== undefined;
			const isCacheControl =
				(key === "cache_control" || key === "cacheControl") &&
				(isDirectiveType(child.type, "ephemeral") || hasTtl);
			const isCachePoint =
				key === "cachePoint" &&
				(isDirectiveType(child.type, "default") || hasTtl);

			if (isCacheControl || isCachePoint) {
				// An omitted TTL is the provider's short/default cache window.
				if (!hasTtl) scan.ttls.push(SHORT_CACHE_TTL_MS);
				else addTtl(child.ttl, scan);
			}
		}

		collectCacheDirectives(child, scan, seen);
	}
}

function addRetention(value: unknown, scan: CacheDirectiveScan): "short" | "unknown" | undefined {
	if (value === undefined) return undefined;

	if (value === "short") return "short";
	if (value === "long" || value === "none") return "unknown";

	// Some gateways use the retention field for a duration directly.
	addTtl(value, scan);
	return undefined;
}

/**
 * Inspect prompt-cache metadata serialized into a provider payload.
 *
 * Return values intentionally have three meanings:
 * - a positive number: a usable inferred TTL
 * - null: cache metadata was present, but its TTL is unknown/disabled
 * - undefined: no cache metadata was present
 */
export function inspectPromptCacheTtl(payload: unknown): number | null | undefined {
	if (!isRecord(payload)) return undefined;

	const scan: CacheDirectiveScan = { hasUnknownTtl: false, ttls: [] };
	collectCacheDirectives(payload, scan, new WeakSet<object>());

	if (payload.prompt_cache_retention !== undefined) {
		const retention = payload.prompt_cache_retention;
		// This is the provider wire field, not Pi's internal
		// CacheRetention enum.  A missing field means provider default and is
		// handled only when another cache signal (key/directive) is present;
		// an explicit "short"/"in_memory" value still has no portable exact
		// expiry here, so it remains unknown rather than becoming a guess.
		if (retention === "long" || retention === "none") scan.hasUnknownTtl = true;
		else addTtl(retention, scan);
	}

	const promptCacheOptions = isRecord(payload.prompt_cache_options)
		? payload.prompt_cache_options
		: undefined;
	if (promptCacheOptions) {
		if (promptCacheOptions.ttl !== undefined) {
			addTtl(promptCacheOptions.ttl, scan);
		} else if (promptCacheOptions.mode !== undefined) {
			// Pi uses { mode: "explicit" } when automatic prompt caching is
			// disabled.  It is still important to clear an older countdown.
			scan.hasUnknownTtl = true;
		}
	}

	// A malformed/unknown explicit TTL must never be hidden by a known one:
	// we cannot know which value is the actual shortest window.
	if (scan.hasUnknownTtl) return null;
	if (scan.ttls.length > 0) return Math.min(...scan.ttls);

	const options = isRecord(payload.options) ? payload.options : undefined;
	const retentions = [options?.cacheRetention, payload.cacheRetention];
	let fallback: "short" | "unknown" | undefined;
	for (const retention of retentions) {
		const result = addRetention(retention, scan);
		if (result === "unknown") fallback = "unknown";
		else if (result === "short" && fallback === undefined) fallback = "short";
	}
	if (scan.hasUnknownTtl || fallback === "unknown") return null;
	if (scan.ttls.length > 0) return Math.min(...scan.ttls);

	const hasPromptCacheKey =
		typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0;
	if (fallback === "short" || hasPromptCacheKey) return SHORT_CACHE_TTL_MS;

	return undefined;
}

/** Format an absolute expiry for the footer. */
export function formatCacheStatus(expiresAt: number | undefined, now: number): string {
	if (expiresAt === undefined) return "CACHE unknown";

	const remainingMs = expiresAt - now;
	if (remainingMs <= 0) return "CACHE expired";

	const totalSeconds = Math.ceil(remainingMs / MILLISECONDS_PER_SECOND);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `CACHE ${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Return the delay until the next visible second changes.  Recomputing from
 * the wall clock on every callback prevents drift after event-loop delays or
 * suspend/resume, while avoiding a permanently-running interval.
 */
export function nextCacheUpdateDelayMs(expiresAt: number | undefined, now: number): number | undefined {
	if (expiresAt === undefined) return undefined;

	const remainingMs = expiresAt - now;
	if (remainingMs <= 0) return undefined;

	const displayedSeconds = Math.ceil(remainingMs / MILLISECONDS_PER_SECOND);
	const nextChangeInMs = remainingMs - (displayedSeconds - 1) * MILLISECONDS_PER_SECOND;
	return Math.max(1, nextChangeInMs);
}

export interface CacheStatusContext {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
	};
}

export interface CacheTtlTimer {
	cancel(): void;
	unref?(): void;
}

export interface CacheTtlScheduler {
	setTimeout(callback: () => void, delayMs: number): CacheTtlTimer;
}

const defaultScheduler: CacheTtlScheduler = {
	setTimeout(callback, delayMs) {
		const nativeTimer = globalThis.setTimeout(callback, delayMs);
		return {
			cancel: () => globalThis.clearTimeout(nativeTimer),
			unref: () => {
				(nativeTimer as unknown as { unref?: () => void }).unref?.();
			},
		};
	},
};

export interface CacheTtlController {
	sessionStart(ctx: CacheStatusContext): void;
	beforeProviderRequest(payload: unknown, ctx: CacheStatusContext): void;
	modelSelect(ctx: CacheStatusContext): void;
	sessionShutdown(ctx: CacheStatusContext): void;
	getState(): CacheTtlState;
}

export interface CacheTtlControllerOptions {
	now?: () => number;
	scheduler?: CacheTtlScheduler;
}

/** Create the stateful clock used by the Pi event adapter and the harness. */
export function createCacheTtlController(options: CacheTtlControllerOptions = {}): CacheTtlController {
	const now = options.now ?? (() => Date.now());
	const scheduler = options.scheduler ?? defaultScheduler;

	let expiresAt: number | undefined;
	let ttlMs: number | undefined;
	let lastCacheRelevantRequestAt: number | undefined;
	let timer: CacheTtlTimer | undefined;
	let generation = 0;
	let currentContext: CacheStatusContext | undefined;
	let lastText: string | undefined;

	const clearTimer = () => {
		timer?.cancel();
		timer = undefined;
	};

	const render = (ctx: CacheStatusContext | undefined = currentContext) => {
		if (!ctx?.hasUI) return;

		const text = formatCacheStatus(expiresAt, now());
		if (text === lastText) return;
		lastText = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const schedule = (ctx: CacheStatusContext) => {
		clearTimer();
		if (!ctx.hasUI || expiresAt === undefined) return;

		const expiration = expiresAt;
		const delayMs = nextCacheUpdateDelayMs(expiration, now());
		if (delayMs === undefined) return;

		const scheduledGeneration = generation;
		let scheduledTimer: CacheTtlTimer;
		scheduledTimer = scheduler.setTimeout(() => {
			// clearTimeout cannot prevent a callback that is already queued.  The
			// generation and handle checks make model/session changes safe too.
			if (
				timer !== scheduledTimer ||
				generation !== scheduledGeneration ||
				expiresAt !== expiration
			) {
				return;
			}

			timer = undefined;
			const activeContext = currentContext ?? ctx;
			render(activeContext);
			if (generation === scheduledGeneration && expiresAt === expiration) {
				schedule(activeContext);
			}
		}, delayMs);
		timer = scheduledTimer;
		scheduledTimer.unref?.();
	};

	const resetToUnknown = (ctx: CacheStatusContext, forceRender = false) => {
		generation++;
		clearTimer();
		expiresAt = undefined;
		ttlMs = undefined;
		lastCacheRelevantRequestAt = undefined;
		currentContext = ctx;
		if (forceRender) lastText = undefined;
		render(ctx);
	};

	return {
		sessionStart(ctx) {
			resetToUnknown(ctx, true);
		},

		beforeProviderRequest(payload, ctx) {
			currentContext = ctx;
			const inferredTtlMs = inspectPromptCacheTtl(payload);
			if (inferredTtlMs === undefined || inferredTtlMs === null) {
				// Do not retain a countdown from an earlier request when the new
				// payload does not prove that the cache window is still applicable.
				resetToUnknown(ctx);
				return;
			}

			generation++;
			clearTimer();
			ttlMs = inferredTtlMs;
			lastCacheRelevantRequestAt = now();
			expiresAt = lastCacheRelevantRequestAt + inferredTtlMs;
			currentContext = ctx;
			render(ctx);
			schedule(ctx);
		},

		modelSelect(ctx) {
			resetToUnknown(ctx);
		},

		sessionShutdown(ctx) {
			generation++;
			clearTimer();
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			expiresAt = undefined;
			ttlMs = undefined;
			lastCacheRelevantRequestAt = undefined;
			currentContext = undefined;
			lastText = undefined;
		},

		getState() {
			if (expiresAt === undefined || ttlMs === undefined || lastCacheRelevantRequestAt === undefined) {
				return { kind: "unknown" };
			}
			if (expiresAt <= now()) return { kind: "expired" };
			return { kind: "active", ttlMs, expiresAt };
		},
	};
}
