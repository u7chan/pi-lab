import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import liveThinkingExtension, {
	createLiveThinkingController,
	FORMAT_VERSION,
	LIVE_PHASES,
	MAX_TEXT_CHARS,
	parseLiveThinking,
	serializeLiveThinking,
	sidecarPath,
	tailText,
} from "../.pi/extensions/live-thinking.ts";
import type { LiveThinkingSink } from "../src/live-thinking-core.ts";

const SESSION = "/agent/sessions/slug/2026-11-07T00-00-00-000Z_01a1.jsonl";

function createFakeSink() {
	const writes: Array<{ path: string; body: string }> = [];
	const clears: string[] = [];
	const sink: LiveThinkingSink = {
		write: (path, body) => {
			writes.push({ path, body });
		},
		clear: (path) => {
			clears.push(path);
		},
	};
	return {
		sink,
		writes,
		clears,
		last: () => JSON.parse(writes.at(-1)!.body) as Record<string, unknown>,
	};
}

function createClock() {
	const timers = new Map<number, { due: number; callback: () => void }>();
	let clock = 0;
	let nextId = 1;
	return {
		now: () => clock,
		scheduler: {
			setTimeout: (callback: () => void, delayMs: number) => {
				const id = nextId++;
				timers.set(id, { due: clock + delayMs, callback });
				return id;
			},
			clearTimeout: (handle: unknown) => {
				timers.delete(handle as number);
			},
		},
		advance: (ms: number) => {
			clock += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.due > clock) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		pending: () => timers.size,
	};
}

function setup() {
	const fakeSink = createFakeSink();
	const clock = createClock();
	const controller = createLiveThinkingController({
		sink: fakeSink.sink,
		now: clock.now,
		scheduler: clock.scheduler,
		throttleMs: 500,
		textLimit: 20,
	});
	controller.attachSession(SESSION);
	return { ...fakeSink, ...clock, controller };
}

describe("sidecar format", () => {
	test("builds the path next to the session file", () => {
		expect(sidecarPath(SESSION)).toBe(`${SESSION}.thinking.json`);
	});

	test("keeps only the newest code points and never splits a surrogate pair", () => {
		expect(tailText("abcdef", 3)).toBe("def");
		expect(tailText("a😀b", 2)).toBe("😀b");
		expect(tailText("abc", 0)).toBe("");
	});

	test("writing rules: text only while thinking, tool fields only while a tool runs", () => {
		const thinking = serializeLiveThinking(
			{ phase: "thinking", text: "reason", tool: null, tools: 0 },
			1,
		);
		expect(JSON.parse(thinking)).toEqual({ v: FORMAT_VERSION, at: 1, phase: "thinking", text: "reason" });
		const tool = serializeLiveThinking({ phase: "tool", text: "", tool: "bash", tools: 2 }, 2);
		expect(JSON.parse(tool)).toEqual({ v: FORMAT_VERSION, at: 2, phase: "tool", tool: "bash", tools: 2 });
		const writing = serializeLiveThinking({ phase: "writing", text: "", tool: null, tools: 0 }, 3);
		expect(JSON.parse(writing)).toEqual({ v: FORMAT_VERSION, at: 3, phase: "writing" });
	});

	test("a reader rejects unknown versions, unknown phases and misplaced fields", () => {
		expect(parseLiveThinking(serializeLiveThinking({ phase: "writing", text: "x", tool: null, tools: 0 }, 1))).toEqual({
			v: FORMAT_VERSION,
			at: 1,
			phase: "writing",
		});
		expect(parseLiveThinking(JSON.stringify({ v: 2, at: 1, phase: "thinking" }))).toBeNull();
		expect(parseLiveThinking(JSON.stringify({ v: 1, at: 1, phase: "nope" }))).toBeNull();
		expect(parseLiveThinking(JSON.stringify({ v: 1, at: "now", phase: "thinking" }))).toBeNull();
		expect(parseLiveThinking(JSON.stringify({ v: 1, at: 1, phase: "tool", text: "leak" }))).toEqual({
			v: FORMAT_VERSION,
			at: 1,
			phase: "tool",
		});
		expect(parseLiveThinking("not json")).toBeNull();
	});

	test("publishes every declared phase", () => {
		expect(LIVE_PHASES).toEqual([
			"waiting",
			"thinking",
			"writing",
			"tool-call",
			"tool",
			"compacting",
			"waiting-user",
		]);
		expect(MAX_TEXT_CHARS).toBeGreaterThan(0);
	});
});

