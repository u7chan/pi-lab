import { describe, expect, test } from "bun:test";
import cacheTtlExtension, {
	createCacheTtlController,
	formatCacheStatus,
	inspectPromptCacheTtl,
	nextCacheUpdateDelayMs,
	isAutomaticCacheProvider,
	SHORT_CACHE_TTL_MS,
	STATUS_KEY,
} from "../.pi/extensions/cache-ttl.ts";
import type {
	CacheStatusContext,
	CacheTtlScheduler,
	CacheTtlTimer,
} from "../src/cache-ttl-core.ts";

describe("inspectPromptCacheTtl", () => {
	test("reads the provider payload shapes used by the installed Pi", () => {
		expect(inspectPromptCacheTtl({ cache_control: { type: "ephemeral", ttl: "1h" } })).toBe(
			60 * 60 * 1000,
		);
		expect(inspectPromptCacheTtl({ cacheControl: { type: "ephemeral", ttl: "30m" } })).toBe(
			30 * 60 * 1000,
		);
		expect(inspectPromptCacheTtl({ cachePoint: { type: "default", ttl: "1h" } })).toBe(
			60 * 60 * 1000,
		);
		expect(inspectPromptCacheTtl({ prompt_cache_retention: "24h" })).toBe(24 * 60 * 60 * 1000);
		expect(inspectPromptCacheTtl({ prompt_cache_options: { ttl: "30m" } })).toBe(30 * 60 * 1000);
	});

	test("uses the shortest simultaneous TTL, including nested directives", () => {
		expect(
			inspectPromptCacheTtl({
				prompt_cache_retention: "24h",
				prompt_cache_options: { ttl: "30m" },
				input: [
					{ content: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] },
				],
			}),
		).toBe(30 * 60 * 1000);
	});

	test("infers the short default only from explicit cache signals", () => {
		expect(inspectPromptCacheTtl({ cache_control: { type: "ephemeral" } })).toBe(SHORT_CACHE_TTL_MS);
		expect(inspectPromptCacheTtl({ cachePoint: { type: "default" } })).toBe(SHORT_CACHE_TTL_MS);
		expect(inspectPromptCacheTtl({ options: { cacheRetention: "short" } })).toBe(SHORT_CACHE_TTL_MS);
		expect(inspectPromptCacheTtl({ prompt_cache_key: "session-1" })).toBe(SHORT_CACHE_TTL_MS);
		expect(inspectPromptCacheTtl({ prompt_cache_key: "   " })).toBeUndefined();
		expect(inspectPromptCacheTtl({ unrelated: true })).toBeUndefined();
	});

	test("does not invent a TTL for disabled or unrecognised cache metadata", () => {
		expect(inspectPromptCacheTtl({ options: { cacheRetention: "long" } })).toBeNull();
		expect(inspectPromptCacheTtl({ options: { cacheRetention: "none" } })).toBeNull();
		expect(inspectPromptCacheTtl({ prompt_cache_options: { mode: "explicit" } })).toBeNull();
		expect(inspectPromptCacheTtl({ prompt_cache_retention: "short" })).toBeNull();
		expect(inspectPromptCacheTtl({ cache_control: { type: "ephemeral", ttl: "soon" } })).toBeNull();
		expect(
			inspectPromptCacheTtl({
				cache_control: { type: "ephemeral", ttl: "1h" },
				prompt_cache_retention: "not-a-duration",
			}),
		).toBeNull();
	});
});

describe("footer clock", () => {
	test("formats an absolute expiry and schedules the next visible change", () => {
		expect(formatCacheStatus(undefined, 0, "pending")).toBe("CACHE pending");
		expect(formatCacheStatus(undefined, 0, "automatic")).toBe("CACHE auto");
		expect(formatCacheStatus(undefined, 0, "unsupported")).toBe("CACHE unsupported");
		expect(formatCacheStatus(undefined, 0)).toBe("CACHE unknown");
		expect(formatCacheStatus(0, 0)).toBe("CACHE expired");
		expect(formatCacheStatus(60_000, 0)).toBe("CACHE 01:00");
		expect(formatCacheStatus(9_000, 0)).toBe("CACHE 00:09");
		expect(formatCacheStatus(9_000, 8_001)).toBe("CACHE 00:01");
		expect(nextCacheUpdateDelayMs(60_000, 0)).toBe(1_000);
		expect(nextCacheUpdateDelayMs(60_000, 1)).toBe(999);
		expect(nextCacheUpdateDelayMs(0, 0)).toBeUndefined();
	});

	test("recognises the installed implicit-cache providers", () => {
		expect(isAutomaticCacheProvider("deepseek")).toBe(true);
		expect(isAutomaticCacheProvider("zai")).toBe(true);
		expect(isAutomaticCacheProvider("zai-coding-cn")).toBe(true);
		expect(isAutomaticCacheProvider("openrouter")).toBe(false);
	});
});

