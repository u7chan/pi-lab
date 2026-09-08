import { describe, expect, test } from "bun:test";
import cacheSavingsExtension, {
	createCacheSavingsController,
	computeCacheSavings,
	formatCacheSavingsStatus,
	formatCachedTokens,
	formatSavingsUsd,
	formatThemedCacheSavings,
	selectCostRates,
	STATUS_KEY,
} from "../.pi/extensions/cache-savings.ts";

/** Real catalogue rates: DeepSeek charges 0.14/M input and 0.0028/M cache reads. */
const DEEPSEEK_COST = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 };
/** Real catalogue rates with request-wide tiers like OpenAI's gpt-5.5. */
const GPT55_COST = {
	input: 5,
	output: 30,
	cacheRead: 0.5,
	cacheWrite: 0,
	tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }],
};

describe("selectCostRates", () => {
	test("returns the base rates when no tiers apply", () => {
		expect(selectCostRates(DEEPSEEK_COST, { input: 100, cacheRead: 200, cacheWrite: 0 })).toEqual({
			input: 0.14,
			cacheRead: 0.0028,
		});
	});

	test("mirrors pi-ai tier selection on total input usage", () => {
		// Total input usage = input + cacheRead + cacheWrite.
		const usage = { input: 50_000, cacheRead: 250_000, cacheWrite: 0 };
		expect(selectCostRates(GPT55_COST, usage)).toEqual({ input: 10, cacheRead: 1 });
		// Strictly above the threshold keeps the base rates.
		expect(selectCostRates(GPT55_COST, { input: 272_000, cacheRead: 0, cacheWrite: 0 })).toEqual({
			input: 5,
			cacheRead: 0.5,
		});
		expect(selectCostRates(GPT55_COST, { input: 272_001, cacheRead: 0, cacheWrite: 0 })).toEqual({
			input: 10,
			cacheRead: 1,
		});
	});

	test("picks the highest matching tier", () => {
		const cost = {
			input: 1,
			cacheRead: 0.1,
			tiers: [
				{ inputTokensAbove: 100_000, input: 2, cacheRead: 0.2 },
				{ inputTokensAbove: 500_000, input: 3, cacheRead: 0.3 },
			],
		};
		expect(selectCostRates(cost, { input: 600_000 })).toEqual({ input: 3, cacheRead: 0.3 });
		expect(selectCostRates(cost, { input: 200_000 })).toEqual({ input: 2, cacheRead: 0.2 });
	});

	test("rejects missing or negative pricing", () => {
		expect(selectCostRates(undefined, {})).toBeUndefined();
		expect(selectCostRates({}, {})).toBeUndefined();
		expect(selectCostRates({ input: 1 }, {})).toBeUndefined();
		expect(selectCostRates({ input: -1, cacheRead: 0 }, {})).toBeUndefined();
		expect(selectCostRates({ input: 1, cacheRead: "x" }, {})).toBeUndefined();
		// A malformed tier falls back to the base rates.
		expect(
			selectCostRates(
				{ input: 1, cacheRead: 0.1, tiers: [{ inputTokensAbove: "many", input: 2 }] },
				{ input: 999_999 },
			),
		).toEqual({ input: 1, cacheRead: 0.1 });
	});
});

