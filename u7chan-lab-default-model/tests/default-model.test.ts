import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import defaultModelExtension, {
	describeDefaults,
	describeModel,
	LEVELS,
	matchModels,
	modelKey,
	parseTarget,
	rankModels,
	readSettingsFile,
	supportedLevels,
	thinkingLevelWarning,
	writeDefaultModel,
	type DefaultModelEnvironment,
} from "../.pi/extensions/default-model.ts";
import { readDefaults, settingsPath, type ModelLike } from "../src/default-model-core.ts";

const MODELS: ModelLike[] = [
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		provider: "opencode-go",
		reasoning: true,
		contextWindow: 1_000_000,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
	},
	{ id: "kimi-k3", name: "Kimi K3", provider: "opencode-go", reasoning: true, contextWindow: 256_000 },
	{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", provider: "zai", reasoning: true, contextWindow: 256_000 },
	{ id: "minimax-m2.7", name: "MiniMax-M2.7", provider: "opencode-go", reasoning: true },
	{ id: "minimax-m3", name: "MiniMax-M3", provider: "opencode-go", reasoning: true },
	{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai-codex", reasoning: false, contextWindow: 1_050_000 },
];

let workDir: string;
let settingsFile: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "default-model-test-"));
	settingsFile = join(workDir, "settings.json");
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function writeSettings(value: Record<string, unknown>): void {
	writeFileSync(settingsFile, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function createEnvironment(path: string = settingsFile): DefaultModelEnvironment {
	return {
		settingsPath: () => path,
		withFileMutationQueue: async (_filePath, fn) => fn(),
	};
}

interface FakePi {
	commands: Map<string, { handler(args: string, ctx: never): Promise<void> }>;
	tools: Map<string, { execute(...args: never[]): Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;
	sessionModel?: string;
	thinkingLevel?: string;
	/** Value `pi.setModel` resolves with; `false` simulates a provider without configured auth. */
	setModelResult: boolean;
	registerCommand(name: string, options: { handler(args: string, ctx: never): Promise<void> }): void;
	registerTool(definition: {
		name: string;
		execute(...args: never[]): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
	}): void;
	setModel(model: ModelLike): Promise<boolean>;
	setThinkingLevel(level: string): void;
}

function createPi(): FakePi {
	const pi: FakePi = {
		commands: new Map(),
		tools: new Map(),
		setModelResult: true,
		registerCommand(name, options) {
			pi.commands.set(name, options);
		},
		registerTool(definition) {
			pi.tools.set(definition.name, definition);
		},
		async setModel(model) {
			if (!pi.setModelResult) return false;
			pi.sessionModel = modelKey(model);
			return true;
		},
		setThinkingLevel(level) {
			pi.thinkingLevel = level;
		},
	};
	defaultModelExtension(pi as never, createEnvironment());
	return pi;
}

function createContext(models: ModelLike[] = MODELS, overrides: Record<string, unknown> = {}) {
	const notices: Array<{ message: string; type: string }> = [];
	const ctx = {
		mode: "print",
		hasUI: false,
		model: undefined,
		modelRegistry: { getAvailable: () => models, getAll: () => models },
		ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
		...overrides,
	};
	return { ctx, notices };
}

async function runCommand(pi: FakePi, args: string, ctx: unknown): Promise<void> {
	const command = pi.commands.get("dm");
	if (!command) throw new Error("/dm was not registered");
	await command.handler(args, ctx as never);
}

describe("parseTarget", () => {
	test("splits a known thinking level suffix", () => {
		expect(parseTarget("opencode-go/deepseek-v4.1-flash:max")).toEqual({
			query: "opencode-go/deepseek-v4.1-flash",
			level: "max",
		});
		expect(parseTarget("kimi-k3:off")).toEqual({ query: "kimi-k3", level: "off" });
	});

	test("keeps colons that are not levels", () => {
		expect(parseTarget("vendor:model")).toEqual({ query: "vendor:model" });
		expect(parseTarget("kimi-k3:highish")).toEqual({ query: "kimi-k3:highish" });
		expect(parseTarget("kimi-k3:")).toEqual({ query: "kimi-k3:" });
	});

	test("trims whitespace and keeps an empty query empty", () => {
		expect(parseTarget("  kimi-k3:high  ")).toEqual({ query: "kimi-k3", level: "high" });
		expect(parseTarget("   ")).toEqual({ query: "" });
	});
});

describe("supportedLevels", () => {
	test("returns every level for a reasoning model without a map", () => {
		expect(supportedLevels(MODELS[1])).toEqual([...LEVELS]);
	});

	test("drops levels the catalogue maps to null", () => {
		expect(supportedLevels(MODELS[0])).toEqual(["off", "high", "xhigh", "max"]);
	});

	test("keeps only off for a non-reasoning model", () => {
		expect(supportedLevels(MODELS[5])).toEqual(["off"]);
	});
});

describe("rankModels / matchModels", () => {
	test("scores exact keys, ids, and suffixes above substring matches", () => {
		const ranked = rankModels(MODELS, "minimax");
		expect(ranked.map(modelKey)).toEqual(["opencode-go/minimax-m2.7", "opencode-go/minimax-m3"]);

		expect(modelKey(matchModels(MODELS, "opencode-go/kimi-k3").direct!)).toBe("opencode-go/kimi-k3");
		// A bare id is still an unambiguous reference even though other ids contain it.
		expect(modelKey(matchModels(MODELS, "kimi-k3").direct!)).toBe("opencode-go/kimi-k3");
	});

	test("matches squashed and subsequence queries", () => {
		expect(rankModels(MODELS, "glm 5.3").map(modelKey)).toEqual(["zai/glm-5.3-flash"]);
		expect(rankModels(MODELS, "dv41f").map(modelKey)).toEqual(["opencode-go/deepseek-v4.1-flash"]);
	});

	test("returns no candidates when nothing matches", () => {
		expect(matchModels(MODELS, "zzzz").candidates).toEqual([]);
	});

	test("treats several substring matches as ambiguous", () => {
		const match = matchModels(MODELS, "minimax");
		expect(match.direct).toBeUndefined();
		expect(match.candidates).toHaveLength(2);
	});
});

describe("describeModel", () => {
	test("includes context window and reasoning only when known", () => {
		expect(describeModel(MODELS[0])).toBe("DeepSeek V4.1 Flash · 1000K ctx · reasoning");
		expect(describeModel(MODELS[4])).toBe("MiniMax-M3 · reasoning");
		expect(describeModel(MODELS[5])).toBe("GPT-5.6 Luna · 1050K ctx");
	});
});

describe("settings persistence", () => {
	test("reads a missing file as empty", () => {
		expect(readSettingsFile(join(workDir, "missing.json"))).toEqual({});
	});

	test("merges the model defaults without dropping unrelated keys", () => {
		writeSettings({ theme: "dark", packages: ["npm:pi-web-access"], defaultThinkingLevel: "max" });
		writeDefaultModel(settingsFile, MODELS[0], "high");

		expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toEqual({
			theme: "dark",
			packages: ["npm:pi-web-access"],
			defaultProvider: "opencode-go",
			defaultModel: "deepseek-v4.1-flash",
			defaultThinkingLevel: "high",
		});
		expect(existsSync(`${settingsFile}.${process.pid}.tmp`)).toBe(false);
	});

	test("keeps the saved thinking level when no level is given", () => {
		writeSettings({ defaultThinkingLevel: "max" });
		writeDefaultModel(settingsFile, MODELS[1]);
		expect(JSON.parse(readFileSync(settingsFile, "utf-8"))).toEqual({
			defaultProvider: "opencode-go",
			defaultModel: "kimi-k3",
			defaultThinkingLevel: "max",
		});
	});

	test("readDefaults ignores malformed values", () => {
		expect(readDefaults({ defaultProvider: 42, defaultModel: "kimi-k3", defaultThinkingLevel: "nope" })).toEqual({
			defaultProvider: undefined,
			defaultModel: "kimi-k3",
			defaultThinkingLevel: undefined,
		});
	});

	test("describeDefaults renders unset fields", () => {
		expect(describeDefaults({})).toBe("(unset) / (unset) (thinking: (unset))");
		expect(describeDefaults({ defaultProvider: "zai", defaultModel: "glm-5.3-flash", defaultThinkingLevel: "max" })).toBe(
			"zai / glm-5.3-flash (thinking: max)",
		);
	});

	test("settingsPath joins the agent directory", () => {
		expect(settingsPath("/tmp/pi-agent")).toBe("/tmp/pi-agent/settings.json");
	});
});

describe("thinkingLevelWarning", () => {
	test("warns when the saved level is unsupported on the selected model", () => {
		expect(thinkingLevelWarning(MODELS[0], { defaultThinkingLevel: "minimal" })).toBe(
			"defaultThinkingLevel=minimal is not supported by opencode-go/deepseek-v4.1-flash (supported: off, high, xhigh, max)",
		);
	});

	test("stays quiet when supported, unset, or irrelevant", () => {
		expect(thinkingLevelWarning(MODELS[0], { defaultThinkingLevel: "max" })).toBeUndefined();
		expect(thinkingLevelWarning(MODELS[0], {})).toBeUndefined();
		expect(thinkingLevelWarning(MODELS[5], { defaultThinkingLevel: "max" })).toBeUndefined();
	});
});

describe("default model extension", () => {
	test("registers the commands and the set_default_model tool", () => {
		const pi = createPi();
		expect([...pi.commands.keys()]).toEqual(["dm", "default-model"]);
		expect([...pi.tools.keys()]).toEqual(["set_default_model"]);
	});

	test("/dm show reports the current defaults", async () => {
		const pi = createPi();
		writeSettings({ defaultProvider: "zai", defaultModel: "glm-5.3-flash", defaultThinkingLevel: "max" });
		const { ctx, notices } = createContext();

		await runCommand(pi, "show", ctx);

		expect(notices).toEqual([
			{ message: "Default model: zai / glm-5.3-flash (thinking: max)", type: "info" },
		]);
	});

	test("/dm applies an exact reference and saves it as the default", async () => {
		const pi = createPi();
		const { ctx, notices } = createContext();

		await runCommand(pi, "opencode-go/deepseek-v4.1-flash:max", ctx);

		expect(pi.sessionModel).toBe("opencode-go/deepseek-v4.1-flash");
		expect(pi.thinkingLevel).toBe("max");
		expect(readSettingsFile(settingsFile)).toMatchObject({
			defaultProvider: "opencode-go",
			defaultModel: "deepseek-v4.1-flash",
			defaultThinkingLevel: "max",
		});
		expect(notices.at(-1)?.type).toBe("info");
	});

	test("/dm still saves the default when Pi refuses the session switch", async () => {
		const pi = createPi();
		pi.setModelResult = false;
		const { ctx, notices } = createContext();

		await runCommand(pi, "kimi-k3", ctx);

		expect(readSettingsFile(settingsFile)).toMatchObject({ defaultModel: "kimi-k3" });
		expect(notices.at(-1)?.type).toBe("warning");
		expect(notices.at(-1)?.message).toContain("no configured auth");
	});

	test("/dm rejects an unsupported thinking level without writing settings", async () => {
		const pi = createPi();
		writeSettings({ theme: "dark" });
		const { ctx, notices } = createContext();

		await runCommand(pi, "opencode-go/deepseek-v4.1-flash:minimal", ctx);

		expect(notices.at(-1)).toEqual({
			message:
				'opencode-go/deepseek-v4.1-flash does not support thinking level "minimal" (supported: off, high, xhigh, max)',
			type: "error",
		});
		expect(readSettingsFile(settingsFile)).toEqual({ theme: "dark" });
	});

	test("/dm reports ambiguous and unknown queries", async () => {
		const pi = createPi();
		const ambiguous = createContext();
		await runCommand(pi, "minimax", ambiguous.ctx);
		expect(ambiguous.notices.at(-1)?.message).toBe(
			'"minimax" is ambiguous: opencode-go/minimax-m2.7, opencode-go/minimax-m3',
		);

		const unknown = createContext();
		await runCommand(pi, "zzzz", unknown.ctx);
		expect(unknown.notices.at(-1)?.message).toBe('No model matches "zzzz"');
	});

	test("/dm hints when the provider has no configured auth", async () => {
		const pi = createPi();
		const { ctx, notices } = createContext([MODELS[2]], {
			// Only zai is authenticated; kimi-k3 is in the catalogue but not selectable.
			modelRegistry: { getAvailable: () => [MODELS[2]], getAll: () => MODELS },
		});

		await runCommand(pi, "kimi-k3", ctx);

		expect(notices.at(-1)?.message).toBe(
			'No model matches "kimi-k3" (the provider has no configured auth)',
		);
	});

	test("/dm without arguments needs a UI", async () => {
		const pi = createPi();
		const { ctx, notices } = createContext();

		await runCommand(pi, "", ctx);

		expect(notices.at(-1)).toEqual({
			message: "usage: /dm [provider/]model[:level]  |  /dm show",
			type: "error",
		});
	});

	test("/dm without arguments uses the select dialog outside TUI mode", async () => {
		const pi = createPi();
		const selected: string[] = [];
		const { ctx, notices } = createContext(MODELS, {
			mode: "rpc",
			hasUI: true,
			ui: {
				notify: (message: string, type: string) => notices.push({ message, type }),
				select: async (title: string, options: string[]) => {
					selected.push(title);
					return options[0];
				},
			},
		});

		await runCommand(pi, "", ctx);

		expect(selected[0]?.startsWith("Select the startup default model")).toBe(true);
		expect(notices.at(-1)?.message?.startsWith("Saved opencode-go/deepseek-v4.1-flash")).toBe(true);
	});

	test("set_default_model saves the default without switching the session", async () => {
		const pi = createPi();
		const { ctx } = createContext();

		const result = await pi.tools.get("set_default_model")!.execute(
			"call-1",
			{ model: "kimi-k3", thinkingLevel: "high" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("Saved opencode-go/kimi-k3 with thinking level \"high\"");
		expect(pi.sessionModel).toBeUndefined();
		expect(readSettingsFile(settingsFile)).toMatchObject({
			defaultProvider: "opencode-go",
			defaultModel: "kimi-k3",
			defaultThinkingLevel: "high",
		});
	});

	test("set_default_model can also switch the current session", async () => {
		const pi = createPi();
		const { ctx } = createContext(MODELS, { model: MODELS[1] });

		const result = await pi.tools.get("set_default_model")!.execute(
			"call-2",
			{ provider: "zai", model: "glm-5.3-flash", thinkingLevel: "max", applyToSession: true } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);

		expect(result.isError).toBeFalsy();
		expect(pi.sessionModel).toBe("zai/glm-5.3-flash");
		expect(pi.thinkingLevel).toBe("max");
		expect(result.content[0].text).toContain("applied to the current session");
	});

	test("set_default_model reports unknown models and unsupported levels", async () => {
		const pi = createPi();
		const { ctx } = createContext();
		const tool = pi.tools.get("set_default_model")!;

		const unknown = await tool.execute(
			"call-3",
			{ model: "zzzz" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toBe('No model matches "zzzz" among the authenticated models');

		const unsupported = await tool.execute(
			"call-4",
			{ model: "deepseek-v4.1-flash", thinkingLevel: "low" } as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		expect(unsupported.isError).toBe(true);
		expect(unsupported.content[0].text).toContain('does not support thinking level "low"');
	});
});
