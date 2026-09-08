/**
 * Cache-hit savings estimation for the Pi footer.
 *
 * A prompt-cache hit bills the cached prefix at the provider's cache-read rate
 * instead of the normal input rate.  The saving is therefore
 *
 *   (inputRate - cacheReadRate) / 1e6 * cacheReadTokens * serviceMultiplier
 *
 * with the same tier rates pi-ai uses when it computes `usage.cost`, and the
 * service-tier multiplier Pi already applied to that cost.
 *
 * The estimate is deliberately conservative: every missing, zero, or
 * contradictory pricing input suppresses the dollar figure instead of
 * producing a misleading `$0.00`.  Token counts are always shown for a real
 * hit.
 */

export const STATUS_KEY = "cache-savings";

export interface CacheSavings {
	/** Tokens billed at the cache-read rate in the latest response. */
	cachedTokens: number;
	/**
	 * Estimated USD saved versus paying the normal input rate.  Omitted when
	 * the pricing inputs are missing, zero, contradictory, or the computed
	 * saving is not positive.
	 */
	savingsUsd?: number;
	/**
	 * The service-tier multiplier inferred from Pi's own cost output (1 when
	 * the cost breakdown is unavailable or cannot expose one).
	 */
	serviceTierMultiplier: number;
}

/** The pi-ai `ModelCost` rates this PoC needs, after tier selection. */
export interface CacheCostRates {
	input: number;
	cacheRead: number;
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Drop float noise so repeated computations and tests see stable values. */
function cleanFloat(value: number, decimals: number): number {
	return Number(value.toFixed(decimals));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the rates that applied to a request, mirroring pi-ai's
 * `calculateCost` tier selection: the tier with the highest
 * `inputTokensAbove` strictly below the request's total input usage
 * (`input + cacheRead + cacheWrite`) replaces every rate for the full
 * request.  Non-finite token counts are treated as 0 so a usable
 * `cacheRead` can still be priced.
 */
export function selectCostRates(cost: unknown, usage: { input?: unknown; cacheWrite?: unknown; cacheRead?: unknown }): CacheCostRates | undefined {
	if (!isRecord(cost)) return undefined;

	const input = toFiniteNumber(cost.input);
	const cacheRead = toFiniteNumber(cost.cacheRead);
	// Garbage or negative rates mean the pricing basis itself is unusable;
	// an absent `cacheRead` rate is as unreliable as a zero one for savings.
	if (input === undefined || input < 0) return undefined;
	if (cacheRead === undefined || cacheRead < 0) return undefined;

	let rates: CacheCostRates = { input, cacheRead };
	let matchedThreshold = -1;
	const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
	const totalInputTokens =
		(toFiniteNumber(usage.input) ?? 0) + (toFiniteNumber(usage.cacheRead) ?? 0) + (toFiniteNumber(usage.cacheWrite) ?? 0);

	for (const tier of tiers) {
		if (!isRecord(tier)) continue;
		const threshold = toFiniteNumber(tier.inputTokensAbove);
		const tierInput = toFiniteNumber(tier.input);
		const tierCacheRead = toFiniteNumber(tier.cacheRead);
		if (threshold === undefined || tierInput === undefined || tierCacheRead === undefined) continue;
		if (totalInputTokens > threshold && threshold > matchedThreshold) {
			rates = { input: tierInput, cacheRead: tierCacheRead };
			matchedThreshold = threshold;
		}
	}

	return rates;
}

/**
 * Compute the savings a cache hit produced on one assistant response.
 *
 * Returns undefined when the response did not report a usable positive
 * `usage.cacheRead`.  The dollar figure is omitted when pricing is missing,
 * zero, or the provider's own cost output contradicts the catalogue rates
 * (provider-specific billing we cannot model).
 */
export function computeCacheSavings(usage: unknown, model: unknown): CacheSavings | undefined {
	if (!isRecord(usage)) return undefined;

	const cachedTokens = toFiniteNumber(usage.cacheRead);
	if (cachedTokens === undefined || cachedTokens <= 0) return undefined;

	const rates = selectCostRates(isRecord(model) ? model.cost : undefined, usage);
	if (!rates) return { cachedTokens, serviceTierMultiplier: 1 };

	const cost = isRecord(usage.cost) ? usage.cost : undefined;
	const costCacheRead = cost === undefined ? undefined : toFiniteNumber(cost.cacheRead);

	// Pi's service-tier multipliers (e.g. flex 0.5x, priority 2x) are already
	// baked into usage.cost.  The catalogue rates are not, so the effective
	// multiplier is recovered by comparing Pi's actual cache-read cost with
	// the catalogue expectation for the same tokens.
	let serviceTierMultiplier = 1;
	if (rates.cacheRead > 0) {
		if (costCacheRead !== undefined) {
			const expected = (rates.cacheRead / 1e6) * cachedTokens;
			const inferred = expected > 0 ? costCacheRead / expected : 0;
			// A non-positive ratio means the provider's billing does not follow
			// the catalogue (custom pricing, promos, stale rates).  Refuse to
			// guess rather than presenting a number with the wrong basis.
			if (!Number.isFinite(inferred) || inferred <= 0) return { cachedTokens, serviceTierMultiplier: 1 };
			serviceTierMultiplier = cleanFloat(inferred, 6);
		}
		// usage.cost absent: fall back to a standard-tier catalogue estimate.
	} else if (costCacheRead !== undefined && costCacheRead > 0) {
		// Catalogue says cache reads are free but the provider charged for
		// them; the actual cache-read rate is unknown, so no honest estimate
		// of the input-rate delta exists.
		return { cachedTokens, serviceTierMultiplier: 1 };
	}
	// When cache reads are free and no charge was reported, the multiplier is
	// invisible in the cost breakdown; a standard-tier estimate is used.

	const savingsUsd = cleanFloat(
		((rates.input - rates.cacheRead) / 1e6) * cachedTokens * serviceTierMultiplier,
		8,
	);
	if (!(savingsUsd > 0)) {
		// No positive saving to claim (e.g. cache reads cost as much as plain
		// input); tokens alone stay honest.
		return { cachedTokens, serviceTierMultiplier };
	}

	return { cachedTokens, savingsUsd, serviceTierMultiplier };
}

/** Compact token count for the footer: `128`, `12.3k`, `1.23M`. */
export function formatCachedTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "0";
	if (tokens < 1000) return `${Math.round(tokens)}`;

	const trim = (text: string) => text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
	if (tokens < 1e6) return `${trim((tokens / 1e3).toFixed(1))}k`;
	return `${trim((tokens / 1e6).toFixed(2))}M`;
}

/**
 * Format an estimated saving without ever showing a rounded `$0.00` for a
 * positive value: sub-cent amounts widen to four decimals (rounded up) so
 * the estimate stays visible and never understates to zero.
 */
export function formatSavingsUsd(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	if (usd >= 0.005) return `$${usd.toFixed(2)}`;
	const roundedUp = Math.ceil(usd * 1e4) / 1e4;
	return `$${roundedUp.toFixed(4)}`;
}

/** Footer text for one cache-hit result, e.g. `SAVED 12.3k tok ~$0.03`. */
export function formatCacheSavingsStatus(savings: CacheSavings): string {
	const tokens = `${formatCachedTokens(savings.cachedTokens)} tok`;
	if (savings.savingsUsd === undefined) return `SAVED ${tokens}`;
	return `SAVED ${tokens} ~${formatSavingsUsd(savings.savingsUsd)}`;
}

export interface CacheSavingsStatusContext {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		theme?: CacheSavingsTheme;
	};
}

