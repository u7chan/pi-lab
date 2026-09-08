import { describe, expect, test } from "bun:test";
import minimalFooterExtension, {
	buildFooterLines,
	formatFooterTokens,
	type FooterRenderData,
	type MinimalFooterContext,
	type MinimalFooterTheme,
} from "../.pi/extensions/minimal-footer.ts";

const theme: MinimalFooterTheme = {
	fg(color, text) {
		return `<${color}>${text}</${color}>`;
	},
};

function createFooterData(overrides: Partial<FooterRenderData> = {}): FooterRenderData {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["cache-ttl", "CACHE hit"]]),
		getAvailableProviderCount: () => 2,
		onBranchChange: () => () => {},
		...overrides,
	};
}

function createContext(overrides: Partial<MinimalFooterContext> = {}): MinimalFooterContext {
	const setFooterCalls: Array<unknown> = [];
	const context: MinimalFooterContext & { setFooterCalls: Array<unknown> } = {
		mode: "tui",
		hasUI: true,
		model: { id: "glm-5.3-flash", provider: "zai", reasoning: true, contextWindow: 256_000 },
		thinkingLevel: "max",
		sessionManager: {
			getCwd: () => "/home/u7dev/workspace/lab/pi-lab",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 5_000, contextWindow: 256_000, percent: 2.0 }),
		ui: {
			setFooter(factory) {
				setFooterCalls.push(factory);
			},
		},
		setFooterCalls,
		...overrides,
	};
	return context;
}

describe("formatFooterTokens", () => {
	test("matches the built-in footer's compaction", () => {
		expect(formatFooterTokens(999)).toBe("999");
		expect(formatFooterTokens(1_000)).toBe("1.0k");
		expect(formatFooterTokens(9_999)).toBe("10.0k");
		expect(formatFooterTokens(10_000)).toBe("10k");
		expect(formatFooterTokens(256_000)).toBe("256k");
		expect(formatFooterTokens(999_999)).toBe("1000k");
		expect(formatFooterTokens(1_000_000)).toBe("1.0M");
		expect(formatFooterTokens(10_000_000)).toBe("10M");
	});
});

describe("buildFooterLines", () => {
	test("renders cwd, context window, model, and statuses without token/cost stats", () => {
		const lines = buildFooterLines({
			theme,
			footerData: createFooterData({
				getExtensionStatuses: () =>
					new Map([
						["cache-ttl", "CACHE hit"],
						["cache-savings", "SAVED 6.8k tok ~$0.0010"],
					]),
			}),
			model: { id: "glm-5.3-flash", provider: "zai", reasoning: true },
			thinkingLevel: "max",
			cwd: "/home/u7dev/workspace/lab/pi-lab",
			home: "/home/u7dev",
			contextUsage: { tokens: 5_000, contextWindow: 256_000, percent: 2.0 },
			width: 120,
		});

		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("<dim>~/workspace/lab/pi-lab (main)</dim>");
		// Context window stays, token/cost stats are gone.
		expect(lines[1]).toContain("<dim>2.0%/256k</dim>");
		expect(lines[1]).toContain("<dim>(zai) glm-5.3-flash • max</dim>");
		expect(lines[1]).not.toMatch(/[↑↓]|R\d|CH|\$/);
		expect(lines[1]).toMatch(/\S {2,}\S/); // left and right are padded apart
		// Statuses sorted alphabetically by key.
		expect(lines[2]).toBe("SAVED 6.8k tok ~$0.0010 CACHE hit");
	});

	test("uses the fallback and dim colour when context usage is unknown", () => {
		const lines = buildFooterLines({
			theme,
			footerData: createFooterData(),
			model: { id: "glm-5.3-flash" },
			cwd: "/tmp",
			contextUsage: { tokens: null, contextWindow: 256_000, percent: null },
			width: 80,
		});
		expect(lines[1]).toContain("<dim>?/256k</dim>");
	});

	test("colours the context percentage like the built-in thresholds", () => {
		const render = (percent: number) =>
			buildFooterLines({
				theme,
				footerData: createFooterData(),
				cwd: "/tmp",
				contextUsage: { tokens: 1, contextWindow: 100, percent },
				width: 80,
			})[1];

		expect(render(91.0)).toContain("<error>91.0%/100</error>");
		expect(render(75.0)).toContain("<warning>75.0%/100</warning>");
		expect(render(70.0)).toContain("<dim>70.0%/100</dim>");
	});

	test("hides the provider prefix when only one provider is available", () => {
		const lines = buildFooterLines({
			theme,
			footerData: createFooterData({ getAvailableProviderCount: () => 1 }),
			model: { id: "glm-5.3-flash", provider: "zai", reasoning: false },
			cwd: "/tmp",
			contextUsage: { tokens: 1, contextWindow: 256_000, percent: 1 },
			width: 80,
		});
		expect(lines[1]).toContain("glm-5.3-flash");
		expect(lines[1]).not.toContain("(zai)");
		expect(lines[1]).not.toContain("•");
	});

	test("appends the session name and omits a missing branch", () => {
		const lines = buildFooterLines({
			theme,
			footerData: createFooterData({ getGitBranch: () => null }),
			cwd: "/home/u7dev/lab",
			home: "/home/u7dev",
			sessionName: "footer experiments",
			width: 120,
		});
		expect(lines[0]).toBe("<dim>~/lab • footer experiments</dim>");
	});

	test("appends no status line when there are no statuses", () => {
		const lines = buildFooterLines({
			theme,
			footerData: createFooterData({ getExtensionStatuses: () => new Map() }),
			cwd: "/tmp",
			width: 80,
		});
		expect(lines).toHaveLength(2);
	});

	test("truncates long status lines while keeping colour sequences", () => {
		const colored = "\x1b[38;2;138;190;183mSAVED\x1b[39m\x1b[38;2;102;102;102m 6.8k tok ~$0.0010\x1b[39m";
		const lines = buildFooterLines({
			theme,
			footerData: createFooterData({ getExtensionStatuses: () => new Map([["cache-savings", colored]]) }),
			cwd: "/tmp",
			width: 24,
		});
		const visible = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
		expect(visible(lines[2]!)).toBeLessThanOrEqual(24);
		expect(lines[2]).toContain("SAVED");
	});
});