describe("computeCacheSavings", () => {
	test("estimates savings when reliable pricing is available", () => {
		// (0.14 - 0.0028) / 1e6 * 200_000 = 0.02744
		const usage = { input: 10_000, output: 500, cacheRead: 200_000, cacheWrite: 0 };
		expect(computeCacheSavings(usage, { cost: DEEPSEEK_COST })).toEqual({
			cachedTokens: 200_000,
			savingsUsd: 0.02744,
			serviceTierMultiplier: 1,
		});
	});

	test("omits the estimate when pricing is unavailable", () => {
		const usage = { input: 10_000, cacheRead: 200_000, cacheWrite: 0 };
		expect(computeCacheSavings(usage, undefined)).toEqual({ cachedTokens: 200_000, serviceTierMultiplier: 1 });
		expect(computeCacheSavings(usage, {})).toEqual({ cachedTokens: 200_000, serviceTierMultiplier: 1 });
		expect(computeCacheSavings(usage, { cost: { input: 0.14 } })).toEqual({
			cachedTokens: 200_000,
			serviceTierMultiplier: 1,
		});
		// A zero input rate cannot produce a positive, honest estimate.
		expect(computeCacheSavings(usage, { cost: { input: 0, cacheRead: 0 } })).toEqual({
			cachedTokens: 200_000,
			serviceTierMultiplier: 1,
		});
	});

	test("uses tiered rates for the whole request", () => {
		// Total input usage 300k crosses the 272k tier: (10 - 1) / 1e6 * 250_000 = 2.25
		const usage = { input: 50_000, cacheRead: 250_000, cacheWrite: 0 };
		expect(computeCacheSavings(usage, { cost: GPT55_COST })).toMatchObject({
			cachedTokens: 250_000,
			savingsUsd: 2.25,
		});
		// Below the tier: (5 - 0.5) / 1e6 * 80_000 = 0.36
		expect(computeCacheSavings({ input: 20_000, cacheRead: 80_000 }, { cost: GPT55_COST })).toMatchObject({
			cachedTokens: 80_000,
			savingsUsd: 0.36,
		});
	});

	test("accounts for the service-tier multiplier Pi already applied", () => {
		const usage = { input: 10_000, cacheRead: 100_000, cacheWrite: 0 };
		// Catalogue cache-read cost for 100k tokens: 0.5 / 1e6 * 100_000 = 0.05.
		// Priority tier bills double, flex half.
		const priority = computeCacheSavings(
			{ ...usage, cost: { cacheRead: 0.1, total: 1 } },
			{ cost: GPT55_COST },
		);
		expect(priority).toMatchObject({ cachedTokens: 100_000, savingsUsd: 0.9, serviceTierMultiplier: 2 });

		const flex = computeCacheSavings({ ...usage, cost: { cacheRead: 0.025 } }, { cost: GPT55_COST });
		expect(flex).toMatchObject({ cachedTokens: 100_000, savingsUsd: 0.225, serviceTierMultiplier: 0.5 });
	});

	test("refuses an estimate when billing contradicts the catalogue", () => {
		const usage = { input: 10_000, cacheRead: 50_000, cacheWrite: 0 };
		// zai-coding-cn glm-4.6v reports cacheRead: 0, yet a provider charged
		// for cache reads: the real cache-read rate is unknown.
		const freeReads = { input: 0.3, cacheRead: 0 };
		expect(computeCacheSavings({ ...usage, cost: { cacheRead: 0.02 } }, { cost: freeReads })).toEqual({
			cachedTokens: 50_000,
			serviceTierMultiplier: 1,
		});
		// Catalogue expects paid reads, Pi reported none: the basis is broken.
		expect(computeCacheSavings({ ...usage, cost: { cacheRead: 0 } }, { cost: DEEPSEEK_COST })).toEqual({
			cachedTokens: 50_000,
			serviceTierMultiplier: 1,
		});
	});

	test("shows tokens only when the hit saves nothing", () => {
		const usage = { input: 10_000, cacheRead: 50_000, cacheWrite: 0 };
		const sameRate = { input: 0.14, cacheRead: 0.14 };
		expect(computeCacheSavings(usage, { cost: sameRate })).toEqual({
			cachedTokens: 50_000,
			serviceTierMultiplier: 1,
		});
	});

	test("returns undefined without a usable positive cacheRead", () => {
		expect(computeCacheSavings(undefined, { cost: DEEPSEEK_COST })).toBeUndefined();
		expect(computeCacheSavings({}, { cost: DEEPSEEK_COST })).toBeUndefined();
		expect(computeCacheSavings({ cacheRead: 0 }, { cost: DEEPSEEK_COST })).toBeUndefined();
		expect(computeCacheSavings({ cacheRead: -5 }, { cost: DEEPSEEK_COST })).toBeUndefined();
		expect(computeCacheSavings({ cacheRead: Number.NaN }, { cost: DEEPSEEK_COST })).toBeUndefined();
	});
});

