/**
 * Adapter-level tests for the `input` hook with a fake Pi host.
 *
 * These cover the wiring the unit tests cannot: which event publishes the skill
 * roots, what the commands do to the session mode, and the fail-open path when
 * the key is missing.  Nothing here touches the network: the gate stops before
 * the request, and the key source points at an unset variable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import skillDispatchExtension from "../.pi/extensions/skill-dispatch.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface FakeHost {
	on(event: string, handler: Handler): void;
	registerCommand(name: string, definition: { description: string; handler: Handler }): void;
}

const SKILL_MD = [
	"---",
	"name: api-design",
	"description: HTTP/Web APIを設計・レビューするときに使う。",
	"---",
	"",
	"# API Design",
	"",
	"本文。",
	"",
].join("\n");

function createHost(): { host: FakeHost; handlers: Map<string, Handler>; commands: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	return {
		handlers,
		commands,
		host: {
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerCommand(name, definition) {
				commands.set(name, definition.handler);
			},
		},
	};
}

function createContext(cwd: string): {
	ctx: unknown;
	notices: string[];
	statuses: string[];
} {
	const notices: string[] = [];
	const statuses: string[] = [];
	return {
		notices,
		statuses,
		ctx: {
			cwd,
			hasUI: true,
			ui: {
				setStatus(_key: string, value: string) {
					statuses.push(value);
				},
				notify(message: string) {
					notices.push(message);
				},
				confirm: async () => true,
			},
		},
	};
}

describe("skill dispatch adapter", () => {
	let root: string;
	let skillRoot: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "skill-dispatch-adapter-"));
		skillRoot = join(root, "skills");
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(join(skillRoot, "api-design"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(skillRoot, "api-design", "SKILL.md"), SKILL_MD);
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.SKILL_DISPATCH_TEST_KEY;
		rmSync(root, { recursive: true, force: true });
	});

	const writeConfig = (overrides: Record<string, unknown> = {}): void => {
		const dir = join(agentDir, "skill-dispatch-poc");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify(
				{
					enabled: true,
					skillRoots: [skillRoot],
					projectAllowlist: [cwd],
					typesafe: {
						apiKeySource: "env:SKILL_DISPATCH_TEST_KEY",
						model: "jev-latest",
						timeoutMs: 200,
					},
					...overrides,
				},
				null,
				2,
			),
		);
	};

	const start = (): { handlers: Map<string, Handler>; commands: Map<string, Handler> } => {
		const { host, handlers, commands } = createHost();
		skillDispatchExtension(host as never);
		return { handlers, commands };
	};

	test("publishes the skill roots only when enabled and in scope", async () => {
		writeConfig();
		const inScope = start();
		const ctx = createContext(cwd).ctx;
		await inScope.handlers.get("session_start")!({ reason: "startup" }, ctx);
		expect(await inScope.handlers.get("resources_discover")!({ reason: "startup" }, ctx)).toEqual({
			skillPaths: [skillRoot],
		});

		writeConfig({ enabled: false });
		const disabled = start();
		await disabled.handlers.get("session_start")!({ reason: "startup" }, ctx);
		expect(await disabled.handlers.get("resources_discover")!({ reason: "startup" }, ctx)).toBeUndefined();

		writeConfig();
		const outOfScope = start();
		const other = createContext(join(root, "elsewhere")).ctx;
		await outOfScope.handlers.get("session_start")!({ reason: "startup" }, other);
		expect(await outOfScope.handlers.get("resources_discover")!({ reason: "startup" }, other)).toBeUndefined();
	});

	test("refuses live mode when Pi never published the roots", async () => {
		// Enabled after startup, so Pi has no `/skill:<name>` to expand.
		writeConfig({ enabled: false, projectAllowlist: [] });
		const { handlers, commands } = start();
		const { ctx, notices } = createContext(cwd);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);

		await commands.get("skill-dispatch")!("on", ctx);
		await commands.get("skill-dispatch")!("live", ctx);

		expect(notices.join("\n")).toContain("cannot go live");
		expect(notices.join("\n")).toContain("then /new");
	});

	test("passes the prompt through when the key is missing", async () => {
		writeConfig();
		const { handlers, commands } = start();
		const { ctx, statuses } = createContext(cwd);
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		await handlers.get("resources_discover")!({ reason: "startup" }, ctx);
		await commands.get("skill-dispatch")!("live", ctx);
		await handlers.get("input")!({ source: "interactive", text: "既存APIのバージョニング方針を決めたい" }, ctx);

		// Published roots get past the send gates, and the missing key still
		// fails open instead of sending or rewriting the prompt.
		expect(statuses.at(-1)).toStartWith("skill: blocked (environment variable SKILL_DISPATCH_TEST_KEY");
	});

	test("keeps the transformed prompt out of scope", async () => {
		writeConfig();
		const { handlers } = start();
		const { ctx, statuses } = createContext(join(root, "elsewhere"));
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
		await handlers.get("resources_discover")!({ reason: "startup" }, ctx);
		await handlers.get("input")!({ source: "interactive", text: "既存APIのバージョニング方針を決めたい" }, ctx);

		expect(statuses.at(-1)).toBe("skill: blocked (cwd is outside projectAllowlist)");
	});
});
