/**
 * TypeSafe API key resolution for the Skill dispatch PoC.
 *
 * The dispatcher sits in front of every user turn, so the key path has to be
 * boring and fail-open.  A key that lives in the process environment is
 * visible to the agent's own shell tool, and a tool result can carry it into
 * the transcript and the session JSONL, so the environment is supported but
 * never the default.  Keys are read on demand from a 0600 file, a named
 * environment variable, or a command's stdout, and are never logged: callers
 * only ever receive a fingerprint.
 *
 * Everything the PoC owns lives under one marker-guarded directory so the
 * whole experiment can be removed without touching existing user files.
 *
 * This module deliberately avoids Pi runtime imports so the resolution rules
 * can be unit-tested without a Pi process.
 */

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

/** Environment variable the official TypeSafe SDK reads when no key is passed. */
export const PRIMARY_KEY_ENV = "TYPESAFE_API_KEY";

/** Accepted alias.  The SDK ignores it, but other Jev tooling uses this name. */
export const ALIAS_KEY_ENV = "JEV_API_KEY";

/** Directory holding every file this PoC owns, so cleanup is one `rm -rf`. */
export const POC_DIR_NAME = "skill-dispatch-poc";

export const POC_MARKER_FILE = "poc.json";
export const POC_KEY_FILE = "key.env";
export const POC_CONFIG_FILE = "config.json";
export const POC_LOG_FILE = "decisions.jsonl";

/**
 * Marker written into the PoC directory.  `purge` refuses to delete a
 * directory whose marker is missing or does not match, so a mistaken path
 * cannot remove unrelated files.
 */
export const POC_MARKER = { name: "u7chan-lab-skill-dispatch", version: 1 } as const;

/** Command sources are for password managers, so they get a generous deadline. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

const HASH_PREFIX_LENGTH = 12;
const REDACTED = "***";

type Environment = Record<string, string | undefined>;

/** Where the PoC keeps state, derived from Pi's own agent directory. */
export interface PocPaths {
	readonly dir: string;
	readonly marker: string;
	readonly keyFile: string;
	readonly configFile: string;
	readonly logFile: string;
}

export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/** Injected for tests; production callers use the defaults. */
export interface KeySourceDeps {
	readonly env?: Environment;
	readonly homeDir?: string;
	readonly readFile?: (path: string) => string | Promise<string>;
	readonly runCommand?: (command: string, timeoutMs: number) => Promise<CommandResult>;
	readonly commandTimeoutMs?: number;
}

export type KeySourceSpec =
	| { readonly kind: "file"; readonly spec: string; readonly value: string }
	| { readonly kind: "env"; readonly spec: string; readonly value: string }
	| { readonly kind: "command"; readonly spec: string; readonly value: string };

export interface ResolvedApiKey {
	/** The secret itself.  Never log, display, or serialize this value. */
	readonly key: string;
	/** Redacted origin, safe for status output and log lines. */
	readonly source: string;
	/** `sha256(key)` prefix, stable across sessions and safe to log. */
	readonly fingerprint: string;
}

export type KeyResolution =
	| { readonly ok: true; readonly resolved: ResolvedApiKey }
	| { readonly ok: false; readonly source: string; readonly error: string };

/** Pi's agent directory, honoring the override Pi itself honors. */
export function agentDir(env: Environment = process.env, home = homedir()): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(home, ".pi", "agent");
}

export function pocPaths(env: Environment = process.env, home = homedir()): PocPaths {
	const dir = join(agentDir(env, home), POC_DIR_NAME);
	return {
		dir,
		marker: join(dir, POC_MARKER_FILE),
		keyFile: join(dir, POC_KEY_FILE),
		configFile: join(dir, POC_CONFIG_FILE),
		logFile: join(dir, POC_LOG_FILE),
	};
}

/**
 * Parse an `apiKeySource` spec.
 *
 * Only `file:`, `env:`, and `command:` are accepted.  A bare string is
 * rejected instead of guessed at, and literals are not supported at all, so
 * no code path can store the key in a config file or a repo.
 */
export function parseKeySourceSpec(spec: string): KeySourceSpec | undefined {
	const trimmed = spec.trim();
	if (trimmed.length === 0) return undefined;

	const separator = trimmed.indexOf(":");
	if (separator <= 0) return undefined;

	const kind = trimmed.slice(0, separator);
	const value = trimmed.slice(separator + 1).trim();
	if (value.length === 0) return undefined;

	if (kind === "file" || kind === "env" || kind === "command") {
		return { kind, spec: trimmed, value };
	}
	return undefined;
}

/** Expand a leading `~` against the caller's home directory. */
export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** `sha256(key)` prefix.  Loggable identity for a secret that must not be logged. */
export function fingerprintKey(key: string): string {
	return createHash("sha256").update(key, "utf8").digest("hex").slice(0, HASH_PREFIX_LENGTH);
}

