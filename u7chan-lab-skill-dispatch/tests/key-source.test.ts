import { describe, expect, test } from "bun:test";
import {
	ALIAS_KEY_ENV,
	DEFAULT_COMMAND_TIMEOUT_MS,
	agentDir,
	describeKeySource,
	expandHome,
	extractApiKeyFromEnvFile,
	fingerprintKey,
	parseKeySourceSpec,
	pocPaths,
	PRIMARY_KEY_ENV,
	redactSecrets,
	resolveApiKey,
	type CommandResult,
	type KeySourceDeps,
} from "../src/key-source.ts";

const SECRET = "tsk_test_0123456789abcdefghijklmnopqrstuvwxyz";
const HOME = "/home/tester";

const deps = (overrides: KeySourceDeps = {}): KeySourceDeps => ({
	env: {},
	homeDir: HOME,
	...overrides,
});

describe("parseKeySourceSpec", () => {
	test("accepts the three supported prefixes", () => {
		expect(parseKeySourceSpec(`file:${HOME}/key.env`)).toEqual({
			kind: "file",
			spec: `file:${HOME}/key.env`,
			value: `${HOME}/key.env`,
		});
		expect(parseKeySourceSpec(`  env:${PRIMARY_KEY_ENV}  `)).toEqual({
			kind: "env",
			spec: `env:${PRIMARY_KEY_ENV}`,
			value: PRIMARY_KEY_ENV,
		});
		expect(parseKeySourceSpec("command:op read op://vault/item")).toEqual({
			kind: "command",
			spec: "command:op read op://vault/item",
			value: "op read op://vault/item",
		});
	});

	test("rejects bare strings, unknown kinds, and empty values", () => {
		// A bare string is rejected rather than guessed at, so a literal key can
		// never be mistaken for a spec.
		expect(parseKeySourceSpec(SECRET)).toBeUndefined();
		expect(parseKeySourceSpec("vault:foo")).toBeUndefined();
		expect(parseKeySourceSpec("file:")).toBeUndefined();
		expect(parseKeySourceSpec("   ")).toBeUndefined();
		expect(parseKeySourceSpec(":env:FOO")).toBeUndefined();
	});
});

describe("paths", () => {
	test("prefers PI_CODING_AGENT_DIR and keeps everything in one directory", () => {
		const paths = pocPaths({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }, HOME);
		expect(paths.dir).toBe("/tmp/pi-agent/skill-dispatch-poc");
		expect(paths.keyFile).toBe("/tmp/pi-agent/skill-dispatch-poc/key.env");
		expect(paths.logFile).toBe("/tmp/pi-agent/skill-dispatch-poc/decisions.jsonl");
		// Every owned path sits under the single removable directory.
		for (const path of [paths.marker, paths.keyFile, paths.configFile, paths.logFile]) {
			expect(path.startsWith(`${paths.dir}/`)).toBe(true);
		}
	});

	test("falls back to ~/.pi/agent and ignores a blank override", () => {
		expect(agentDir({}, HOME)).toBe(`${HOME}/.pi/agent`);
		expect(agentDir({ PI_CODING_AGENT_DIR: "  " }, HOME)).toBe(`${HOME}/.pi/agent`);
		expect(pocPaths({}, HOME).keyFile).toBe(`${HOME}/.pi/agent/skill-dispatch-poc/key.env`);
	});

	test("expandHome only rewrites a leading tilde", () => {
		expect(expandHome("~/key.env", HOME)).toBe(`${HOME}/key.env`);
		expect(expandHome("~", HOME)).toBe(HOME);
		expect(expandHome(`/${HOME}/key.env`, HOME)).toBe(`/${HOME}/key.env`);
		expect(expandHome("./key.env", HOME)).toBe("./key.env");
	});
});

describe("extractApiKeyFromEnvFile", () => {
	test("reads the primary key with export, quotes, comments, and blanks", () => {
		const text = [
			"# TypeSafe PoC key",
			"",
			"OTHER=value",
			`export ${PRIMARY_KEY_ENV}="${SECRET}"`,
			`${ALIAS_KEY_ENV}=alias`,
		].join("\n");
		expect(extractApiKeyFromEnvFile(text)).toBe(SECRET);
	});

	test("accepts the alias and single quotes", () => {
		expect(extractApiKeyFromEnvFile(`${ALIAS_KEY_ENV}='${SECRET}'`)).toBe(SECRET);
	});

	test("treats a lone non-assignment line as the bare key", () => {
		expect(extractApiKeyFromEnvFile(`${SECRET}\n`)).toBe(SECRET);
		expect(extractApiKeyFromEnvFile(`# comment\n${SECRET}\n`)).toBe(SECRET);
	});

	test("returns undefined when the file cannot be understood", () => {
		expect(extractApiKeyFromEnvFile("")).toBeUndefined();
		expect(extractApiKeyFromEnvFile("OTHER=value")).toBeUndefined();
		expect(extractApiKeyFromEnvFile(`${PRIMARY_KEY_ENV}=`)).toBeUndefined();
		expect(extractApiKeyFromEnvFile(`${PRIMARY_KEY_ENV}=\n${ALIAS_KEY_ENV}=`)).toBeUndefined();
		// Two bare lines are ambiguous, so neither is used.
		expect(extractApiKeyFromEnvFile("one\ntwo\n")).toBeUndefined();
	});
});

