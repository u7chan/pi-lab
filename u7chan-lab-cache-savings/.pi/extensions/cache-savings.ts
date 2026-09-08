import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCacheSavingsController,
	computeCacheSavings,
	formatCacheSavingsStatus,
	formatCachedTokens,
	formatSavingsUsd,
	formatThemedCacheSavings,
	selectCostRates,
	STATUS_KEY,
} from "../../src/cache-savings-core.ts";

// Re-export the pure pieces so the PoC can be inspected/tested without a Pi
// runtime.  The extension itself only adapts them to Pi lifecycle events.
export {
	createCacheSavingsController,
	computeCacheSavings,
	formatCacheSavingsStatus,
	formatCachedTokens,
	formatSavingsUsd,
	formatThemedCacheSavings,
	selectCostRates,
	STATUS_KEY,
};

export default function cacheSavingsExtension(pi: ExtensionAPI): void {
	const controller = createCacheSavingsController();

	pi.on("session_start", (_event, ctx) => {
		controller.sessionStart(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		controller.messageEnd(event.message, ctx, ctx.model);
	});

	pi.on("model_select", (_event, ctx) => {
		controller.modelSelect(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.sessionShutdown(ctx);
	});
}
