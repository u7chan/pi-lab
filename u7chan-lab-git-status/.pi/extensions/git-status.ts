import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createGitStatusController,
	STATUS_KEY,
	type GitStatusController,
	type GitStatusUi,
} from "../../src/git-status-core.ts";

export {
	createGitStatusController,
	DEFAULT_DEBOUNCE_MS,
	DEFAULT_PR_RETRY_MS,
	formatGitStatusText,
	normalizeBranchName,
	osc8Link,
	parseGitRemote,
	parsePrViewJson,
	selectRemoteUrl,
	STATUS_KEY,
} from "../../src/git-status-core.ts";
export type {
	ExecResultLike,
	GitStatusController,
	GitStatusExec,
	GitStatusScheduler,
	GitStatusTextInput,
	GitStatusTheme,
	GitStatusTimer,
	GitStatusUi,
	PrInfo,
	RemoteInfo,
} from "../../src/git-status-core.ts";

/**
 * Adds the remote repository and current-branch PR as footer links.
 *
 * The segment reads `u7chan/pi-lab PR #12`: the repository path links to the
 * remote root and the PR number links to the pull request that `gh pr view`
 * resolves from the current branch.  The built-in cwd/branch line, the token
 * stats, and the other extension statuses are untouched.
 *
 * Refreshes on session start, after `bash`/`powershell` tools, and after every
 * settled turn.  Everything is best-effort: no web remote or no PR drops the
 * part instead of showing an error, and non-TUI modes are untouched.
 */
export default function gitStatusExtension(pi: ExtensionAPI): void {
	let controller: GitStatusController | undefined;

	const createUi = (ctx: ExtensionContext, hyperlinks: boolean): GitStatusUi => ({
		hasUI: ctx.hasUI,
		cwd: ctx.cwd,
		hyperlinks,
		theme: ctx.ui.theme,
		setStatus: (key, text) => ctx.ui.setStatus(key, text),
	});

	pi.on("session_start", async (_event, ctx) => {
		controller?.dispose();
		controller = undefined;
		if (!ctx.hasUI) return;

		controller = createGitStatusController({
			exec: (command, args, options) => pi.exec(command, args, options),
			ui: createUi(ctx, await detectHyperlinkSupport()),
		});
		await controller.refresh();
	});

	// Branch switches and `gh pr create` go through shell tools; re-detect once
	// the command finished.  `agent_settled` also covers user `!` commands,
	// which emit `user_bash` before they actually run.
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash" || event.toolName === "powershell") {
			controller?.scheduleRefresh();
		}
	});

	pi.on("agent_settled", () => {
		controller?.scheduleRefresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller?.dispose();
		controller = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

/**
 * Ask pi-tui whether the terminal renders OSC 8 links.
 *
 * The dynamic import keeps this module loadable outside Pi (bun tests), where
 * the package is not resolvable.  Terminals ignore OSC 8 sequences they do
 * not understand - Pi's own dialogs emit them unconditionally - so the
 * optimistic fallback is safe.
 */
async function detectHyperlinkSupport(): Promise<boolean> {
	try {
		const tui = await import("@earendil-works/pi-tui");
		return tui.getCapabilities().hyperlinks;
	} catch {
		return true;
	}
}
