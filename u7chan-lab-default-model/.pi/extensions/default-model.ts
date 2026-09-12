import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";
import { join } from "node:path";
import type { TSchema } from "typebox";
import {
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
	type Level,
	type ModelLike,
} from "../../src/default-model-core.ts";

// Re-export the pure pieces so the PoC can be inspected/tested without a Pi
// runtime.  The extension itself only adapts them to Pi commands and tools.
export {
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
};
export type { Level, ModelLike };

const USAGE = "usage: /dm [provider/]model[:level]  |  /dm show";

/**
 * Plain JSON Schema instead of `Type.Object`.  Pi validates non-TypeBox
 * schemas through its JSON Schema coercion path, and this keeps the adapter
 * importable from `bun test` without node_modules (the other PoCs rely on the
 * same property for their Pi-package imports).
 */
const TOOL_PARAMETERS: TSchema = {
	type: "object",
	properties: {
		model: { type: "string", description: "Model id, e.g. deepseek-v4.1-flash" },
		provider: { type: "string", description: "Provider id, e.g. opencode-go" },
		thinkingLevel: {
			type: "string",
			enum: [...LEVELS],
			description: "Also save this thinking level as the startup default",
		},
		applyToSession: {
			type: "boolean",
			description: "Also switch the current session (default: false, save only)",
		},
	},
	required: ["model"],
};

interface ToolParams {
	model: string;
	provider?: string;
	thinkingLevel?: Level;
	applyToSession?: boolean;
}

/**
 * Runtime pieces that need Pi modules.  Injecting them keeps the adapter
 * importable from `bun test` (the PoCs have no node_modules, so any static
 * runtime import of a Pi package would break the offline tests).
 */
export interface DefaultModelEnvironment {
	settingsPath(): string;
	withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
}

async function loadEnvironment(): Promise<DefaultModelEnvironment> {
	const pkg = await import("@earendil-works/pi-coding-agent");
	return {
		settingsPath: () => join(pkg.getAgentDir(), "settings.json"),
		withFileMutationQueue: pkg.withFileMutationQueue,
	};
}

interface ApplyResult {
	ok: boolean;
	message: string;
	/** False when the provider has no configured auth and Pi refused the session switch. */
	applied: boolean;
}

