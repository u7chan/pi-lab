import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildFooterLines,
	formatFooterTokens,
	type FooterRenderData,
	type MinimalFooterContext,
	type MinimalFooterTheme,
} from "../../src/minimal-footer-core.ts";

export { buildFooterLines, formatFooterTokens };
export type { FooterRenderData, MinimalFooterContext, MinimalFooterTheme };

/**
 * Replaces the built-in footer with a stats-free variant.
 *
 * The built-in footer always renders the token/cost stats block
 * (`↑input ↓output R… W… CH% $cost`).  This extension keeps the context
 * window usage, model info, and extension statuses (including the
 * cache-savings and cache-ttl segments), and drops the rest.
 *
 * Enabled by default in TUI sessions.  `/minimal-footer` toggles back to the
 * built-in footer and re-enables it.  Non-TUI modes are untouched.
 */
export default function minimalFooterExtension(pi: ExtensionAPI): void {
	let enabled = false;

	const apply = (ctx: MinimalFooterContext) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				invalidate() {},
				dispose() {
					unsubscribe?.();
				},
				render(width: number): string[] {
					return buildFooterLines({
						theme,
						footerData,
						model: ctx.model,
						thinkingLevel: ctx.thinkingLevel,
						cwd: ctx.sessionManager.getCwd(),
						home: process.env.HOME ?? process.env.USERPROFILE,
						sessionName: ctx.sessionManager.getSessionName(),
						contextUsage: ctx.getContextUsage(),
						width,
					});
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		enabled = true;
		apply(ctx as MinimalFooterContext);
	});

	pi.registerCommand("minimal-footer", {
		description: "Toggle the stats-free minimal footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				apply(ctx as MinimalFooterContext);
			} else {
				ctx.ui.setFooter(undefined);
			}
		},
	});
}
