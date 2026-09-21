import { describe, expect, test } from "bun:test";
import { evaluateGate, evaluateReadiness, isCwdAllowed, isWithin, type GateFacts } from "../src/gate.ts";

const base: GateFacts = {
	enabled: true,
	mode: "live",
	source: "interactive",
	text: "この関数をレビューして",
	cwd: "/home/u7dev/workspace/lab/pi-lab",
	allowlist: ["/home/u7dev/workspace/lab/pi-lab"],
	skillsPublished: true,
	dispatched: 0,
	maxDispatchesPerSession: 0,
};

const facts = (overrides: Partial<GateFacts> = {}): GateFacts => ({ ...base, ...overrides });

describe("isWithin", () => {
	test("matches the root itself and its children", () => {
		expect(isWithin("/a/b", "/a")).toBe(true);
		expect(isWithin("/a", "/a")).toBe(true);
		expect(isWithin("/a", "/a/")).toBe(true);
	});

	test("does not match a sibling that shares a prefix", () => {
		expect(isWithin("/a/bc", "/a/b")).toBe(false);
		expect(isWithin("/ab", "/a")).toBe(false);
		expect(isWithin("/a", "")).toBe(false);
	});
});

describe("isCwdAllowed", () => {
	test("requires an explicit root and matches any of them", () => {
		expect(isCwdAllowed("/x/y", [])).toBe(false);
		expect(isCwdAllowed("/x/y", ["/z", "/x"])).toBe(true);
		expect(isCwdAllowed("/x/y", ["/z"])).toBe(false);
	});
});

describe("evaluateGate", () => {
	test("allows an in-scope interactive prompt", () => {
		expect(evaluateGate(facts())).toEqual({ allowed: true });
	});

	test("denies when disabled, before anything else", () => {
		const verdict = evaluateGate(facts({ enabled: false, mode: "off", source: "rpc" }));
		expect(verdict).toEqual({ allowed: false, reason: "disabled in config" });
	});

	test("denies when the session mode is off", () => {
		expect(evaluateGate(facts({ mode: "off" }))).toEqual({
			allowed: false,
			reason: "session mode is off",
		});
	});

	test("denies non-interactive sources", () => {
		expect(evaluateGate(facts({ source: "extension" }))).toEqual({
			allowed: false,
			reason: "input source is extension",
		});
		expect(evaluateGate(facts({ source: "rpc" })).allowed).toBe(false);
	});

	test("denies slash commands, skills, and templates", () => {
		for (const text of ["/skill:review x", "/template foo", "/help", "  /skill:x"]) {
			expect(evaluateGate(facts({ text }))).toEqual({
				allowed: false,
				reason: "explicit command",
			});
		}
		expect(evaluateGate(facts({ text: "   " })).allowed).toBe(false);
	});

	test("denies every project when the allowlist is empty", () => {
		expect(evaluateGate(facts({ allowlist: [] }))).toEqual({
			allowed: false,
			reason: "projectAllowlist is empty",
		});
	});

	test("denies an out-of-scope project", () => {
		expect(evaluateGate(facts({ cwd: "/home/u7dev/workspace/other" }))).toEqual({
			allowed: false,
			reason: "cwd is outside projectAllowlist",
		});
	});

	test("enforces the session budget only when set", () => {
		expect(evaluateGate(facts({ dispatched: 3, maxDispatchesPerSession: 3 }))).toEqual({
			allowed: false,
			reason: "session dispatch budget reached",
		});
		expect(evaluateGate(facts({ dispatched: 2, maxDispatchesPerSession: 3 })).allowed).toBe(true);
		expect(evaluateGate(facts({ dispatched: 99, maxDispatchesPerSession: 0 })).allowed).toBe(true);
	});

	test("denies a live transform when Pi never published the skill roots", () => {
		// Enabling mid-session leaves Pi without the roots, so `/skill:<name>`
		// would not expand and the prompt would be lost instead of dispatched.
		expect(evaluateGate(facts({ skillsPublished: false }))).toEqual({
			allowed: false,
			reason: "skill roots were not published at startup",
		});
		expect(evaluateGate(facts({ skillsPublished: false, mode: "dry-run" })).allowed).toBe(true);
		expect(evaluateGate(facts({ skillsPublished: false, mode: "off" }))).toEqual({
			allowed: false,
			reason: "session mode is off",
		});
	});
});

describe("evaluateReadiness", () => {
	test("requires a roster and a resolvable key", () => {
		expect(evaluateReadiness({ skillCount: 29, keyAvailable: true })).toEqual({ allowed: true });
		expect(evaluateReadiness({ skillCount: 0, keyAvailable: true })).toEqual({
			allowed: false,
			reason: "no skills in the roster",
		});
		expect(evaluateReadiness({ skillCount: 29, keyAvailable: false })).toEqual({
			allowed: false,
			reason: "no API key",
		});
	});
});