describe("footer formatting", () => {
	test("formats token counts compactly", () => {
		expect(formatCachedTokens(128)).toBe("128");
		expect(formatCachedTokens(1000)).toBe("1k");
		expect(formatCachedTokens(12_345)).toBe("12.3k");
		expect(formatCachedTokens(120_000)).toBe("120k");
		expect(formatCachedTokens(1_234_567)).toBe("1.23M");
		expect(formatCachedTokens(0)).toBe("0");
	});

	test("keeps sub-cent estimates visible without claiming $0.00", () => {
		expect(formatSavingsUsd(1.234)).toBe("$1.23");
		expect(formatSavingsUsd(0.02744)).toBe("$0.03");
		expect(formatSavingsUsd(0.009)).toBe("$0.01");
		expect(formatSavingsUsd(0.0049)).toBe("$0.0049");
		expect(formatSavingsUsd(0.0042)).toBe("$0.0042");
		expect(formatSavingsUsd(0.00002)).toBe("$0.0001");
	});

	test("renders the footer status and its themed variant", () => {
		expect(formatCacheSavingsStatus({ cachedTokens: 200_000, serviceTierMultiplier: 1 })).toBe(
			"SAVED 200k tok",
		);
		expect(
			formatCacheSavingsStatus({ cachedTokens: 12_345, savingsUsd: 0.02744, serviceTierMultiplier: 1 }),
		).toBe("SAVED 12.3k tok ~$0.03");

		const theme = {
			fg(color: "accent" | "dim", text: string) {
				return `<${color}>${text}</${color}>`;
			},
		};
		expect(formatThemedCacheSavings("SAVED 200k tok ~$0.03", theme)).toBe(
			"<accent>SAVED</accent><dim> 200k tok ~$0.03</dim>",
		);
		expect(formatThemedCacheSavings("SAVED 200k tok")).toBe("SAVED 200k tok");
	});
});

function createContext(updates: Array<[string, string | undefined]>) {
	return {
		hasUI: true,
		ui: {
			setStatus(key: string, text: string | undefined) {
				updates.push([key, text]);
			},
		},
	};
}

describe("controller lifecycle", () => {
	test("tracks the latest response and clears on hit-less responses and boundaries", () => {
		const updates: Array<[string, string | undefined]> = [];
		const controller = createCacheSavingsController();
		const ctx = createContext(updates);

		controller.sessionStart(ctx);
		// A fresh session has nothing to clear: the footer is left untouched.
		expect(updates).toEqual([]);
		expect(controller.getLatest()).toBeUndefined();

		// Non-assistant messages are ignored entirely.
		controller.messageEnd({ role: "user", usage: { cacheRead: 999 } }, ctx);
		expect(updates).toHaveLength(0);
		// An assistant message without usable usage tells nothing new either.
		controller.messageEnd({ role: "assistant" }, ctx, { cost: DEEPSEEK_COST });
		expect(updates).toHaveLength(0);

		controller.messageEnd(
			{ role: "assistant", usage: { input: 10_000, cacheRead: 200_000 } },
			ctx,
			{ cost: DEEPSEEK_COST },
		);
		expect(updates.at(-1)).toEqual([STATUS_KEY, "SAVED 200k tok ~$0.03"]);
		expect(controller.getLatest()).toMatchObject({ cachedTokens: 200_000 });

		// The latest response wins, including a hit with no savings estimate.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, "SAVED 1.5k tok"]);

		// A hit-less response clears the stale hit display.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 0, input: 42 } }, ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);
		expect(controller.getLatest()).toBeUndefined();

		// Repeated renders of the same text do not touch the TUI.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		expect(updates.filter(([key]) => key === STATUS_KEY)).toHaveLength(4);

		// A session switch must clear the stale segment from the old session.
		controller.sessionStart(ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);

		// Model switches invalidate numbers that belonged to the old model.
		controller.modelSelect(ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);

		controller.sessionShutdown(ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);
		expect(controller.getLatest()).toBeUndefined();
	});

	test("sends themed statuses to the Pi footer", () => {
		const updates: Array<[string, string | undefined]> = [];
		const controller = createCacheSavingsController();
		const ctx = {
			hasUI: true,
			ui: {
				theme: {
					fg(color: "accent" | "dim", text: string) {
						return `<${color}>${text}</${color}>`;
					},
				},
				setStatus(key: string, text: string | undefined) {
					updates.push([key, text]);
				},
			},
		};

		controller.sessionStart(ctx);
		controller.messageEnd(
			{ role: "assistant", usage: { cacheRead: 100_000 } },
			ctx,
			{ cost: DEEPSEEK_COST },
		);

		expect(updates).toEqual([
			[STATUS_KEY, "<accent>SAVED</accent><dim> 100k tok ~$0.01</dim>"],
		]);
	});
});

test("extension registers the verified Pi lifecycle hooks", () => {
	const events: string[] = [];
	const pi = {
		on(event: string) {
			events.push(event);
		},
	};

	cacheSavingsExtension(pi as never);

	expect(events).toEqual(["session_start", "message_end", "model_select", "session_shutdown"]);
});