describe("phase state machine", () => {
	test("a started run publishes waiting before the first delta", () => {
		const fake = setup();
		fake.controller.agentStart();
		expect(fake.last()).toEqual({ v: 1, at: 0, phase: "waiting" });
		expect(fake.writes.at(-1)!.path).toBe(sidecarPath(SESSION));
	});

	test("thinking deltas keep the tail and persist at the throttle interval", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.advance(600);
		fake.controller.assistantEvent({ type: "thinking_start" });
		expect(fake.last()).toEqual({ v: 1, at: 600, phase: "thinking" });

		// A new delta inside the interval waits for the throttle.
		fake.controller.assistantEvent({ type: "thinking_delta", delta: "abcdef" });
		expect(fake.last().text).toBeUndefined();
		expect(fake.pending()).toBe(1);
		fake.advance(500);
		expect(fake.last().text).toBe("abcdef");

		fake.advance(100);
		fake.controller.assistantEvent({ type: "thinking_delta", delta: "ghijklmnopqrstuvwxyz" });
		expect(fake.last().text).toBe("abcdef");
		fake.advance(400);
		expect(fake.last().phase).toBe("thinking");
		expect(fake.last().text).toBe("ghijklmnopqrstuvwxyz".slice(-20));
		expect(fake.pending()).toBe(0);
	});

	test("thinking_end takes the authoritative content", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "thinking_start" });
		fake.advance(600);
		fake.controller.assistantEvent({ type: "thinking_end", content: "final thought" });
		expect(fake.last()).toMatchObject({ phase: "thinking", text: "final thought" });
	});

	test("text, tool-call and tool phases replace the previous activity", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "text_start" });
		expect(fake.last()).toEqual({ v: 1, at: 0, phase: "writing" });
		fake.advance(600);
		fake.controller.assistantEvent({ type: "toolcall_start" });
		expect(fake.last()).toEqual({ v: 1, at: 600, phase: "tool-call" });
		fake.advance(600);
		fake.controller.assistantMessageEnd();
		fake.controller.toolStart({ toolCallId: "c1", toolName: "bash" });
		expect(fake.last()).toEqual({ v: 1, at: 1200, phase: "tool", tool: "bash", tools: 1 });
		fake.advance(600);
		fake.controller.toolEnd({ toolCallId: "c1" });
		expect(fake.last()).toEqual({ v: 1, at: 1800, phase: "waiting" });
	});

	test("parallel tools count up and report the most recently started one", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "toolcall_end" });
		fake.controller.assistantMessageEnd();
		fake.advance(600);
		fake.controller.toolStart({ toolCallId: "c1", toolName: "bash" });
		fake.controller.toolStart({ toolCallId: "c2", toolName: "read" });
		expect(fake.pending()).toBe(1);
		fake.advance(500);
		expect(fake.last()).toEqual({ v: 1, at: 1100, phase: "tool", tool: "read", tools: 2 });
		fake.advance(600);
		fake.controller.toolEnd({ toolCallId: "c2" });
		expect(fake.last()).toEqual({ v: 1, at: 1700, phase: "tool", tool: "bash", tools: 1 });
		fake.advance(600);
		fake.controller.toolEnd({ toolCallId: "c1" });
		expect(fake.last().phase).toBe("waiting");
	});

	test("message_end clears the activity before the tool batch runs", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "text_delta" });
		fake.controller.assistantMessageEnd();
		expect(fake.last().phase).toBe("waiting");
	});

	test("compaction outranks activity and tool state", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.toolStart({ toolCallId: "c1", toolName: "bash" });
		fake.controller.compactionStart();
		expect(fake.last().phase).toBe("compacting");
		fake.controller.toolEnd({ toolCallId: "c1" });
		expect(fake.last().phase).toBe("compacting");
		fake.controller.compactionEnd();
		expect(fake.last().phase).toBe("waiting");
	});

	test("a failed compaction releases the phase", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.compactionStart();
		fake.controller.compactionEnd();
		expect(fake.last().phase).toBe("waiting");
	});

	test("user prompts are coalesced and only reported during a run", () => {
		const fake = setup();
		fake.controller.uiPromptStart();
		expect(fake.writes).toHaveLength(0);

		fake.controller.agentStart();
		fake.controller.uiPromptStart();
		fake.controller.uiPromptStart();
		fake.controller.uiPromptEnd();
		expect(fake.last().phase).toBe("waiting-user");
		fake.controller.uiPromptEnd();
		expect(fake.last().phase).toBe("waiting");
	});
});

