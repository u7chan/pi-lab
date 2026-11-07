/**
 * Live run-phase sidecar primitives for Pi.
 *
 * Pi's session JSONL receives an assistant message only when that message ends,
 * so nothing on disk shows what a running agent is doing right now.  Readers
 * such as hwc (the Herdr web client) cannot attach to the pi process and must
 * not scrape the TUI, which deliberately hides thinking blocks.  This feature
 * writes the transient state to a small sidecar file next to the session file:
 *
 *     <session>.jsonl.thinking.json
 *
 * The file is replaced, never appended.  It holds the current phase plus the
 * tail of the current thinking block, and it is removed when the instruction
 * settles.  Keeping history here is out of scope on purpose: the conversation
 * truth stays in the session JSONL.
 *
 * Phases are derived from the provider stream and the tool lifecycle:
 *
 * | phase          | observed signal                                              |
 * |----------------|--------------------------------------------------------------|
 * | `waiting`      | run/turn started, no delta yet (request in flight)            |
 * | `thinking`     | `thinking_start` / `thinking_delta`                           |
 * | `writing`      | `text_start` / `text_delta`                                   |
 * | `tool-call`    | `toolcall_start` / `toolcall_delta` (arguments streaming)      |
 * | `tool`         | `tool_execution_start` until the last running tool ends        |
 * | `compacting`   | `session_before_compact` until `session_compact(_failed)`      |
 * | `waiting-user` | `ui_prompt_start` until `ui_prompt_end`                        |
 *
 * Automatic retry backoff has no extension event, so the gap between
 * `agent_end` and the next `agent_start` reads as `waiting`.  Parallel tool
 * calls collapse into one `tool` phase with a running count.  The clock,
 * throttle and file sink are injectable so the state machine can be driven
 * without a terminal, real timers or a filesystem.
 */

export const FORMAT_VERSION = 1;

/** Readers poll at about 1s; writing faster than that only burns I/O. */
export const DEFAULT_THROTTLE_MS = 500;

/** hwc shows two lines; this keeps the file small while leaving slack. */
export const MAX_TEXT_CHARS = 1_200;

export const LIVE_PHASES = [
	"waiting",
	"thinking",
	"writing",
	"tool-call",
	"tool",
	"compacting",
	"waiting-user",
] as const;

export type LivePhase = (typeof LIVE_PHASES)[number];

export type LiveThinkingState = {
	phase: LivePhase;
	/** Tail of the current thinking block. Empty outside `thinking`. */
	text: string;
	/** Most recently started running tool, when more than one runs in parallel. */
	tool: string | null;
	tools: number;
};

export type LiveThinkingFile = {
	v: typeof FORMAT_VERSION;
	at: number;
	phase: LivePhase;
	text?: string;
	tool?: string;
	tools?: number;
};

/** Structural subset of Pi's `AssistantMessageEvent`. */
export type AssistantStreamEvent = {
	type: string;
	delta?: string;
	content?: string;
};

export type LiveThinkingSink = {
	/** Replace the sidecar atomically. Errors are the sink's to swallow. */
	write(path: string, body: string): void;
	/** Remove the sidecar. Missing files are not an error. */
	clear(path: string): void;
};

