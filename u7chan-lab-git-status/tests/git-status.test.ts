import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gitStatusExtension, {
	createGitStatusController,
	formatGitStatusText,
	hyperlinkSupportFrom,
	normalizeBranchName,
	osc8Link,
	parseGitRemote,
	parsePrViewJson,
	selectRemoteUrl,
	STATUS_KEY,
	type ExecResultLike,
	type GitStatusExec,
	type GitStatusScheduler,
	type GitStatusTimer,
	type GitStatusUi,
} from "../.pi/extensions/git-status.ts";

const ok = (stdout: string): ExecResultLike => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "", code = 1): ExecResultLike => ({ stdout: "", stderr, code });

const REMOTE_OUTPUT =
	"origin\tgit@github.com:u7chan/pi-lab.git (fetch)\n" +
	"origin\tgit@github.com:u7chan/pi-lab.git (push)\n";
const REPO_TEXT = "u7chan/pi-lab";
const REPO_URL = "https://github.com/u7chan/pi-lab";
const PR_JSON = JSON.stringify({ number: 12, url: `${REPO_URL}/pull/12` });

/** Let a fire-and-forget `gh` lookup and its render settle. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

type ExecEntry = ExecResultLike | (() => ExecResultLike | Promise<ExecResultLike>);

function createFakeExec(entries: { head?: ExecEntry; remote?: ExecEntry; pr?: ExecEntry } = {}) {
	const calls: string[] = [];
	const exec: GitStatusExec = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`);
		const entry = command === "gh" ? entries.pr : args[0] === "rev-parse" ? entries.head : entries.remote;
		if (!entry) return fail("not found", 127);
		return typeof entry === "function" ? await entry() : entry;
	};

	return {
		exec,
		calls,
		countOf: (prefix: string) => calls.filter((call) => call.startsWith(prefix)).length,
	};
}

function createFakeUi(overrides: Partial<GitStatusUi> = {}) {
	const statuses: Array<string | undefined> = [];
	const ui: GitStatusUi = {
		hasUI: true,
		cwd: "/repo",
		hyperlinks: false,
		setStatus: (_key, text) => {
			statuses.push(text);
		},
		...overrides,
	};

	return { ui, statuses, last: () => statuses.at(-1) };
}

function createTestScheduler() {
	const pending = new Map<GitStatusTimer, () => void>();
	const scheduler: GitStatusScheduler = {
		setTimeout(callback) {
			const timer: GitStatusTimer = { unref() {} };
			pending.set(timer, callback);
			return timer;
		},
		clearTimeout(timer) {
			pending.delete(timer);
		},
	};

	return {
		scheduler,
		pendingCount: () => pending.size,
		runAll() {
			const callbacks = [...pending.values()];
			pending.clear();
			for (const callback of callbacks) callback();
		},
	};
}

describe("parseGitRemote", () => {
	test("parses scp-like remotes into a web URL", () => {
		expect(parseGitRemote("git@github.com:u7chan/pi-lab.git")).toEqual({
			host: "github.com",
			path: REPO_TEXT,
			webUrl: REPO_URL,
		});
	});

	test("parses explicit ssh, git, and https remotes", () => {
		for (const remote of [
			"ssh://git@github.com/u7chan/pi-lab.git",
			"git://github.com/u7chan/pi-lab.git",
			"https://github.com/u7chan/pi-lab.git",
			"https://github.com/u7chan/pi-lab",
			"https://github.com/u7chan/pi-lab/",
			"https://user@github.com/u7chan/pi-lab.git",
		]) {
			expect(parseGitRemote(remote)).toEqual({
				host: "github.com",
				path: REPO_TEXT,
				webUrl: REPO_URL,
			});
		}
	});

	test("strips ssh ports and keeps unsupported users out of the result", () => {
		expect(parseGitRemote("ssh://alice@github.com:2222/u7chan/pi-lab.git")).toEqual({
			host: "github.com",
			path: REPO_TEXT,
			webUrl: REPO_URL,
		});
	});

	test("keeps nested GitLab groups and plain http remotes", () => {
		expect(parseGitRemote("https://gitlab.example.com/team/sub/repo.git")).toEqual({
			host: "gitlab.example.com",
			path: "team/sub/repo",
			webUrl: "https://gitlab.example.com/team/sub/repo",
		});
		expect(parseGitRemote("http://git.example.com/team/repo.git")?.webUrl).toBe(
			"http://git.example.com/team/repo",
		);
	});

	test("rejects remotes that cannot become a web link", () => {
		for (const remote of [
			"",
			"   ",
			"/srv/git/repo.git",
			"file:///srv/git/repo.git",
			"C:\\repos\\repo.git",
			"https://github.com/owner",
			"../relative/path",
			"https://github.com/u7chan/pi lab.git",
			"https://github.com//repo.git",
		]) {
			expect(parseGitRemote(remote)).toBeUndefined();
		}
	});
});

describe("selectRemoteUrl", () => {
	test("prefers origin over upstream and later remotes", () => {
		expect(
			selectRemoteUrl(
				[
					"upstream\tgit@github.com:upstream/pi-lab.git (fetch)",
					"origin\tgit@github.com:u7chan/pi-lab.git (fetch)",
					"origin\tgit@github.com:u7chan/pi-lab.git (push)",
				].join("\n"),
			),
		).toBe("git@github.com:u7chan/pi-lab.git");
	});

	test("falls back to upstream, then the first configured remote", () => {
		expect(
			selectRemoteUrl("upstream\tgit@github.com:upstream/pi-lab.git (fetch)"),
		).toBe("git@github.com:upstream/pi-lab.git");
		expect(selectRemoteUrl("fork\thttps://github.com/fork/pi-lab.git (fetch)")).toBe(
			"https://github.com/fork/pi-lab.git",
		);
	});

	test("returns undefined without remotes", () => {
		expect(selectRemoteUrl("")).toBeUndefined();
		expect(selectRemoteUrl("\n\n")).toBeUndefined();
	});
});

describe("parsePrViewJson", () => {
	test("parses gh pr view output and ignores extra fields", () => {
		expect(parsePrViewJson(PR_JSON)).toEqual({ number: 12, url: `${REPO_URL}/pull/12` });
		expect(
			parsePrViewJson(JSON.stringify({ number: 7, url: `${REPO_URL}/pull/7`, state: "MERGED" })),
		).toEqual({ number: 7, url: `${REPO_URL}/pull/7` });
	});

	test("rejects malformed output", () => {
		for (const stdout of [
			"",
			"not json",
			"{}",
			'{"number":"12","url":"https://github.com/u7chan/pi-lab/pull/12"}',
			'{"number":0,"url":"https://github.com/u7chan/pi-lab/pull/0"}',
			'{"number":12,"url":"git@github.com:u7chan/pi-lab"}',
		]) {
			expect(parsePrViewJson(stdout)).toBeUndefined();
		}
	});
});

describe("normalizeBranchName", () => {
	test("trims the branch name and treats blank output as unknown", () => {
		expect(normalizeBranchName("feature/links\n")).toBe("feature/links");
		expect(normalizeBranchName("HEAD\n")).toBe("HEAD");
		expect(normalizeBranchName("  ")).toBeUndefined();
	});
});

describe("hyperlinkSupportFrom", () => {
	test("trusts the capability report for known terminals", () => {
		expect(hyperlinkSupportFrom(true, {})).toBe(true);
		expect(hyperlinkSupportFrom(true, { WT_PROFILE_ID: "{profile}" })).toBe(true);
	});

	test("honors an explicit PI_HYPERLINKS=0 even on Windows Terminal", () => {
		expect(hyperlinkSupportFrom(false, { PI_HYPERLINKS: "0", WT_PROFILE_ID: "{profile}" })).toBe(false);
		expect(hyperlinkSupportFrom(true, { PI_HYPERLINKS: "0", WT_SESSION: "session" })).toBe(false);
	});

	test("accepts Windows Terminal evidence when detection cannot see WT_SESSION", () => {
		expect(hyperlinkSupportFrom(false, { WT_PROFILE_ID: "{profile}" })).toBe(true);
		expect(hyperlinkSupportFrom(false, { WT_SESSION: "session" })).toBe(true);
	});

	test("stays conservative for unknown terminals", () => {
		expect(hyperlinkSupportFrom(false, {})).toBe(false);
		expect(hyperlinkSupportFrom(false, { PI_HYPERLINKS: "auto" })).toBe(false);
	});
});

describe("formatGitStatusText", () => {
	const repo = parseGitRemote("git@github.com:u7chan/pi-lab.git")!;
	const pr = { number: 12, url: `${REPO_URL}/pull/12` };

	test("renders the repository alone or with the PR number", () => {
		expect(formatGitStatusText({ repo, hyperlinks: false })).toBe(REPO_TEXT);
		expect(formatGitStatusText({ repo, pr, hyperlinks: false })).toBe("u7chan/pi-lab PR #12");
	});

	test("wraps both parts in OSC 8 links", () => {
		expect(formatGitStatusText({ repo, pr, hyperlinks: true })).toBe(
			`${osc8Link(REPO_TEXT, REPO_URL)} ${osc8Link("PR #12", `${REPO_URL}/pull/12`)}`,
		);
	});

	test("colors the repository dim and the PR accent", () => {
		const theme = {
			fg: (color: "accent" | "dim", text: string) => `<${color}>${text}</${color}>`,
		};
		expect(formatGitStatusText({ repo, pr, hyperlinks: false, theme })).toBe(
			`<dim>${REPO_TEXT}</dim> <accent>PR #12</accent>`,
		);
	});

	test("osc8Link uses ST-terminated OSC 8 sequences", () => {
		expect(osc8Link("text", REPO_URL)).toBe(`\x1b]8;;${REPO_URL}\x1b\\text\x1b]8;;\x1b\\`);
	});
});

describe("git status controller", () => {
	test("renders the repository first and the PR when gh answers", async () => {
		let resolvePr: ((result: ExecResultLike) => void) | undefined;
		const prPromise = new Promise<ExecResultLike>((resolve) => {
			resolvePr = resolve;
		});
		const { exec, countOf } = createFakeExec({
			head: ok("feature/links\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: () => prPromise,
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui });

		// The repository link must not wait for the network call.
		await controller.refresh();
		expect(ui.statuses).toEqual([REPO_TEXT]);
		expect(countOf("gh pr view")).toBe(1);

		resolvePr?.(ok(PR_JSON));
		await tick();
		expect(ui.last()).toBe("u7chan/pi-lab PR #12");
	});

	test("clears the segment outside a git repository", async () => {
		const { exec } = createFakeExec({
			head: fail("fatal: not a git repository", 128),
			remote: fail("fatal: not a git repository", 128),
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		expect(ui.statuses).toEqual([undefined]);
	});

	test("clears the segment when no remote can be linked", async () => {
		const { exec, countOf } = createFakeExec({
			head: ok("main\n"),
			remote: ok("origin\t/srv/git/pi-lab.git (fetch)\n"),
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		await tick();
		expect(ui.statuses).toEqual([undefined]);
		expect(countOf("gh pr view")).toBe(0);
	});

	test("keeps the repository link when gh cannot answer", async () => {
		const { exec } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: fail('no pull requests found for branch "main"', 1),
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		await tick();
		expect(ui.last()).toBe(REPO_TEXT);
	});

	test("emits OSC 8 links when the terminal supports them", async () => {
		const { exec } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: ok(PR_JSON),
		});
		const ui = createFakeUi({ hyperlinks: true });
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		await tick();
		expect(ui.last()).toBe(
			`${osc8Link(REPO_TEXT, REPO_URL)} ${osc8Link("PR #12", `${REPO_URL}/pull/12`)}`,
		);
	});

	test("does not touch the UI without one", async () => {
		const { exec, countOf } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: ok(PR_JSON),
		});
		const ui = createFakeUi({ hasUI: false });
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		await tick();
		expect(ui.statuses).toEqual([]);
		expect(countOf("git rev-parse")).toBe(1);
	});

	test("retries gh only after prRetryMs", async () => {
		let clock = 0;
		const { exec, countOf } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: fail(),
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({
			exec,
			ui: ui.ui,
			now: () => clock,
			prRetryMs: 10_000,
		});

		await controller.refresh();
		await tick();
		expect(countOf("gh pr view")).toBe(1);

		await controller.refresh();
		await tick();
		expect(countOf("gh pr view")).toBe(1);

		clock = 10_001;
		await controller.refresh();
		await tick();
		expect(countOf("gh pr view")).toBe(2);
	});

	test("resolves the PR again after a branch switch", async () => {
		let branch = "main";
		const { exec, countOf } = createFakeExec({
			head: () => ok(`${branch}\n`),
			remote: ok(REMOTE_OUTPUT),
			pr: ok(PR_JSON),
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		await tick();

		branch = "feature/links";
		await controller.refresh();
		await tick();
		expect(countOf("gh pr view")).toBe(2);
	});

	test("coalesces scheduled refreshes", async () => {
		const { scheduler, pendingCount, runAll } = createTestScheduler();
		const { exec, countOf } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: ok(PR_JSON),
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui, scheduler });

		controller.scheduleRefresh();
		controller.scheduleRefresh();
		controller.scheduleRefresh();
		expect(pendingCount()).toBe(1);

		runAll();
		await tick();
		expect(countOf("git rev-parse")).toBe(1);
		expect(ui.last()).toBe("u7chan/pi-lab PR #12");
	});

	test("stops rendering after dispose", async () => {
		let resolvePr: ((result: ExecResultLike) => void) | undefined;
		const prPromise = new Promise<ExecResultLike>((resolve) => {
			resolvePr = resolve;
		});
		const { exec } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: () => prPromise,
		});
		const ui = createFakeUi();
		const controller = createGitStatusController({ exec, ui: ui.ui });

		await controller.refresh();
		expect(ui.statuses).toEqual([REPO_TEXT]);

		controller.dispose();
		resolvePr?.(ok(PR_JSON));
		await tick();
		await tick();

		controller.scheduleRefresh();
		expect(ui.statuses).toEqual([REPO_TEXT]);
	});
});

describe("git-status extension", () => {
	test("sets the status on session start and clears it on shutdown", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const statuses: Array<[string, string | undefined]> = [];
		const { exec } = createFakeExec({
			head: ok("main\n"),
			remote: ok(REMOTE_OUTPUT),
			pr: ok(PR_JSON),
		});

		const fakePi = {
			on(type: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(type, handler);
			},
			exec,
		} as unknown as ExtensionAPI;

		gitStatusExtension(fakePi);

		const ctx = {
			hasUI: true,
			cwd: "/repo",
			ui: {
				theme: undefined,
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
			},
		};

		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await tick();

		const started = statuses.at(-1);
		expect(started?.[0]).toBe(STATUS_KEY);
		expect(started?.[1] ?? "").toContain(REPO_TEXT);
		expect(started?.[1] ?? "").toContain("PR #12");

		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
	});
});
