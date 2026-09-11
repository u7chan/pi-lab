/**
 * Prompt-cache TTL parsing and footer-clock primitives.
 *
 * Provider adapters do not expose one common cache-payload shape.  Keep the
 * parser deliberately conservative: a value that is present but cannot be
 * understood is reported as unknown instead of being replaced with a guess.
 */

export const STATUS_KEY = "cache-ttl";
export const SHORT_CACHE_TTL_MS = 5 * 60 * 1000;

export type CacheEmptyStatus = "pending" | "automatic" | "unsupported" | "unknown";

const AUTOMATIC_CACHE_PROVIDERS = new Set(["deepseek", "zai", "zai-coding-cn"]);
const AUTOMATIC_CACHE_MODEL_PREFIXES = ["deepseek"];

/** Providers whose cache is implicit and has no request TTL to count down. */
export function isAutomaticCacheProvider(provider: unknown): boolean {
	return typeof provider === "string" && AUTOMATIC_CACHE_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Model families whose cache is implicit.  Gateway providers such as
 * opencode-go serve them under their own provider id, so the provider name
 * alone would report a working cache as "unsupported".  Vendor-prefixed ids
 * ("deepseek/deepseek-chat") are matched on their last segment.
 */
export function isAutomaticCacheModel(model: unknown): boolean {
	if (typeof model !== "string") return false;

	const normalized = model.trim().toLowerCase();
	if (normalized.length === 0) return false;

	const family = normalized.slice(normalized.lastIndexOf("/") + 1);
	return AUTOMATIC_CACHE_MODEL_PREFIXES.some((prefix) => family.startsWith(prefix));
}

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

export type CacheTtlState =
	| { kind: CacheEmptyStatus }
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

/** Format an absolute expiry or an explanatory non-countdown status. */
export function formatCacheStatus(
	expiresAt: number | undefined,
	now: number,
	emptyStatus: CacheEmptyStatus = "unknown",
): string {
	if (expiresAt === undefined) {
		if (emptyStatus === "pending") return "CACHE pending";
		if (emptyStatus === "automatic") return "CACHE auto";
		if (emptyStatus === "unsupported") return "CACHE unsupported";
		return "CACHE unknown";
	}

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
		theme?: CacheStatusTheme;
	};
}

/** The small part of Pi's theme API needed by the status renderer. */
export interface CacheStatusTheme {
	fg(color: "accent" | "dim", text: string): string;
}

/**
 * Style a cache status like the Codex adapter's status segment: the label is
 * accent-coloured and its changing/detail text is dimmed.  Keeping this as a
 * separate adapter also leaves the parser and controller usable without a
 * TUI theme in tests, RPC clients, and other harnesses.
 */
export function formatThemedCacheStatus(text: string, theme?: CacheStatusTheme): string {
	if (!theme || !text.startsWith("CACHE ")) return text;

	const label = "CACHE";
	return `${theme.fg("accent", label)}${theme.fg("dim", text.slice(label.length))}`;
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
	beforeProviderRequest(payload: unknown, ctx: CacheStatusContext, provider?: string): void;
	messageEnd(message: unknown, ctx: CacheStatusContext, provider?: string): void;
	modelSelect(ctx: CacheStatusContext, provider?: string): void;
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
	let emptyStatus: CacheEmptyStatus = "unknown";
	let cacheHit = false;

	const clearTimer = () => {
		timer?.cancel();
		timer = undefined;
	};

	const render = (ctx: CacheStatusContext | undefined = currentContext) => {
		if (!ctx?.hasUI) return;

		const text =
			cacheHit && expiresAt === undefined ? "CACHE hit" : formatCacheStatus(expiresAt, now(), emptyStatus);
		const renderedText = formatThemedCacheStatus(text, ctx.ui.theme);
		if (renderedText === lastText) return;
		lastText = renderedText;
		ctx.ui.setStatus(STATUS_KEY, renderedText);
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

	const reset = (
		ctx: CacheStatusContext,
		nextEmptyStatus: CacheEmptyStatus,
		forceRender = false,
		nextCacheHit = false,
	) => {
		generation++;
		clearTimer();
		expiresAt = undefined;
		ttlMs = undefined;
		lastCacheRelevantRequestAt = undefined;
		emptyStatus = nextEmptyStatus;
		cacheHit = nextCacheHit;
		currentContext = ctx;
		if (forceRender) lastText = undefined;
		render(ctx);
	};

	return {
		sessionStart(ctx) {
			reset(ctx, "pending", true);
		},

		beforeProviderRequest(payload, ctx, provider) {
			currentContext = ctx;
			const inferredTtlMs = inspectPromptCacheTtl(payload);
			if (inferredTtlMs === undefined) {
				// Do not retain a countdown from an earlier request when the new
				// payload does not expose any cache metadata.  This is distinct from
				// an initial session, where no provider request has happened yet.
				// Gateway providers hide the real model family behind their own
				// provider id, so the outgoing payload's model id is checked too.
				const payloadModel =
					isRecord(payload) && typeof payload.model === "string" ? payload.model : undefined;
				reset(
					ctx,
					isAutomaticCacheProvider(provider) || isAutomaticCacheModel(payloadModel)
						? "automatic"
						: "unsupported",
				);
				return;
			}
			if (inferredTtlMs === null) {
				// Cache metadata exists, but the provider's effective TTL is not
				// portable or the cache is explicitly disabled.
				reset(ctx, "unknown");
				return;
			}

			generation++;
			clearTimer();
			ttlMs = inferredTtlMs;
			cacheHit = false;
			lastCacheRelevantRequestAt = now();
			expiresAt = lastCacheRelevantRequestAt + inferredTtlMs;
			currentContext = ctx;
			render(ctx);
			schedule(ctx);
		},

		messageEnd(message, ctx, provider) {
			if (!isRecord(message) || message.role !== "assistant") return;

			const messageProvider = typeof message.provider === "string" ? message.provider : provider;
			const messageModel = typeof message.model === "string" ? message.model : undefined;
			const usage = isRecord(message.usage) ? message.usage : undefined;
			const cacheRead = usage?.cacheRead;
			if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead) || cacheRead < 0) return;

			// A real TTL/countdown is more useful than a retrospective hit marker.
			if (expiresAt !== undefined) return;

			if (cacheRead > 0) {
				reset(ctx, "automatic", false, true);
				return;
			}

			// The first automatic-cache response commonly reports zero hits while
			// it warms the provider-side cache. Keep that distinct from a provider
			// that emitted no cache evidence and is not known to support caching.
			if (isAutomaticCacheProvider(messageProvider) || isAutomaticCacheModel(messageModel)) {
				reset(ctx, "automatic");
			}
		},

		modelSelect(ctx, _provider) {
			reset(ctx, "pending");
		},

		sessionShutdown(ctx) {
			generation++;
			clearTimer();
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			expiresAt = undefined;
			ttlMs = undefined;
			lastCacheRelevantRequestAt = undefined;
			emptyStatus = "unknown";
			cacheHit = false;
			currentContext = undefined;
			lastText = undefined;
		},

		getState() {
			if (expiresAt === undefined || ttlMs === undefined || lastCacheRelevantRequestAt === undefined) {
				return { kind: emptyStatus };
			}
			if (expiresAt <= now()) return { kind: "expired" };
			return { kind: "active", ttlMs, expiresAt };
		},
	};
}