/**
 * Mask token-shaped runs in text that is about to be shown or logged.
 *
 * Used on command stderr and error strings, where a helper tool may echo the
 * credential back at us.  Long opaque runs are masked wholesale rather than
 * by vendor prefix, because the TypeSafe key format is not part of the public
 * contract.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/\b[A-Za-z0-9_-]{24,}\b/g, REDACTED)
		.replace(/\b(?:sk|tsk|jev|key)[-_][A-Za-z0-9_-]{8,}\b/gi, REDACTED);
}

function unquote(value: string): string {
	const first = value.at(0);
	if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
		return value.slice(1, -1).trim();
	}
	return value;
}

/**
 * Read the key out of a dotenv-style file.
 *
 * Accepts `TYPESAFE_API_KEY=...` and `JEV_API_KEY=...`, with optional `export`
 * and optional quotes.  As a convenience for hand-written key files, a file
 * with no assignment at all and exactly one non-comment line is read as the
 * bare key.  Anything else returns `undefined` so the caller fails open.
 */
export function extractApiKeyFromEnvFile(text: string): string | undefined {
	const wanted = new Set([PRIMARY_KEY_ENV, ALIAS_KEY_ENV]);
	const assignments = new Map<string, string>();
	let bareLine: string | undefined;
	let bareLines = 0;

	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
		if (match === null) {
			bareLines += 1;
			if (bareLine === undefined) bareLine = unquote(trimmed);
			continue;
		}

		const [, name, rawValue] = match;
		const value = unquote(rawValue.trim());
		if (wanted.has(name) && !assignments.has(name) && value.length > 0) {
			assignments.set(name, value);
		}
	}

	for (const name of [PRIMARY_KEY_ENV, ALIAS_KEY_ENV]) {
		const value = assignments.get(name);
		if (value !== undefined) return value;
	}

	return assignments.size === 0 && bareLines === 1 ? bareLine : undefined;
}

async function defaultReadFile(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(path, "utf8");
}

const execAsync = promisify(exec);

async function defaultRunCommand(command: string, timeoutMs: number): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execAsync(command, {
			timeout: timeoutMs,
			maxBuffer: 64 * 1024,
			windowsHide: true,
			encoding: "utf8",
		});
		return { stdout: String(stdout), stderr: String(stderr), code: 0 };
	} catch (error) {
		const failure = error as {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		return {
			stdout: String(failure.stdout ?? ""),
			stderr: String(failure.stderr ?? ""),
			code: typeof failure.code === "number" ? failure.code : 1,
		};
	}
}

function failure(spec: KeySourceSpec, error: string, home: string): KeyResolution {
	return { ok: false, source: describeKeySource(spec, home), error: redactSecrets(error) };
}

function success(spec: KeySourceSpec, key: string, home: string): KeyResolution {
	return {
		ok: true,
		resolved: { key, source: describeKeySource(spec, home), fingerprint: fingerprintKey(key) },
	};
}

/** Redacted description of a source, for status output and log lines. */
export function describeKeySource(spec: KeySourceSpec | string, home = homedir()): string {
	const parsed = typeof spec === "string" ? parseKeySourceSpec(spec) : spec;
	if (parsed === undefined) {
		const trimmed = (typeof spec === "string" ? spec : "").trim();
		return trimmed.length === 0 ? "(unset)" : "(unsupported)";
	}
	if (parsed.kind === "file") return `file:${expandHome(parsed.value, home)}`;
	if (parsed.kind === "env") return `env:${parsed.value}`;
	return "command:(hidden)";
}

/**
 * Resolve the API key for one dispatch.
 *
 * Every failure returns `ok: false` with a redacted reason so the caller can
 * fall back to normal Pi behavior.  The caller owns any caching; this function
 * performs real I/O on each call.
 */
export async function resolveApiKey(
	spec: string,
	deps: KeySourceDeps = {},
): Promise<KeyResolution> {
	const parsed = parseKeySourceSpec(spec);
	const env = deps.env ?? process.env;
	const home = deps.homeDir ?? homedir();

	if (parsed === undefined) {
		return {
			ok: false,
			source: describeKeySource(spec, home),
			error: "unsupported apiKeySource: use file:, env:, or command:",
		};
	}

	if (parsed.kind === "env") {
		const value = env[parsed.value]?.trim();
		if (value === undefined || value.length === 0) {
			return failure(parsed, `environment variable ${parsed.value} is empty or unset`, home);
		}
		return success(parsed, value, home);
	}

	if (parsed.kind === "file") {
		const path = resolvePath(expandHome(parsed.value, home));
		try {
			const readFile = deps.readFile ?? defaultReadFile;
			const contents = await readFile(path);
			const value = extractApiKeyFromEnvFile(contents);
			if (value === undefined) {
				return failure(parsed, `no ${PRIMARY_KEY_ENV} or ${ALIAS_KEY_ENV} entry in ${path}`, home);
			}
			return success(parsed, value, home);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return failure(parsed, `cannot read key file ${path}: ${message}`, home);
		}
	}

	const runCommand = deps.runCommand ?? defaultRunCommand;
	const timeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	try {
		const result = await runCommand(parsed.value, timeoutMs);
		if (result.code !== 0) {
			const detail = result.stderr.trim();
			return failure(
				parsed,
				`command exited with code ${result.code}${detail.length > 0 ? `: ${detail}` : ""}`,
				home,
			);
		}
		const value = result.stdout.trim();
		if (value.length === 0) return failure(parsed, "command produced no output", home);
		return success(parsed, unquote(value), home);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failure(parsed, `command failed: ${message}`, home);
	}
}