describe("lifecycle", () => {
	test("the sidecar survives agent_end (retry backoff) and is removed at agent_settled", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "thinking_delta", delta: "x" });
		fake.controller.assistantMessageEnd();
		fake.controller.agentEnd();
		expect(fake.last().phase).toBe("waiting");
		expect(fake.clears).toEqual([sidecarPath(SESSION)]);

		fake.controller.agentSettled();
		expect(fake.clears.at(-1)).toBe(sidecarPath(SESSION));
		expect(fake.last().phase).toBe("waiting");
	});

	test("switching the session removes the previous sidecar", () => {
		const fake = setup();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "thinking_delta", delta: "x" });
		const other = "/agent/sessions/slug/other.jsonl";
		fake.controller.attachSession(other);
		expect(fake.clears).toContain(sidecarPath(SESSION));
		expect(fake.clears).toContain(sidecarPath(other));
		fake.controller.agentStart();
		expect(fake.writes.at(-1)!.path).toBe(sidecarPath(other));
	});

	test("dispose removes the file and stops writing", () => {
		const fake = setup();
		fake.controller.agentStart();
		const writesBeforeDispose = fake.writes.length;
		fake.controller.dispose();
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "thinking_delta", delta: "x" });
		expect(fake.writes).toHaveLength(writesBeforeDispose);
		expect(fake.clears).toContain(sidecarPath(SESSION));
	});

	test("no session file means no writes", () => {
		const fake = createFakeSink();
		const controller = createLiveThinkingController({ sink: fake.sink });
		controller.attachSession(null);
		controller.agentStart();
		controller.assistantEvent({ type: "thinking_delta", delta: "x" });
		controller.agentSettled();
		expect(fake.writes).toHaveLength(0);
		expect(fake.clears).toHaveLength(0);
	});

	test("a detached session writes nothing", () => {
		const fake = setup();
		fake.controller.attachSession(null);
		const writesAfterDetach = fake.writes.length;
		fake.controller.agentStart();
		fake.controller.assistantEvent({ type: "thinking_delta", delta: "x" });
		fake.controller.agentSettled();
		expect(fake.writes).toHaveLength(writesAfterDetach);
		expect(fake.clears.at(-1)).toBe(sidecarPath(SESSION));
	});
});

describe("pi adapter", () => {
	function createFakePi() {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => {
				handlers.set(name, handler);
				return () => {};
			},
		};
		return {
			pi: pi as unknown as ExtensionAPI,
			handlers,
			fire: (name: string, event: any, ctx: any) => handlers.get(name)?.(event, ctx),
		};
	}

	test("registers every phase source", () => {
		const fake = createFakePi();
		liveThinkingExtension(fake.pi);
		expect([...fake.handlers.keys()].sort()).toEqual(
			[
				"agent_end",
				"agent_settled",
				"agent_start",
				"before_agent_start",
				"message_end",
				"message_start",
				"message_update",
				"session_before_compact",
				"session_compact",
				"session_compact_failed",
				"session_shutdown",
				"session_start",
				"tool_execution_end",
				"tool_execution_start",
				"turn_start",
				"ui_prompt_end",
				"ui_prompt_start",
			].sort(),
		);
	});

	test("writes and removes the sidecar next to the session file", () => {
		const directory = mkdtempSync(join(tmpdir(), "live-thinking-"));
		try {
			const sessionFile = join(directory, "session.jsonl");
			writeFileSync(sessionFile, "");
			const path = sidecarPath(sessionFile);
			const fake = createFakePi();
			liveThinkingExtension(fake.pi);
			const ctx = { sessionManager: { getSessionFile: () => sessionFile } };

			fake.fire("session_start", { type: "session_start" }, ctx);
			fake.fire("agent_start", { type: "agent_start" }, ctx);
			fake.fire(
				"message_update",
				{
					message: { role: "assistant" },
					assistantMessageEvent: { type: "thinking_delta", delta: "hello" },
				},
				ctx,
			);
			const body = JSON.parse(readFileSync(path, "utf8"));
			expect(body).toMatchObject({ v: 1, phase: "thinking", text: "hello" });

			fake.fire("agent_settled", { type: "agent_settled" }, ctx);
			expect(() => readFileSync(path)).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
