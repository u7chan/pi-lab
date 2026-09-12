/**
 * Git remote and pull-request footer status primitives.
 *
 * Pi's built-in footer already shows the working directory and the current
 * branch, but it cannot say which remote the checkout points at.  This PoC
 * adds one status segment next to the cache segments:
 *
 *     u7chan/pi-lab PR #12
 *
 * Both parts are OSC 8 hyperlinks when the terminal supports them: the
 * `owner/repo` text opens the remote repository and `PR #12` opens the pull
 * request that `gh pr view` resolves from the current branch.  Every lookup is
 * best-effort - a checkout without a web remote, an unavailable `gh`, or a
 * branch without a PR only drops the missing part instead of reporting an
 * error in the footer.
 */

export const STATUS_KEY = "git";

/** `gh pr view` is not retried for a branch until this much time has passed. */
export const DEFAULT_PR_RETRY_MS = 10_000;
/** Branch/remote detection is coalesced after shell tools and turns. */
export const DEFAULT_DEBOUNCE_MS = 300;

const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 5_000;

const URL_REMOTE = /^(ssh|git|https?):\/\/(?:([^@/]+)@)?([^/]+)\/(.+)$/i;
const SCP_LIKE_REMOTE = /^(?:([^@/]+)@)?([^:/@]+):(?!\/)(.+)$/;
const PREFERRED_REMOTES = ["origin", "upstream"];

function stripPort(host: string): string {
	return host.replace(/:\d+$/, "").toLowerCase();
}

export interface RemoteInfo {
	/** Remote host, including the port for http(s) remotes (e.g. "git.example.com:8443"). */
	host: string;
	/** Repository path on the host (e.g. "u7chan/pi-lab"). */
	path: string;
	/** Web URL for the repository root (e.g. "https://github.com/u7chan/pi-lab"). */
	webUrl: string;
}

/**
 * Parse a git remote URL into a web repository.
 *
 * Supports the scp-like syntax (`git@github.com:owner/repo.git`) and explicit
 * protocols (`ssh://`, `git://`, `http://`, `https://`).  The web URL is https
 * except for plain http remotes.  Local paths, `file://` URLs, Windows drive
 * paths, and remotes without an owner segment are rejected so the footer never
 * renders a link that cannot work.
 */
export function parseGitRemote(remoteUrl: string): RemoteInfo | undefined {
	const raw = remoteUrl.trim();
	if (raw.length === 0 || raw.includes("\\")) return undefined;

	const urlMatch = raw.match(URL_REMOTE);
	const scpMatch = urlMatch ? undefined : raw.match(SCP_LIKE_REMOTE);
	const scheme = (urlMatch?.[1] ?? "ssh").toLowerCase();
	const rawHost = urlMatch?.[3] ?? scpMatch?.[2] ?? "";
	// An http(s) port belongs to the web URL; ssh/git ports are transport only.
	const host = scheme === "http" || scheme === "https" ? rawHost.toLowerCase() : stripPort(rawHost);
	const rawPath = urlMatch?.[4] ?? scpMatch?.[3] ?? "";

	// A dot in the host rejects `C:\...` drive paths and other local shorthand
	// while accepting every hosted forge.
	if (host.length === 0 || !host.includes(".")) return undefined;

	const path = rawPath
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/i, "");
	if (/\s/.test(path)) return undefined;

	const segments = path.split("/");
	if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
		return undefined;
	}

	const webScheme = scheme === "http" ? "http" : "https";
	return { host, path, webUrl: `${webScheme}://${host}/${path}` };
}

/**
 * Pick the remote URL to display from `git remote -v` output.
 *
 * `origin` wins, then `upstream`, then the first configured remote.  Fetch and
 * push lines repeat the same name, so only the first URL per remote is kept.
 */
export function selectRemoteUrl(remoteVerboseOutput: string): string | undefined {
	const urlsByName = new Map<string, string>();

	for (const line of remoteVerboseOutput.split("\n")) {
		const columns = line.trim().split(/\s+/);
		const name = columns[0];
		const url = columns[1];
		if (!name || !url || urlsByName.has(name)) continue;
		urlsByName.set(name, url);
	}

	for (const preferred of PREFERRED_REMOTES) {
		const url = urlsByName.get(preferred);
		if (url) return url;
	}

	return urlsByName.values().next().value;
}

export interface PrInfo {
	number: number;
	url: string;
}

