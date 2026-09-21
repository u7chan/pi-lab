import { describe, expect, test } from "bun:test";
import {
	KEY_FILE_TEMPLATE,
	POC_MARKER_TEXT,
	defaultConfig,
	isPocMarker,
	parseConfig,
	pocPaths,
	serializeConfig,
} from "../.pi/extensions/skill-dispatch.ts";

const HOME = "/home/tester";
const PATHS = pocPaths({}, HOME);
const BASE = defaultConfig(PATHS);

describe("defaultConfig", () => {
	test("points the key source at the PoC key file and starts disabled", () => {
		expect(BASE.enabled).toBe(false);
		expect(BASE.skillRoots).toEqual([]);
		expect(BASE.threshold).toBe(0.7);
		expect(BASE.typesafe).toEqual({
			apiKeySource: `file:${HOME}/.pi/agent/skill-dispatch-poc/key.env`,
			model: "jev-latest",
			timeoutMs: 2000,
		});
	});
});

describe("parseConfig", () => {
	test("applies valid overrides", () => {
		const { config, warnings } = parseConfig(
			JSON.stringify({
				enabled: true,
				skillRoots: ["~/workspace/skill-stash"],
				projectAllowlist: ["/home/tester/workspace/lab/pi-lab"],
				threshold: 0.55,
				noulThreshold: 0.4,
				gate: "noul",
				otherThreshold: 0.2,
				maxDispatchesPerSession: 3,
				logPrompts: true,
				typesafe: { apiKeySource: "env:TYPESAFE_API_KEY", model: "jev-1.12", timeoutMs: 900 },
			}),
			BASE,
		);
		expect(warnings).toEqual([]);
		expect(config.enabled).toBe(true);
		expect(config.skillRoots).toEqual(["~/workspace/skill-stash"]);
		expect(config.projectAllowlist).toEqual(["/home/tester/workspace/lab/pi-lab"]);
		expect(config.threshold).toBe(0.55);
		expect(config.noulThreshold).toBe(0.4);
		expect(config.gate).toBe("noul");
		expect(config.otherThreshold).toBe(0.2);
		expect(config.maxDispatchesPerSession).toBe(3);
		expect(config.logPrompts).toBe(true);
		expect(config.typesafe).toEqual({
			apiKeySource: "env:TYPESAFE_API_KEY",
			model: "jev-1.12",
			timeoutMs: 900,
		});
	});

	test("keeps an invalid projectAllowlist empty so nothing is sent", () => {
		for (const value of ["all", [""], [1], { cwd: "/x" }]) {
			const { config, warnings } = parseConfig(JSON.stringify({ projectAllowlist: value }), BASE);
			expect(config.projectAllowlist).toEqual([]);
			expect(warnings.join("\n")).toContain("projectAllowlist");
		}
	});

	test("validates the gate and logging fields", () => {
		const { config, warnings } = parseConfig(
			JSON.stringify({
				noulThreshold: 2,
				otherThreshold: -0.1,
				gate: "either",
				maxDispatchesPerSession: -1,
				logPrompts: "yes",
			}),
			BASE,
		);
		expect(config.noulThreshold).toBe(BASE.noulThreshold);
		expect(config.otherThreshold).toBe(BASE.otherThreshold);
		expect(config.gate).toBe("other");
		expect(config.maxDispatchesPerSession).toBe(BASE.maxDispatchesPerSession);
		expect(config.logPrompts).toBe(false);
		expect(warnings).toHaveLength(5);
	});

	test("defaults the gate to the measured operating point", () => {
		expect(BASE.gate).toBe("other");
		expect(BASE.otherThreshold).toBe(0.15);
		expect(BASE.threshold).toBe(0.7);
	});

	test("keeps the default for every invalid field and explains why", () => {
		const { config, warnings } = parseConfig(
			JSON.stringify({
				enabled: "yes",
				skillRoots: ["", "ok"],
				threshold: 1.5,
				typesafe: { apiKeySource: "literal-key-value", model: "  ", timeoutMs: 0 },
			}),
			BASE,
		);
		expect(config).toEqual(BASE);
		expect(warnings).toHaveLength(6);
		expect(warnings.join("\n")).toContain("apiKeySource");
	});

	test("refuses literal secrets anywhere in the config", () => {
		const { warnings } = parseConfig(
			JSON.stringify({ typesafe: { apiKey: "tsk_leak", apiKeySource: "env:TYPESAFE_API_KEY" } }),
			BASE,
		);
		expect(warnings.join("\n")).toContain("apiKey");
		expect(warnings.join("\n")).toContain("literals are not supported");
	});

	test("falls back to defaults for broken JSON and non-object roots", () => {
		expect(parseConfig("{", BASE).config).toEqual(BASE);
		expect(parseConfig("{", BASE).warnings[0]).toContain("not valid JSON");
		expect(parseConfig("[]", BASE).warnings[0]).toContain("must be a JSON object");
	});

	test("ignores unknown fields without failing", () => {
		const { config, warnings } = parseConfig(
			JSON.stringify({ enabled: true, futureOption: { nested: true } }),
			BASE,
		);
		expect(warnings).toEqual([]);
		expect(config.enabled).toBe(true);
	});
});

describe("serializeConfig", () => {
	test("round-trips through parseConfig", () => {
		const config = {
			...BASE,
			enabled: true,
			skillRoots: ["~/workspace/skill-stash"],
		};
		const { config: parsed, warnings } = parseConfig(serializeConfig(config), BASE);
		expect(warnings).toEqual([]);
		expect(parsed).toEqual(config);
	});
});

describe("marker and key file template", () => {
	test("accepts its own marker and rejects anything else", () => {
		expect(isPocMarker(POC_MARKER_TEXT)).toBe(true);
		expect(isPocMarker('{"name":"other-poc","version":1}')).toBe(false);
		expect(isPocMarker('{"name":"u7chan-lab-skill-dispatch","version":2}')).toBe(false);
		expect(isPocMarker("not json")).toBe(false);
	});

	test("the template holds a placeholder, not a key", () => {
		expect(KEY_FILE_TEMPLATE).toContain("TYPESAFE_API_KEY=");
		expect(KEY_FILE_TEMPLATE.split("\n").every((line) => line.startsWith("#") || line === "" || line === "TYPESAFE_API_KEY=")).toBe(true);
	});
});