describe("resolveApiKey", () => {
	test("resolves env sources and reports only a fingerprint", async () => {
		const result = await resolveApiKey(`env:${PRIMARY_KEY_ENV}`, deps({ env: { TYPESAFE_API_KEY: SECRET } }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.resolved.key).toBe(SECRET);
		expect(result.resolved.source).toBe(`env:${PRIMARY_KEY_ENV}`);
		expect(result.resolved.fingerprint).toBe(fingerprintKey(SECRET));
		expect(result.resolved.fingerprint).toHaveLength(12);
		expect(result.resolved.fingerprint).not.toContain(SECRET);
	});

	test("fails open when an env source is missing or blank", async () => {
		for (const env of [{}, { TYPESAFE_API_KEY: "   " }]) {
			const result = await resolveApiKey(`env:${PRIMARY_KEY_ENV}`, deps({ env }));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain(PRIMARY_KEY_ENV);
		}
	});

	test("resolves file sources, expanding a leading tilde", async () => {
		const seen: string[] = [];
		const result = await resolveApiKey(
			"file:~/.pi/agent/skill-dispatch-poc/key.env",
			deps({
				readFile: (path) => {
					seen.push(path);
					return `${PRIMARY_KEY_ENV}=${SECRET}\n`;
				},
			}),
		);
		expect(seen).toEqual([`${HOME}/.pi/agent/skill-dispatch-poc/key.env`]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.resolved.key).toBe(SECRET);
		expect(result.resolved.source).toBe("file:" + `${HOME}/.pi/agent/skill-dispatch-poc/key.env`);
	});

	test("fails open on unreadable files and unparsable contents without leaking a key", async () => {
		const missing = await resolveApiKey(
			"file:/nope/key.env",
			deps({
				readFile: () => {
					throw new Error("ENOENT: no such file or directory");
				},
			}),
		);
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.error).toContain("cannot read key file /nope/key.env");

		const unparsable = await resolveApiKey("file:/nope/key.env", deps({ readFile: () => "OTHER=1" }));
		expect(unparsable.ok).toBe(false);
		if (unparsable.ok) return;
		expect(unparsable.error).toContain(PRIMARY_KEY_ENV);
	});

	test("resolves command sources and hides the command from status output", async () => {
		const calls: Array<{ command: string; timeoutMs: number }> = [];
		const result = await resolveApiKey(
			"command:gpg --decrypt /home/tester/key.env.gpg",
			deps({
				runCommand: async (command, timeoutMs): Promise<CommandResult> => {
					calls.push({ command, timeoutMs });
					return { stdout: `${SECRET}\n`, stderr: "", code: 0 };
				},
			}),
		);
		expect(calls).toEqual([
			{ command: "gpg --decrypt /home/tester/key.env.gpg", timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.resolved.key).toBe(SECRET);
		// Status output must not reveal what the command reads.
		expect(result.resolved.source).toBe("command:(hidden)");
	});

	test("fails open on non-zero exit, empty output, and thrown commands", async () => {
		const nonZero = await resolveApiKey(
			"command:false",
			deps({
				runCommand: async () => ({ stdout: "", stderr: `bad key ${SECRET}`, code: 1 }),
			}),
		);
		expect(nonZero.ok).toBe(false);
		if (nonZero.ok) return;
		expect(nonZero.error).toContain("code 1");
		expect(nonZero.error).not.toContain(SECRET);

		const empty = await resolveApiKey(
			"command:true",
			deps({ runCommand: async () => ({ stdout: "  \n", stderr: "", code: 0 }) }),
		);
		expect(empty.ok).toBe(false);
		if (empty.ok) return;
		expect(empty.error).toContain("no output");

		const thrown = await resolveApiKey(
			"command:boom",
			deps({
				runCommand: async () => {
					throw new Error(`spawn failed with ${SECRET}`);
				},
			}),
		);
		expect(thrown.ok).toBe(false);
		if (thrown.ok) return;
		expect(thrown.error).toContain("command failed");
		expect(thrown.error).not.toContain(SECRET);
	});

	test("rejects unsupported specs without touching any dependency", async () => {
		let touched = false;
		const result = await resolveApiKey(
			SECRET,
			deps({
				readFile: () => {
					touched = true;
					return "";
				},
				runCommand: async () => {
					touched = true;
					return { stdout: "", stderr: "", code: 0 };
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("unsupported apiKeySource");
		expect(touched).toBe(false);
		// Even the rejected spec must not be echoed back verbatim.
		expect(result.source).toBe("(unsupported)");
	});
});

describe("describeKeySource", () => {
	test("returns a redacted label", () => {
		expect(describeKeySource(`env:${ALIAS_KEY_ENV}`)).toBe(`env:${ALIAS_KEY_ENV}`);
		expect(describeKeySource("file:~/key.env", HOME)).toBe(`file:${HOME}/key.env`);
		expect(describeKeySource("command:op read op://vault/item")).toBe("command:(hidden)");
		expect(describeKeySource("garbage")).toBe("(unsupported)");
		expect(describeKeySource("")).toBe("(unset)");
	});
});

describe("redactSecrets", () => {
	test("masks long opaque runs and known key prefixes", () => {
		expect(redactSecrets(`key is ${SECRET} ok`)).not.toContain(SECRET);
		expect(redactSecrets("sk-abcdefghijklmno")).not.toContain("abcdefghijklmno");
		expect(redactSecrets("tsk_0123456789abcdef")).not.toContain("0123456789abcdef");
	});

	test("keeps ordinary diagnostic text readable", () => {
		expect(redactSecrets("ENOENT: no such file or directory, open '/nope/key.env'")).toBe(
			"ENOENT: no such file or directory, open '/nope/key.env'",
		);
	});
});