/** Parse `gh pr view --json number,url` output; undefined means "no usable PR". */
export function parsePrViewJson(stdout: string): PrInfo | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null) return undefined;

	const { number, url } = parsed as { number?: unknown; url?: unknown };
	if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined;
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;

	return { number, url };
}

/** `git rev-parse --abbrev-ref HEAD` output; undefined when it is empty. */
export function normalizeBranchName(stdout: string): string | undefined {
	const name = stdout.trim();
	return name.length > 0 ? name : undefined;
}

/** Wrap text in an OSC 8 hyperlink (ignored by terminals without support). */
export function osc8Link(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** The environment markers used to recognize a hyperlink-capable terminal. */
export interface HyperlinkEnvironment {
	/** `1` forces links on, `0` forces them off (Pi's capability override). */
	PI_HYPERLINKS?: string;
	/** Windows Terminal session marker, set for its own WSL shells. */
	WT_SESSION?: string;
	/** Windows Terminal profile marker, kept by more launchers than WT_SESSION. */
	WT_PROFILE_ID?: string;
}

/**
 * Decide whether the status segment should carry OSC 8 links.
 *
 * Pi's capability detection is conservative for terminals it cannot identify,
 * and it recognizes Windows Terminal only through `WT_SESSION`.  A WSL pane
 * started by a launcher (Herdr and similar wrappers) can keep `WT_PROFILE_ID`
 * without `WT_SESSION`, which would silently disable every link in the pane.
 * Windows Terminal has supported OSC 8 since v1.4.2652, so its profile marker
 * is accepted as evidence.  `PI_HYPERLINKS=0` always wins; `PI_HYPERLINKS=1`
 * already arrives as `capability: true`.
 */
export function hyperlinkSupportFrom(
	capability: boolean,
	environment: HyperlinkEnvironment,
): boolean {
	if (environment.PI_HYPERLINKS === "0") return false;
	if (capability) return true;
	return Boolean(environment.WT_SESSION || environment.WT_PROFILE_ID);
}

/** The small part of Pi's theme API needed by the status renderer. */
export interface GitStatusTheme {
	fg(color: "accent" | "dim", text: string): string;
}

export interface GitStatusTextInput {
	repo: RemoteInfo;
	pr?: PrInfo;
	/** False when the terminal does not render OSC 8 links. */
	hyperlinks: boolean;
	theme?: GitStatusTheme;
}

/**
 * Render the status segment: `owner/repo PR #12` with each part linked.
 *
 * The repository stays dim and the PR number uses the accent color so the
 * actionable link is the one that stands out; cache segments keep using the
 * same convention.
 */
export function formatGitStatusText(input: GitStatusTextInput): string {
	const { repo, pr, hyperlinks, theme } = input;
	const link = (text: string, url: string) => (hyperlinks ? osc8Link(text, url) : text);

	const repoText = link(repo.path, repo.webUrl);
	const parts = [theme ? theme.fg("dim", repoText) : repoText];

	if (pr) {
		const prText = link(`PR #${pr.number}`, pr.url);
		parts.push(theme ? theme.fg("accent", prText) : prText);
	}

	return parts.join(" ");
}

export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitStatusExec {
	(
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number },
	): Promise<ExecResultLike>;
}

export interface GitStatusUi {
	hasUI: boolean;
	cwd: string;
	hyperlinks: boolean;
	theme?: GitStatusTheme;
	setStatus(key: string, text: string | undefined): void;
}

export interface GitStatusTimer {
	unref?(): void;
}

export interface GitStatusScheduler {
	setTimeout(callback: () => void, delayMs: number): GitStatusTimer;
	clearTimeout(timer: GitStatusTimer): void;
}

const defaultScheduler: GitStatusScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface GitStatusControllerOptions {
	exec: GitStatusExec;
	/** Status sink, cwd, terminal capability, and theme for this session. */
	ui: GitStatusUi;
	now?: () => number;
	scheduler?: GitStatusScheduler;
	debounceMs?: number;
	prRetryMs?: number;
}

export interface GitStatusController {
	/** Detect remote and branch, then resolve the PR without blocking on `gh`. */
	refresh(): Promise<void>;
	/** Coalesce a refresh (used after shell tools and settled turns). */
	scheduleRefresh(): void;
	dispose(): void;
}

interface PrCacheEntry {
	pr: PrInfo | undefined;
	checkedAt: number;
}

/**
 * Session-scoped controller behind the `git` status segment.
 *
 * `git` detection is cheap, so a refresh always reruns it; `gh pr view` needs
 * the network and is therefore cached per branch and retried at most once per
 * `prRetryMs` so a PR created mid-session still appears.
 */