export type LiveThinkingScheduler = {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type LiveThinkingControllerOptions = {
	sink: LiveThinkingSink;
	now?: () => number;
	scheduler?: LiveThinkingScheduler;
	throttleMs?: number;
	textLimit?: number;
};

export type LiveThinkingController = {
	attachSession(sessionFile: string | null): void;
	dispose(): void;
	agentStart(): void;
	turnStart(): void;
	assistantMessageStart(): void;
	assistantEvent(event: AssistantStreamEvent): void;
	assistantMessageEnd(): void;
	toolStart(event: { toolCallId: string; toolName: string }): void;
	toolEnd(event: { toolCallId: string }): void;
	compactionStart(): void;
	compactionEnd(): void;
	uiPromptStart(): void;
	uiPromptEnd(): void;
	agentEnd(): void;
	agentSettled(): void;
	state(): LiveThinkingState;
};

export const defaultScheduler: LiveThinkingScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function sidecarPath(sessionFile: string): string {
	return `${sessionFile}.thinking.json`;
}

/**
 * Keep the newest `limit` code points.  Slicing by code point avoids splitting
 * a surrogate pair (emoji in reasoning would otherwise become U+FFFD).
 */
export function tailText(text: string, limit = MAX_TEXT_CHARS): string {
	if (limit <= 0) return "";
	const characters = Array.from(text);
	if (characters.length <= limit) return text;
	return characters.slice(-limit).join("");
}

/** `text` is meaningful only while thinking, `tool`/`tools` only while a tool runs. */
export function sidecarDocument(state: LiveThinkingState, at: number): LiveThinkingFile {
	const document: LiveThinkingFile = { v: FORMAT_VERSION, at, phase: state.phase };
	if (state.phase === "thinking" && state.text !== "") document.text = state.text;
	if (state.phase === "tool") {
		if (state.tool !== null) document.tool = state.tool;
		if (state.tools > 0) document.tools = state.tools;
	}
	return document;
}

export function serializeLiveThinking(state: LiveThinkingState, at: number): string {
	return `${JSON.stringify(sidecarDocument(state, at))}\n`;
}

/**
 * Reader-side validation.  A writer that disagrees with the phase rules (for
 * example text while a tool runs) is not trusted field by field; the file is
 * rejected so a stale or broken sidecar cannot leak into the UI.
 */
export function parseLiveThinking(body: string): LiveThinkingFile | null {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.v !== FORMAT_VERSION) return null;
	if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
	if (!LIVE_PHASES.includes(record.phase as LivePhase)) return null;
	const document: LiveThinkingFile = {
		v: FORMAT_VERSION,
		at: record.at,
		phase: record.phase as LivePhase,
	};
	if (document.phase === "thinking" && typeof record.text === "string" && record.text !== "") {
		document.text = tailText(record.text, MAX_TEXT_CHARS);
	}
	if (document.phase === "tool") {
		if (typeof record.tool === "string" && record.tool !== "") document.tool = record.tool;
		if (typeof record.tools === "number" && Number.isFinite(record.tools)) document.tools = record.tools;
	}
	return document;
}

