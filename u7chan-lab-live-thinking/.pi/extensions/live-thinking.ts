import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createLiveThinkingController,
	DEFAULT_THROTTLE_MS,
	FORMAT_VERSION,
	LIVE_PHASES,
	MAX_TEXT_CHARS,
	parseLiveThinking,
	serializeLiveThinking,
	sidecarPath,
	tailText,
	type AssistantStreamEvent,
	type LivePhase,
	type LiveThinkingController,
	type LiveThinkingFile,
	type LiveThinkingScheduler,
	type LiveThinkingSink,
	type LiveThinkingState,
} from "../../src/live-thinking-core.ts";

// Re-export the pure pieces so readers and tests can use the same format
// without loading a Pi runtime.
export {
	createLiveThinkingController,
	DEFAULT_THROTTLE_MS,
	FORMAT_VERSION,
	LIVE_PHASES,
	MAX_TEXT_CHARS,
	parseLiveThinking,
	serializeLiveThinking,
	sidecarPath,
	tailText,
};
export type {
	AssistantStreamEvent,
	LivePhase,
	LiveThinkingController,
	LiveThinkingFile,
	LiveThinkingScheduler,
	LiveThinkingSink,
	LiveThinkingState,
};

let temporaryCount = 0;

/**
 * Writes are synchronous and best-effort.  This feature only observes a run;
 * a full disk or a removed session directory must never break the session, so
 * every filesystem error is swallowed.
 */
const fileSink: LiveThinkingSink = {
	write(path, body) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.${process.pid}.${temporaryCount++}.tmp`;
			writeFileSync(temporary, body, { mode: 0o600 });
			renameSync(temporary, path);
		} catch {
			// Observational only.
		}
	},
	clear(path) {
		try {
			unlinkSync(path);
		} catch {
			// Missing is the normal case.
		}
	},
};

function sessionFileOf(ctx: ExtensionContext): string | null {
	return ctx.sessionManager.getSessionFile() ?? null;
}

/**
 * Publishes the live phase and the tail of the current thinking block to
 * `<session>.jsonl.thinking.json` for external readers such as hwc.
 *
 * It does not add anything to the transcript, the footer or the transcript
 * rendering, and it does not change Pi's thinking-block visibility.  The
 * sidecar is replaced (never appended) and removed at `agent_settled` or
 * `session_shutdown`.
 */
export default function liveThinkingExtension(pi: ExtensionAPI): void {
	const controller = createLiveThinkingController({ sink: fileSink });

	pi.on("session_start", (_event, ctx) => {
		controller.attachSession(sessionFileOf(ctx));
	});

	pi.on("session_shutdown", () => {
		controller.dispose();
	});

	pi.on("before_agent_start", () => {
		controller.agentStart();
	});

	pi.on("agent_start", () => {
		controller.agentStart();
	});

	pi.on("turn_start", () => {
		controller.turnStart();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") controller.assistantMessageStart();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		controller.assistantEvent(event.assistantMessageEvent as AssistantStreamEvent);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") controller.assistantMessageEnd();
	});

	pi.on("tool_execution_start", (event) => {
		controller.toolStart(event);
	});

	pi.on("tool_execution_end", (event) => {
		controller.toolEnd(event);
	});

	pi.on("session_before_compact", () => {
		controller.compactionStart();
	});

	pi.on("session_compact", () => {
		controller.compactionEnd();
	});

	pi.on("session_compact_failed", () => {
		controller.compactionEnd();
	});

	pi.on("ui_prompt_start", () => {
		controller.uiPromptStart();
	});

	pi.on("ui_prompt_end", () => {
		controller.uiPromptEnd();
	});

	pi.on("agent_end", () => {
		controller.agentEnd();
	});

	pi.on("agent_settled", () => {
		controller.agentSettled();
	});
}
