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
				threshold: 0.55,
				typesafe: { apiKeySource: "env:TYPESAFE_API_KEY", model: "jev-1.12", timeoutMs: 900 },
			}),
			BASE,
		);
		expect(warnings).toEqual([]);
		expect(config.enabled).toBe(true);
		expect(config.skillRoots).toEqual(["~/workspace/skill-stash"]);
		expect(config.threshold).toBe(0.55);
		expect(config.typesafe).toEqual({
			apiKeySource: "env:TYPESAFE_API_KEY",
			model: "jev-1.12",
			timeoutMs: 900,
		});
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
