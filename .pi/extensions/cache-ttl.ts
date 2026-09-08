import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCacheTtlController,
	inspectPromptCacheTtl,
	formatCacheStatus,
	nextCacheUpdateDelayMs,
	STATUS_KEY,
	SHORT_CACHE_TTL_MS,
} from "../../src/cache-ttl-core.ts";

// Re-export the pure pieces so the PoC can be inspected/tested without a Pi
// runtime.  The extension itself only adapts them to Pi lifecycle events.
export {
	createCacheTtlController,
	formatCacheStatus,
	inspectPromptCacheTtl,
	nextCacheUpdateDelayMs,
	SHORT_CACHE_TTL_MS,
	STATUS_KEY,
};

export default function cacheTtlExtension(pi: ExtensionAPI): void {
	const controller = createCacheTtlController();

	pi.on("session_start", (_event, ctx) => {
		controller.sessionStart(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		controller.beforeProviderRequest(event.payload, ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		controller.modelSelect(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.sessionShutdown(ctx);
	});
}
