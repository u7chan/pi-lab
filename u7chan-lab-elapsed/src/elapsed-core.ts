/**
 * Elapsed-time status primitives for Pi.
 *
 * Pi's working line only ever says `Working`, so nothing tells you how long
 * the current instruction has been running.  This PoC measures one
 * `before_agent_start` → `agent_settled` span: while the run is active the
 * working message ticks once per second (`Working (12m 3s)`), and when it has
 * fully settled the final duration stays in the footer status
 * (`ELAPSED 12m 3s`) until the next instruction starts.  Claude Code prints
 * the same `12m 3s` shape.
 *
 * The span deliberately ends at `agent_settled`, not `agent_end`: automatic
 * retries (and their backoff) run after `agent_end` without a new
 * `before_agent_start`, so only the settle marks the end of the instruction.
 *
 * The state machine keeps the clock and the interval scheduler injectable so
 * it can be driven without a terminal or real timers.
 */

export const STATUS_KEY = "elapsed";

/** Live ticks once per second, like Claude Code's elapsed counter. */
export const DEFAULT_TICK_MS = 1_000;

/**
 * `3s`, `12m 3s`, `1h 2m 3s`.  Sub-second remainders are floored and
 * negative or non-finite input collapses to `0s` so a bad clock cannot leak
 * `NaNs` into the working line.
 */
export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1_000)) : 0;
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3_600);
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** The live working message; the built-in loader adds the spinner. */
export function formatWorkingMessage(elapsedMs: number): string {
	return `Working (${formatElapsed(elapsedMs)})`;
}

export interface ElapsedTheme {
	fg(color: "accent" | "dim", text: string): string;
}

/** The footer status left behind by a finished run (accent label, dim value). */
export function formatThemedElapsedStatus(elapsedMs: number, theme: ElapsedTheme): string {
	return `${theme.fg("accent", "ELAPSED")}${theme.fg("dim", ` ${formatElapsed(elapsedMs)}`)}`;
}

export interface ElapsedTimer {
	cancel(): void;
}

export interface ElapsedScheduler {
	setInterval(callback: () => void, intervalMs: number): ElapsedTimer;
}

const defaultScheduler: ElapsedScheduler = {
	setInterval(callback, intervalMs) {
		const nativeTimer = globalThis.setInterval(callback, intervalMs);
		// The TUI keeps the process alive; the timer must not pin it open on its own.
		(nativeTimer as unknown as { unref?: () => void }).unref?.();
		return { cancel: () => globalThis.clearInterval(nativeTimer) };
	},
};

export interface ElapsedUi {
	theme: ElapsedTheme;
	setWorkingMessage(message?: string): void;
	setStatus(key: string, text: string | undefined): void;
}

/** The slice of the Pi extension context this controller uses. */
export interface ElapsedContext {
	hasUI: boolean;
	ui: ElapsedUi;
}

export interface ElapsedControllerOptions {
	now?: () => number;
	scheduler?: ElapsedScheduler;
	tickMs?: number;
}

export interface ElapsedController {
	/** Start (or restart) the measurement for a newly submitted instruction. */
	beforeAgentStart(ctx: ElapsedContext): void;
	/** Freeze the measurement once the run has fully settled (retries included). */
	agentSettled(ctx: ElapsedContext): void;
	/** Drop the timer and any visible status when the session goes away. */
	sessionShutdown(ctx: ElapsedContext): void;
	dispose(): void;
}

export function createElapsedController(options: ElapsedControllerOptions = {}): ElapsedController {
	const now = options.now ?? (() => Date.now());
	const scheduler = options.scheduler ?? defaultScheduler;
	const tickMs = options.tickMs ?? DEFAULT_TICK_MS;

	let startedAt: number | undefined;
	let timer: ElapsedTimer | undefined;

	const stopTimer = () => {
		timer?.cancel();
		timer = undefined;
	};

	const renderWorking = (ctx: ElapsedContext) => {
		if (!ctx.hasUI || startedAt === undefined) return;
		ctx.ui.setWorkingMessage(formatWorkingMessage(now() - startedAt));
	};

	return {
		beforeAgentStart(ctx) {
			stopTimer();
			if (!ctx.hasUI) {
				startedAt = undefined;
				return;
			}

			startedAt = now();
			// The previous run's final time would otherwise sit in the footer
			// while the new measurement is still running.
			ctx.ui.setStatus(STATUS_KEY, undefined);
			renderWorking(ctx);
			timer = scheduler.setInterval(() => renderWorking(ctx), tickMs);
		},

		agentSettled(ctx) {
			stopTimer();
			if (startedAt === undefined) return;

			const elapsedMs = now() - startedAt;
			startedAt = undefined;
			if (!ctx.hasUI) return;

			// The working row is removed at agent_end, but the stored message is
			// reused if a retry, compaction, or queued continuation shows the
			// loader again, so restore the built-in `Working` for the next run.
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus(STATUS_KEY, formatThemedElapsedStatus(elapsedMs, ctx.ui.theme));
		},

		sessionShutdown(ctx) {
			stopTimer();
			startedAt = undefined;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		},

		dispose() {
			stopTimer();
			startedAt = undefined;
		},
	};
}