interface FakeTimer extends CacheTtlTimer {
	delayMs: number;
	cancelled: boolean;
	unrefCount: number;
	run(): void;
}

function createFakeScheduler(): { scheduler: CacheTtlScheduler; timers: FakeTimer[] } {
	const timers: FakeTimer[] = [];
	const scheduler: CacheTtlScheduler = {
		setTimeout(callback, delayMs) {
			const timer: FakeTimer = {
				delayMs,
				cancelled: false,
				unrefCount: 0,
				cancel() {
					this.cancelled = true;
				},
				unref() {
					this.unrefCount++;
				},
				run() {
					callback();
				},
			};
			timers.push(timer);
			return timer;
		},
	};
	return { scheduler, timers };
}

function createContext(updates: Array<[string, string | undefined]>): CacheStatusContext {
	return {
		hasUI: true,
		ui: {
			setStatus(key, text) {
				updates.push([key, text]);
			},
		},
	};
}

test("controller handles lifecycle resets, stale timers, unref, and efficient renders", () => {
	let now = 10_000;
	const updates: Array<[string, string | undefined]> = [];
	const { scheduler, timers } = createFakeScheduler();
	const controller = createCacheTtlController({ now: () => now, scheduler });
	const ctx = createContext(updates);

	controller.sessionStart(ctx);
	expect(updates).toEqual([[STATUS_KEY, "CACHE pending"]]);
	expect(controller.getState()).toEqual({ kind: "pending" });

	controller.beforeProviderRequest({ prompt_cache_retention: "1m" }, ctx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE 01:00"]);
	expect(timers).toHaveLength(1);
	expect(timers[0]?.unrefCount).toBe(1);
	const firstTimer = timers[0]!;

	// A repeated render of the same second does not touch the TUI.
	controller.beforeProviderRequest({ prompt_cache_retention: "1m" }, ctx);
	expect(updates.filter(([key]) => key === STATUS_KEY)).toHaveLength(2);
	const repeatedTimer = timers[1]!;
	expect(firstTimer.cancelled).toBe(true);

	now += 1_001;
	firstTimer.run();
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE 01:00"]);
	repeatedTimer.run();
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE 00:59"]);
	expect(timers[2]?.unrefCount).toBe(1);

	// A request without cache evidence clears the old countdown and identifies
	// the provider as unsupported.  The
	// cancelled callback must not resurrect it if it was already queued.
	const secondTimer = timers.at(-1)!;
	controller.beforeProviderRequest({ model: "uncached-provider" }, ctx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE unsupported"]);
	expect(controller.getState()).toEqual({ kind: "unsupported" });
	expect(secondTimer.cancelled).toBe(true);
	secondTimer.run();
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE unsupported"]);

	// Cache metadata can be present without a portable TTL.  Keep that state
	// separate from a provider that emitted no cache metadata at all.
	controller.beforeProviderRequest({ prompt_cache_retention: "short" }, ctx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE unknown"]);
	expect(controller.getState()).toEqual({ kind: "unknown" });

	controller.beforeProviderRequest({ prompt_cache_key: "session-1" }, ctx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE 05:00"]);
	const activeTimer = timers.at(-1)!;
	controller.modelSelect(ctx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE pending"]);
	expect(controller.getState()).toEqual({ kind: "pending" });
	activeTimer.run();
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE pending"]);

	// DeepSeek and Z.AI use implicit caching: the request has no TTL, while
	// the final assistant usage reports cacheRead tokens when a prefix hits.
	const automaticCtx = createContext(updates);
	controller.beforeProviderRequest({ model: "deepseek-chat" }, automaticCtx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE unsupported"]);

	controller.beforeProviderRequest({ model: "deepseek-chat" }, automaticCtx, "deepseek");
	// The provider name is supplied by the extension context in production;
	// a no-metadata request therefore falls back to the automatic status.
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE auto"]);
	expect(controller.getState()).toEqual({ kind: "automatic" });
	controller.messageEnd(
		{ role: "assistant", provider: "deepseek", usage: { cacheRead: 128 } },
		automaticCtx,
	);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE hit"]);
	controller.messageEnd(
		{ role: "assistant", provider: "deepseek", usage: { cacheRead: 0 } },
		automaticCtx,
	);
	expect(updates.at(-1)).toEqual([STATUS_KEY, "CACHE auto"]);

	controller.sessionShutdown(ctx);
	expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);
	expect(controller.getState()).toEqual({ kind: "unknown" });
});

test("extension registers the verified Pi lifecycle hooks", () => {
	const events: string[] = [];
	const pi = {
		on(event: string) {
			events.push(event);
		},
	};

	cacheTtlExtension(pi as never);

	expect(events).toEqual([
		"session_start",
		"before_provider_request",
		"message_end",
		"model_select",
		"session_shutdown",
	]);
});