describe("extension adapter", () => {
	interface FakePi {
		handlers: Map<string, (event: never, ctx: MinimalFooterContext) => void>;
		commands: Map<string, { description: string; handler: (args: string, ctx: MinimalFooterContext) => Promise<void> }>;
	}

	function createPi(): FakePi & { on(event: string, handler: never): void; registerCommand(name: string, cmd: never): void } {
		const handlers = new Map();
		const commands = new Map();
		return {
			handlers,
			commands,
			on(event: string, handler: never) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, cmd: never) {
				commands.set(name, cmd);
			},
		} as never;
	}

	function captureFooter(context: MinimalFooterContext): Array<unknown> {
		return (context as MinimalFooterContext & { setFooterCalls: Array<unknown> }).setFooterCalls;
	}

	test("replaces the footer on session start in TUI mode and renders through the factory", () => {
		const pi = createPi();
		minimalFooterExtension(pi as never);

		expect(Array.from(pi.handlers.keys())).toEqual(["session_start"]);
		expect(pi.commands.has("minimal-footer")).toBe(true);

		const ctx = createContext();
		pi.handlers.get("session_start")!(undefined as never, ctx);
		expect(captureFooter(ctx)).toHaveLength(1);

		// Drive the factory the way the TUI would.
		const factory = captureFooter(ctx)[0] as (
			tui: { requestRender(): void },
			theme: MinimalFooterTheme,
			footerData: FooterRenderData,
		) => { render(width: number): string[]; dispose?(): void };
		let renders = 0;
		const component = factory(
			{ requestRender: () => renders++ },
			theme,
			createFooterData(),
		);
		const lines = component.render(120);
		expect(lines[0]).toContain("(main)");
		expect(lines[1]).toContain("2.0%/256k");
		expect(component.dispose).toBeTypeOf("function");
		void renders;
	});

	test("does not touch the footer outside TUI mode", () => {
		const pi = createPi();
		minimalFooterExtension(pi as never);
		const ctx = createContext({ mode: "rpc" });
		pi.handlers.get("session_start")!(undefined as never, ctx);
		expect(captureFooter(ctx)).toHaveLength(0);
	});

	test("toggles back to the built-in footer and re-enables", async () => {
		const pi = createPi();
		minimalFooterExtension(pi as never);
		const ctx = createContext();
		pi.handlers.get("session_start")!(undefined as never, ctx);
		expect(captureFooter(ctx)).toHaveLength(1);

		const command = pi.commands.get("minimal-footer")!;
		await command.handler("", ctx);
		expect(captureFooter(ctx).at(-1)).toBeUndefined();

		await command.handler("", ctx);
		expect(captureFooter(ctx)).toHaveLength(3);
		expect(typeof captureFooter(ctx).at(-1)).toBe("function");
	});
});
