import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createElapsedController,
	DEFAULT_TICK_MS,
	formatElapsed,
	formatThemedElapsedStatus,
	formatWorkingMessage,
	STATUS_KEY,
	type ElapsedContext,
} from "../../src/elapsed-core.ts";

// Re-export the pure pieces so the PoC can be inspected/tested without a Pi
// runtime.  The extension itself only adapts them to Pi lifecycle events.
export {
	createElapsedController,
	DEFAULT_TICK_MS,
	formatElapsed,
	formatThemedElapsedStatus,
	formatWorkingMessage,
	STATUS_KEY,
};
export type {
	ElapsedContext,
	ElapsedController,
	ElapsedControllerOptions,
	ElapsedScheduler,
	ElapsedTheme,
	ElapsedTimer,
	ElapsedUi,
} from "../../src/elapsed-core.ts";

/**
 * Shows how long the current instruction has been running.
 *
 * One `before_agent_start` → `agent_end` span is measured (the whole
 * instruction, including every tool call).  While it runs the working line
 * ticks every second (`Working (12m 3s)`); when it ends the final duration
 * stays in the footer status (`ELAPSED 12m 3s`) until the next instruction.
 */
export default function elapsedExtension(pi: ExtensionAPI): void {
	const controller = createElapsedController();

	const toContext = (ctx: ExtensionContext): ElapsedContext => ({
		hasUI: ctx.hasUI,
		ui: {
			theme: ctx.ui.theme,
			setWorkingMessage: (message) => ctx.ui.setWorkingMessage(message),
			setStatus: (key, text) => ctx.ui.setStatus(key, text),
		},
	});

	pi.on("before_agent_start", (_event, ctx) => {
		controller.beforeAgentStart(toContext(ctx));
	});

	pi.on("agent_end", (_event, ctx) => {
		controller.agentEnd(toContext(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.sessionShutdown(toContext(ctx));
	});
}
