/**
 * Send gates for the Skill dispatch PoC.
 *
 * Every user prompt that reaches the dispatcher would be sent to an external
 * API, so the hook is deny-by-default and layered.  This module owns the cheap
 * checks that need no filesystem or network access; the roster and key checks
 * happen after them in the adapter, in the same order the reasons are listed
 * here.
 *
 * The rules are deliberately boring and explicit: no heuristic decides whether
 * a prompt is "safe to send".  A project is either inside `projectAllowlist`
 * or nothing leaves the machine.
 */

/** `off` never looks at input, `dry-run` builds and logs only, `live` sends. */
export type SendMode = "off" | "dry-run" | "live";

export interface GateFacts {
	/** Master switch from config.  False wins over every session mode. */
	readonly enabled: boolean;
	readonly mode: SendMode;
	/** `event.source` from the input hook. */
	readonly source: string;
	/** Raw user input. */
	readonly text: string;
	/** Absolute, symlink-resolved working directory of the session. */
	readonly cwd: string;
	/** Absolute roots where dispatch is allowed.  An empty list allows nothing. */
	readonly allowlist: readonly string[];
	/**
	 * True when Pi learned the skill roots at startup (`resources_discover`).
	 * A live transform rewrites the input into `/skill:<name>`, which only Pi can
	 * expand, so the roots have to be published for this session already.
	 */
	readonly skillsPublished: boolean;
	/** Dispatches already sent in this session. */
	readonly dispatched: number;
	/** 0 disables the budget. */
	readonly maxDispatchesPerSession: number;
}

export type GateVerdict =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly reason: string };

const ALLOWED: GateVerdict = { allowed: true };

/**
 * True when `path` is `root` itself or sits underneath it.
 *
 * Both sides must already be absolute and symlink-resolved by the caller, so
 * this stays a pure string comparison with a path-boundary check.
 */
export function isWithin(path: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	if (normalizedRoot.length === 0) return false;
	return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/** True when the working directory is allowed to dispatch. */
export function isCwdAllowed(cwd: string, allowlist: readonly string[]): boolean {
	return allowlist.some((root) => isWithin(cwd, root.replace(/\/+$/, "")));
}

/**
 * Evaluate the cheap gates.
 *
 * Order matters for the reason shown to the user: the most fundamental reason
 * wins, so a disabled dispatcher never reports "outside allowlist".
 */
export function evaluateGate(facts: GateFacts): GateVerdict {
	if (!facts.enabled) return { allowed: false, reason: "disabled in config" };
	if (facts.mode === "off") return { allowed: false, reason: "session mode is off" };
	if (facts.source !== "interactive") return { allowed: false, reason: `input source is ${facts.source}` };

	const text = facts.text.trim();
	if (text.length === 0) return { allowed: false, reason: "empty input" };
	if (text.startsWith("/")) return { allowed: false, reason: "explicit command" };

	if (facts.allowlist.length === 0) return { allowed: false, reason: "projectAllowlist is empty" };
	if (!isCwdAllowed(facts.cwd, facts.allowlist)) {
		return { allowed: false, reason: "cwd is outside projectAllowlist" };
	}

	if (facts.maxDispatchesPerSession > 0 && facts.dispatched >= facts.maxDispatchesPerSession) {
		return { allowed: false, reason: "session dispatch budget reached" };
	}

	// Enabling the dispatcher mid-session cannot teach Pi the skill roots: it only
	// discovers them at startup and on `/new`.  Transforming in that state would
	// hand the user a `/skill:<name>` Pi cannot resolve, which is worse than not
	// dispatching at all, so the live transform stays off until the next session.
	if (facts.mode === "live" && !facts.skillsPublished) {
		return { allowed: false, reason: "skill roots were not published at startup" };
	}

	return ALLOWED;
}

/**
 * Gates that need the roster and the key, evaluated after `evaluateGate`.
 * Kept separate so a denied prompt never triggers a filesystem scan.
 */
export function evaluateReadiness(facts: {
	readonly skillCount: number;
	readonly keyAvailable: boolean;
}): GateVerdict {
	if (facts.skillCount === 0) return { allowed: false, reason: "no skills in the roster" };
	if (!facts.keyAvailable) return { allowed: false, reason: "no API key" };
	return ALLOWED;
}