export function createGitStatusController(options: GitStatusControllerOptions): GitStatusController {
	const ui = options.ui;
	const now = options.now ?? (() => Date.now());
	const scheduler = options.scheduler ?? defaultScheduler;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const prRetryMs = options.prRetryMs ?? DEFAULT_PR_RETRY_MS;

	let disposed = false;
	let detectSequence = 0;
	let debounceTimer: GitStatusTimer | undefined;
	let repo: RemoteInfo | undefined;
	let branch: string | undefined;
	// null = nothing rendered yet, so a non-repository cwd still clears a stale
	// status instead of skipping setStatus() because the text is also undefined.
	let lastText: string | undefined | null = null;
	let inFlightPrKey: string | undefined;
	const prByBranch = new Map<string, PrCacheEntry>();

	const currentKey = (): string | undefined =>
		repo && branch ? `${repo.host}/${repo.path}#${branch}` : undefined;

	const currentPr = (): PrInfo | undefined => {
		const key = currentKey();
		return key ? prByBranch.get(key)?.pr : undefined;
	};

	const render = (): void => {
		if (disposed || !ui.hasUI) return;

		const text = repo
			? formatGitStatusText({ repo, pr: currentPr(), hyperlinks: ui.hyperlinks, theme: ui.theme })
			: undefined;
		if (text === lastText) return;

		lastText = text;
		ui.setStatus(STATUS_KEY, text);
	};

	const detect = async (): Promise<void> => {
		const sequence = ++detectSequence;
		const cwd = ui.cwd;
		let headResult: ExecResultLike;
		let remoteResult: ExecResultLike;
		try {
			[headResult, remoteResult] = await Promise.all([
				options.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS }),
				options.exec("git", ["remote", "-v"], { cwd, timeout: GIT_TIMEOUT_MS }),
			]);
		} catch {
			// `pi.exec` rejects once Pi tears the extension runtime down; clear the
			// segment instead of leaving an unhandled rejection behind.
			if (disposed || sequence !== detectSequence) return;
			repo = undefined;
			branch = undefined;
			render();
			return;
		}

		// A newer detection (or dispose) won the race; its state is authoritative.
		if (disposed || sequence !== detectSequence) return;

		if (headResult.code !== 0) {
			repo = undefined;
			branch = undefined;
			render();
			return;
		}

		const remoteUrl = selectRemoteUrl(remoteResult.stdout);
		repo = remoteUrl ? parseGitRemote(remoteUrl) : undefined;
		branch = normalizeBranchName(headResult.stdout);
		render();
	};

	const lookupPr = async (key: string): Promise<void> => {
		const cached = prByBranch.get(key);
		if (cached && (cached.pr || now() - cached.checkedAt < prRetryMs)) return;
		if (inFlightPrKey !== undefined) return;

		inFlightPrKey = key;
		let result: ExecResultLike | undefined;
		try {
			result = await options.exec("gh", ["pr", "view", "--json", "number,url"], {
				cwd: ui.cwd,
				timeout: GH_TIMEOUT_MS,
			});
		} catch {
			// See `detect`: a torn-down runtime rejects, which is "no answer".
			result = undefined;
		} finally {
			inFlightPrKey = undefined;
		}

		if (disposed) return;

		const pr = result && result.code === 0 ? parsePrViewJson(result.stdout) : undefined;
		prByBranch.set(key, { pr, checkedAt: now() });

		const current = currentKey();
		if (current === key) {
			render();
			return;
		}
		// The checkout moved while `gh` was running; resolve the new branch too,
		// otherwise its PR stays unknown until some other refresh happens.
		if (current) void lookupPr(current);
	};

	const cancelDebounce = (): void => {
		if (debounceTimer === undefined) return;
		scheduler.clearTimeout(debounceTimer);
		debounceTimer = undefined;
	};

	const refresh = async (): Promise<void> => {
		if (disposed) return;

		cancelDebounce();
		await detect();
		if (disposed) return;

		const key = currentKey();
		if (key) void lookupPr(key);
	};

	const scheduleRefresh = (): void => {
		if (disposed || !ui.hasUI) return;

		cancelDebounce();
		debounceTimer = scheduler.setTimeout(() => {
			debounceTimer = undefined;
			void refresh();
		}, debounceMs);
		debounceTimer.unref?.();
	};

	const dispose = (): void => {
		disposed = true;
		detectSequence++;
		cancelDebounce();
		prByBranch.clear();
	};

	return { refresh, scheduleRefresh, dispose };
}