export function createLiveThinkingController(
	options: LiveThinkingControllerOptions,
): LiveThinkingController {
	const { sink } = options;
	const now = options.now ?? Date.now;
	const scheduler = options.scheduler ?? defaultScheduler;
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	const textLimit = options.textLimit ?? MAX_TEXT_CHARS;

	let path: string | null = null;
	let running = false;
	let activity: "thinking" | "writing" | "tool-call" | null = null;
	let thinking = "";
	let tools = new Map<string, string>();
	let compacting = false;
	let uiPrompts = 0;
	let timer: unknown = null;
	let lastWriteAt = -Infinity;
	let lastKey = "";
	let lastPhase: LivePhase | null = null;

	const currentPhase = (): LivePhase => {
		if (compacting) return "compacting";
		if (tools.size > 0) return "tool";
		if (activity !== null) return activity;
		if (uiPrompts > 0) return "waiting-user";
		return "waiting";
	};

	const currentState = (): LiveThinkingState => {
		const phase = currentPhase();
		const names = [...tools.values()];
		return {
			phase,
			text: phase === "thinking" ? tailText(thinking, textLimit) : "",
			tool: phase === "tool" ? (names.at(-1) ?? null) : null,
			tools: phase === "tool" ? tools.size : 0,
		};
	};

	const cancelTimer = () => {
		if (timer === null) return;
		scheduler.clearTimeout(timer);
		timer = null;
	};

	const resetWritten = () => {
		lastKey = "";
		lastPhase = null;
		lastWriteAt = -Infinity;
	};

	const removeFile = () => {
		cancelTimer();
		const previous = path;
		resetWritten();
		if (previous !== null) sink.clear(previous);
	};

	const flush = () => {
		cancelTimer();
		if (path === null) return;
		const state = currentState();
		const key = `${state.phase}\u0000${state.text}\u0000${state.tool ?? ""}\u0000${state.tools}`;
		// Nothing changed since the last write: keep the old `at` instead of
		// touching the file, so a long tool run does not look like fresh activity.
		if (key === lastKey) return;
		lastKey = key;
		lastPhase = state.phase;
		lastWriteAt = now();
		sink.write(path, serializeLiveThinking(state, now()));
	};

	const active = () => running || compacting || tools.size > 0;

	const touch = () => {
		if (path === null) return;
		if (!active()) {
			// An idle TUI dialog or a finished run must not leave a phase behind.
			if (lastKey !== "") removeFile();
			return;
		}
		const phase = currentPhase();
		if (phase !== lastPhase) {
			flush();
			return;
		}
		const elapsed = now() - lastWriteAt;
		if (elapsed >= throttleMs) {
			flush();
			return;
		}
		if (timer === null) {
			timer = scheduler.setTimeout(() => {
				timer = null;
				flush();
			}, throttleMs - elapsed);
		}
	};

	const resetRun = () => {
		cancelTimer();
		activity = null;
		thinking = "";
		tools = new Map();
		uiPrompts = 0;
	};

	return {
		attachSession(sessionFile) {
			const next = sessionFile === null ? null : sidecarPath(sessionFile);
			if (next !== path) {
				if (path !== null) sink.clear(path);
				resetWritten();
				path = next;
			}
			// A sidecar can survive a crash; a fresh process is never mid-run.
			if (path !== null) sink.clear(path);
			resetRun();
			compacting = false;
			running = false;
		},
		dispose() {
			removeFile();
			path = null;
			resetRun();
			compacting = false;
			running = false;
		},
		agentStart() {
			running = true;
			activity = null;
			thinking = "";
			uiPrompts = 0;
			touch();
		},
		turnStart() {
			activity = null;
			thinking = "";
			touch();
		},
		assistantMessageStart() {
			activity = null;
			thinking = "";
			touch();
		},
		assistantEvent(event) {
			switch (event.type) {
				case "thinking_start":
					activity = "thinking";
					thinking = "";
					break;
				case "thinking_delta":
					activity = "thinking";
					thinking += event.delta ?? "";
					break;
				case "thinking_end":
					activity = "thinking";
					if (typeof event.content === "string") thinking = event.content;
					break;
				case "text_start":
				case "text_delta":
					activity = "writing";
					thinking = "";
					break;
				case "text_end":
					activity = "writing";
					break;
				case "toolcall_start":
				case "toolcall_delta":
					activity = "tool-call";
					thinking = "";
					break;
				case "toolcall_end":
					activity = "tool-call";
					break;
				default:
					return;
			}
			touch();
		},
		assistantMessageEnd() {
			activity = null;
			thinking = "";
			touch();
		},
		toolStart(event) {
			tools.set(event.toolCallId, event.toolName);
			touch();
		},
		toolEnd(event) {
			tools.delete(event.toolCallId);
			touch();
		},
		compactionStart() {
			compacting = true;
			touch();
		},
		compactionEnd() {
			compacting = false;
			touch();
		},
		uiPromptStart() {
			uiPrompts += 1;
			touch();
		},
		uiPromptEnd() {
			uiPrompts = Math.max(0, uiPrompts - 1);
			touch();
		},
		agentEnd() {
			activity = null;
			thinking = "";
			touch();
		},
		agentSettled() {
			// `agent_settled` is the final idle signal; `agent_end` may still be
			// followed by an automatic retry, and the sidecar should read `waiting`
			// across that backoff instead of disappearing.
			running = false;
			resetRun();
			compacting = false;
			removeFile();
		},
		state() {
			return currentState();
		},
	};
}
