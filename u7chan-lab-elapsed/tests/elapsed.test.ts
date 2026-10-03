import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import elapsedExtension, {
	createElapsedController,
	DEFAULT_TICK_MS,
	formatElapsed,
	formatThemedElapsedStatus,
	formatWorkingMessage,
	STATUS_KEY,
} from "../.pi/extensions/elapsed.ts";
import type {
	ElapsedContext,
	ElapsedScheduler,
	ElapsedTheme,
	ElapsedTimer,
} from "../src/elapsed-core.ts";

const theme: ElapsedTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};

function createFakeUi() {
	const working: Array<string | undefined> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ctx: ElapsedContext = {
		hasUI: true,
		ui: {
			theme,
			setWorkingMessage: (message) => {
				working.push(message);
			},
			setStatus: (key, text) => {
				statuses.push([key, text]);
			},
		},
	};
	return { ctx, working, statuses };
}

function createFakeScheduler() {
	const callbacks = new Map<ElapsedTimer, () => void>();
	let created = 0;
	const scheduler: ElapsedScheduler = {
		setInterval(callback) {
			created++;
			const timer: ElapsedTimer = { cancel: () => callbacks.delete(timer) };
			callbacks.set(timer, callback);
			return timer;
		},
	};

	return {
		scheduler,
		get activeCount() {
			return callbacks.size;
		},
		get createdCount() {
			return created;
		},
		/** Fire every interval the controller currently holds. */
		tick() {
			for (const callback of [...callbacks.values()]) callback();
		},
	};
}

function createClock(startedAt = 0) {
	let current = startedAt;
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

describe("formatElapsed", () => {
	test("formats seconds, minutes, and hours like Claude Code", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(999)).toBe("0s");
		expect(formatElapsed(1_000)).toBe("1s");
		expect(formatElapsed(59_999)).toBe("59s");
		expect(formatElapsed(60_000)).toBe("1m 0s");
		expect(formatElapsed(723_000)).toBe("12m 3s");
		expect(formatElapsed(3_600_000)).toBe("1h 0m 0s");
		expect(formatElapsed(3_723_000)).toBe("1h 2m 3s");
	});

	test("collapses negative and non-finite input to zero", () => {
		expect(formatElapsed(-1_000)).toBe("0s");
		expect(formatElapsed(Number.NaN)).toBe("0s");
		expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0s");
	});
});

describe("elapsed text", () => {
	test("renders the live working message and the themed footer status", () => {
		expect(formatWorkingMessage(723_000)).toBe("Working (12m 3s)");
		expect(formatThemedElapsedStatus(723_000, theme)).toBe(
			"<accent>ELAPSED</accent><dim> 12m 3s</dim>",
		);
	});
});