export default function defaultModelExtension(pi: ExtensionAPI, environment?: DefaultModelEnvironment): void {
	let loadedEnvironment: Promise<DefaultModelEnvironment> | undefined;
	const environmentPromise = (): Promise<DefaultModelEnvironment> =>
		environment ? Promise.resolve(environment) : (loadedEnvironment ??= loadEnvironment());

	const readSettings = async (): Promise<Record<string, unknown>> =>
		readSettingsFile((await environmentPromise()).settingsPath());

	/** Read-modify-write settings.json behind Pi's per-file mutation queue. */
	const persistDefaults = async (model: ModelLike, level?: Level): Promise<void> => {
		const { settingsPath, withFileMutationQueue } = await environmentPromise();
		const path = settingsPath();
		await withFileMutationQueue(path, async () => writeDefaultModel(path, model, level));
	};

	const applyModel = async (ctx: ExtensionContext, model: Model<Api>, level?: Level): Promise<ApplyResult> => {
		const supported = supportedLevels(model);
		if (level && !supported.includes(level)) {
			return {
				ok: false,
				applied: false,
				message: `${modelKey(model)} does not support thinking level "${level}" (supported: ${supported.join(", ")})`,
			};
		}

		await persistDefaults(model, level);

		const applied = await pi.setModel(model);
		if (level) pi.setThinkingLevel(level);

		const notes = [`Saved ${modelKey(model)}${level ? `:${level}` : ""} as the startup default`];
		notes.push(
			applied
				? "applied to the current session"
				: "the current session keeps its model (the provider has no configured auth)",
		);

		const warning = thinkingLevelWarning(model, await readSettings());
		if (warning) notes.push(warning);

		return { ok: true, applied, message: notes.join(" / ") };
	};

	const candidateModels = (ctx: ExtensionContext): Model<Api>[] => {
		const available = ctx.modelRegistry.getAvailable();
		return available.length > 0 ? available : ctx.modelRegistry.getAll();
	};

	const pickModel = async (
		ctx: ExtensionContext,
		models: Model<Api>[],
		title: string,
	): Promise<Model<Api> | undefined> => {
		if (models.length === 0) return undefined;

		// RPC mode has `select` but no custom components.
		if (ctx.mode !== "tui") {
			const choice = await ctx.ui.select(
				`${title}  (current: ${describeDefaults(await readSettings())})`,
				models.map(modelKey),
			);
			if (!choice) return undefined;
			return models.find((model) => modelKey(model) === choice);
		}

		const items: SelectItem[] = models.map((model) => ({
			value: modelKey(model),
			label: modelKey(model),
			description: describeModel(model),
		}));
		const [{ Container, SelectList, Text }, { DynamicBorder }] = await Promise.all([
			import("@earendil-works/pi-tui"),
			import("@earendil-works/pi-coding-agent"),
		]);
		const current = describeDefaults(await readSettings());

		const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`${title}  —  current: ${current}`)), 1, 0));

			const list = new SelectList(items, Math.min(items.length, 14), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Text(theme.fg("dim", "type to filter • ↑↓ • enter select • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return undefined;
		return models.find((model) => modelKey(model) === selected);
	};

	const runCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		const raw = args.trim();

		if (raw === "show" || raw === "list" || raw === "status") {
			ctx.ui.notify(`Default model: ${describeDefaults(await readSettings())}`, "info");
			return;
		}

		const { query, level } = parseTarget(raw);
		let picked: Model<Api> | undefined;

		if (!query) {
			if (!ctx.hasUI) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			picked = await pickModel(ctx, candidateModels(ctx), "Select the startup default model");
			if (!picked) return;
		} else {
			const match = matchModels(candidateModels(ctx), query);
			if (match.candidates.length === 0) {
				const unauthenticated = matchModels(ctx.modelRegistry.getAll(), query).candidates.length > 0;
				ctx.ui.notify(
					`No model matches "${query}"${unauthenticated ? " (the provider has no configured auth)" : ""}`,
					"error",
				);
				return;
			}
			if (match.direct) {
				picked = match.direct;
			} else if (!ctx.hasUI) {
				ctx.ui.notify(
					`"${query}" is ambiguous: ${match.candidates.slice(0, 5).map(modelKey).join(", ")}`,
					"error",
				);
				return;
			} else {
				picked = await pickModel(ctx, match.candidates.slice(0, 30), `Select the default model for "${query}"`);
				if (!picked) return;
			}
		}

		const result = await applyModel(ctx, picked, level);
		ctx.ui.notify(result.message, result.ok ? (result.applied ? "info" : "warning") : "error");
	};

	pi.registerCommand("dm", {
		description: "Change the startup default model (no argument opens a picker, :level also saves the thinking level)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			// Model ids are not available without a context; only complete the level suffix.
			if (!prefix.startsWith(":")) return null;
			const items = LEVELS.map((value) => ({ value: `:${value}`, label: `:${value}` }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await runCommand(args, ctx);
		},
	});

	pi.registerCommand("default-model", {
		description: "Change the startup default model (alias of /dm)",
		handler: async (args, ctx) => {
			await runCommand(args, ctx);
		},
	});

	pi.registerTool({
		name: "set_default_model",
		label: "Set Default Model",
		description:
			"Change Pi's startup default model (settings.json defaultProvider/defaultModel), optionally with a thinking level.",
		promptSnippet: "Change Pi's startup default model (and optionally thinking level)",
		promptGuidelines: [
			"Use set_default_model when the user asks to change pi's default/startup model, including requests like 'デフォルトモデルを〜にして'.",
		],
		parameters: TOOL_PARAMETERS,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as ToolParams;
			const models = candidateModels(ctx);
			const query = params.provider ? `${params.provider}/${params.model}` : params.model;
			const matched =
				models.find(
					(model) => model.id === params.model && (!params.provider || model.provider === params.provider),
				) ??
				matchModels(models, query).direct ??
				rankModels(models, query)[0];

			if (!matched) {
				return {
					content: [{ type: "text", text: `No model matches "${query}" among the authenticated models` }],
					isError: true,
				};
			}

			const level = params.thinkingLevel;
			if (level && !supportedLevels(matched).includes(level)) {
				return {
					content: [
						{
							type: "text",
							text: `${modelKey(matched)} does not support thinking level "${level}" (supported: ${supportedLevels(matched).join(", ")})`,
						},
					],
					isError: true,
				};
			}

			if (params.applyToSession) {
				const result = await applyModel(ctx, matched, level);
				return {
					content: [{ type: "text", text: result.message }],
					isError: !result.ok,
				};
			}

			await persistDefaults(matched, level);
			const current = ctx.model ? modelKey(ctx.model) : "unknown";
			const saved = level ? ` with thinking level "${level}"` : "";
			return {
				content: [
					{
						type: "text",
						text: `Saved ${modelKey(matched)}${saved} as the startup default. The current session (${current}) keeps its model.`,
					},
				],
			};
		},
	});
}