/** The small part of Pi's theme API needed by the status renderer. */
export interface CacheSavingsTheme {
	fg(color: "accent" | "dim", text: string): string;
}

/**
 * Style the status like the other cache footer segments: accent label, dim
 * detail.  Split out so the parser and controller stay usable without a TUI
 * theme (tests, RPC clients, other harnesses).
 */
export function formatThemedCacheSavings(text: string, theme?: CacheSavingsTheme): string {
	if (!theme || !text.startsWith("SAVED ")) return text;

	const label = "SAVED";
	return `${theme.fg("accent", label)}${theme.fg("dim", text.slice(label.length))}`;
}

export interface CacheSavingsController {
	sessionStart(ctx: CacheSavingsStatusContext): void;
	messageEnd(message: unknown, ctx: CacheSavingsStatusContext, model?: unknown): void;
	modelSelect(ctx: CacheSavingsStatusContext): void;
	sessionShutdown(ctx: CacheSavingsStatusContext): void;
	getLatest(): CacheSavings | undefined;
}

/**
 * Stateful adapter tracking the latest response's cache hit.
 *
 * The segment only exists while the latest assistant response reported a
 * cache hit: a hit-less response clears it, and so do model switches and
 * session boundaries, because the numbers belong to one specific response.
 */
export function createCacheSavingsController(): CacheSavingsController {
	let latest: CacheSavings | undefined;
	let context: CacheSavingsStatusContext | undefined;
	let lastText: string | undefined;

	const render = (ctx: CacheSavingsStatusContext | undefined = context) => {
		if (!ctx?.hasUI) return;

		const text = latest === undefined ? undefined : formatCacheSavingsStatus(latest);
		const renderedText = text === undefined ? undefined : formatThemedCacheSavings(text, ctx.ui.theme);
		if (renderedText === lastText) return;
		lastText = renderedText;
		ctx.ui.setStatus(STATUS_KEY, renderedText);
	};

	// Clearing goes through render() so an unchanged footer is not touched,
	// while a segment left over from a previous session or model is removed.
	const reset = (ctx: CacheSavingsStatusContext) => {
		latest = undefined;
		context = ctx;
		render(ctx);
	};

	return {
		sessionStart(ctx) {
			reset(ctx);
		},

		messageEnd(message, ctx, model) {
			context = ctx;
			if (
				!isRecord(message) ||
				message.role !== "assistant" ||
				!isRecord(message.usage)
			) {
				return;
			}

			latest = computeCacheSavings(message.usage, model);
			render(ctx);
		},

		modelSelect(ctx) {
			reset(ctx);
		},

		sessionShutdown(ctx) {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			latest = undefined;
			context = undefined;
			lastText = undefined;
		},

		getLatest() {
			return latest;
		},
	};
}