describe("elapsed controller", () => {
	test("ticks the working message every tick until the run settles", () => {
		const clock = createClock();
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: clock.now, scheduler: fake.scheduler });
		const ui = createFakeUi();

		controller.beforeAgentStart(ui.ctx);
		expect(ui.working).toEqual(["Working (0s)"]);
		expect(ui.statuses).toEqual([[STATUS_KEY, undefined]]);
		expect(fake.activeCount).toBe(1);

		clock.advance(1_000);
		fake.tick();
		expect(ui.working.at(-1)).toBe("Working (1s)");

		clock.advance(722_000);
		fake.tick();
		expect(ui.working.at(-1)).toBe("Working (12m 3s)");
		// The footer only receives the previous run's reset before ticking.
		expect(ui.statuses).toEqual([[STATUS_KEY, undefined]]);
	});

	test("freezes the final duration in the footer on settle and stops ticking", () => {
		const clock = createClock();
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: clock.now, scheduler: fake.scheduler });
		const ui = createFakeUi();

		controller.beforeAgentStart(ui.ctx);
		clock.advance(723_000);
		controller.agentSettled(ui.ctx);

		expect(ui.working.at(-1)).toBeUndefined();
		expect(ui.statuses.at(-1)).toEqual([
			STATUS_KEY,
			"<accent>ELAPSED</accent><dim> 12m 3s</dim>",
		]);
		expect(fake.activeCount).toBe(0);

		const rendered = ui.working.length;
		clock.advance(60_000);
		fake.tick();
		expect(ui.working.length).toBe(rendered);
	});

	test("keeps running through the retry window instead of stopping at agent_end", () => {
		const clock = createClock();
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: clock.now, scheduler: fake.scheduler });
		const ui = createFakeUi();

		// First attempt fails after 1.1 s, backoff runs, the retry answers at 4.4 s.
		controller.beforeAgentStart(ui.ctx);
		clock.advance(1_100);
		fake.tick();
		expect(ui.working.at(-1)).toBe("Working (1s)");

		clock.advance(3_300);
		fake.tick();
		expect(ui.working.at(-1)).toBe("Working (4s)");
		// No footer value is committed until the run settles.
		expect(ui.statuses).toEqual([[STATUS_KEY, undefined]]);

		controller.agentSettled(ui.ctx);
		expect(ui.statuses.at(-1)).toEqual([
			STATUS_KEY,
			"<accent>ELAPSED</accent><dim> 4s</dim>",
		]);
	});

	test("clears the previous final time when the next instruction starts", () => {
		const clock = createClock();
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: clock.now, scheduler: fake.scheduler });
		const ui = createFakeUi();

		controller.beforeAgentStart(ui.ctx);
		clock.advance(2_000);
		controller.agentSettled(ui.ctx);
		expect(ui.statuses.at(-1)?.[1]).toBe("<accent>ELAPSED</accent><dim> 2s</dim>");

		controller.beforeAgentStart(ui.ctx);
		expect(ui.statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		expect(ui.working.at(-1)).toBe("Working (0s)");
		expect(fake.activeCount).toBe(1);
		expect(fake.createdCount).toBe(2);
	});

	test("restarts the measurement without leaking timers on a mid-run restart", () => {
		const clock = createClock();
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: clock.now, scheduler: fake.scheduler });
		const ui = createFakeUi();

		controller.beforeAgentStart(ui.ctx);
		clock.advance(5_000);
		controller.beforeAgentStart(ui.ctx);

		expect(fake.activeCount).toBe(1);
		expect(fake.createdCount).toBe(2);
		fake.tick();
		expect(ui.working.at(-1)).toBe("Working (0s)");
	});

	test("does not touch the UI or the clock without a UI", () => {
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: () => 1_000, scheduler: fake.scheduler });
		const headless: ElapsedContext = {
			hasUI: false,
			ui: {
				theme,
				setWorkingMessage: () => {
					throw new Error("no UI available");
				},
				setStatus: () => {
					throw new Error("no UI available");
				},
			},
		};

		controller.beforeAgentStart(headless);
		controller.agentSettled(headless);
		expect(fake.createdCount).toBe(0);
		expect(fake.activeCount).toBe(0);
	});

	test("clears the footer and the timer on session shutdown", () => {
		const clock = createClock();
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: clock.now, scheduler: fake.scheduler });
		const ui = createFakeUi();

		controller.beforeAgentStart(ui.ctx);
		clock.advance(1_000);
		controller.agentSettled(ui.ctx);
		controller.beforeAgentStart(ui.ctx);
		expect(fake.activeCount).toBe(1);

		controller.sessionShutdown(ui.ctx);
		expect(ui.statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		expect(fake.activeCount).toBe(0);
	});

	test("ignores agent_settled and dispose without a running measurement", () => {
		const fake = createFakeScheduler();
		const controller = createElapsedController({ now: () => 0, scheduler: fake.scheduler });
		const ui = createFakeUi();

		controller.agentSettled(ui.ctx);
		expect(ui.working).toEqual([]);
		expect(ui.statuses).toEqual([]);

		controller.beforeAgentStart(ui.ctx);
		controller.dispose();
		expect(fake.activeCount).toBe(0);
	});
});

describe("elapsed extension", () => {
	test("drives the controller from before_agent_start, agent_settled, and session_shutdown", () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const working: Array<string | undefined> = [];
		const statuses: Array<[string, string | undefined]> = [];
		const fakePi = {
			on(type: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(type, handler);
			},
		} as unknown as ExtensionAPI;

		elapsedExtension(fakePi);

		const ctx = {
			hasUI: true,
			ui: {
				theme,
				setWorkingMessage: (message?: string) => {
					working.push(message);
				},
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
			},
		};

		handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		expect(working.at(-1)).toMatch(/^Working \(\d+s\)$/);

		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(working.at(-1)).toBeUndefined();
		expect(statuses.at(-1)?.[0]).toBe(STATUS_KEY);
		expect(statuses.at(-1)?.[1]).toContain("ELAPSED");
		// The freeze must not sit on agent_end: retries continue past it.
		expect(handlers.has("agent_end")).toBe(false);

		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
	});

	test("uses a one-second tick by default", () => {
		expect(DEFAULT_TICK_MS).toBe(1_000);
	});
});
