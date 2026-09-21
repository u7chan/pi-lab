/**
 * Measurement harness for the Skill dispatch thresholds.
 *
 * `run` sends every prompt in the set to Jev with the same request the
 * extension builds, and stores the raw answers.  `sweep` replays those raw
 * answers through every threshold combination, so the operating point is
 * chosen from data without paying for another API call.
 *
 * Usage:
 *   bun run eval/measure.ts run [--limit N] [--concurrency N] [--prompts FILE] [--roots DIR1,DIR2]
 *   bun run eval/measure.ts sweep [results.jsonl]
 *
 * The API key comes from the same `config.json` the extension uses; it is
 * never printed.  Prompts in this set are synthetic and safe to commit.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ANSWER_KEYS,
	INTERPRET_REASONS,
	buildDispatchRequest,
	interpretDispatch,
	OTHER_CHOICE,
	type DispatchThresholds,
} from "../src/dispatcher.ts";
import { pocPaths, resolveApiKey } from "../src/key-source.ts";
import { defaultConfig, parseConfig } from "../src/poc-store.ts";
import { scanSkillRoots } from "../src/skill-source.ts";
import { createTypeSafeClient, type SystemOneResponse } from "../src/typesafe-client.ts";

interface PromptCase {
	readonly id: string;
	readonly prompt: string;
	readonly expected: readonly string[];
	readonly note?: string;
}

interface ResultRow {
	readonly id: string;
	readonly prompt: string;
	readonly expected: readonly string[];
	readonly model: string;
	readonly latencyMs: number;
	readonly inputTokens?: number;
	readonly top: string;
	readonly confidence: number;
	readonly probabilities: Record<string, number>;
	readonly wantsAction: number;
	readonly specificTask: number;
	readonly error?: string;
}

const RESULTS_DIR = join(import.meta.dir, "results");
const DEFAULT_PROMPTS = join(import.meta.dir, "prompts.jsonl");

function readCases(path: string, limit: number): PromptCase[] {
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	const cases = lines.map((line) => JSON.parse(line) as PromptCase);
	return limit > 0 ? cases.slice(0, limit) : cases;
}

function loadConfig(): {
	roots: readonly string[];
	apiKeySource: string;
	model: string;
	timeoutMs: number;
	thresholds: DispatchThresholds;
} {
	const paths = pocPaths();
	const base = defaultConfig(paths);
	let config = base;
	try {
		config = parseConfig(readFileSync(paths.configFile, "utf8"), base).config;
	} catch {
		// No config yet: fall back to defaults so the error message is useful.
	}
	return {
		roots: config.skillRoots,
		apiKeySource: config.typesafe.apiKeySource,
		model: config.typesafe.model,
		timeoutMs: config.typesafe.timeoutMs,
		thresholds: {
			gate: config.gate,
			confidenceThreshold: config.threshold,
			otherThreshold: config.otherThreshold,
			noulThreshold: config.noulThreshold,
		},
	};
}

function expandHome(entry: string): string {
	const home = process.env.HOME ?? "";
	return entry.startsWith("~/") ? join(home, entry.slice(2)) : entry;
}

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
	return sorted[index] ?? 0;
}

function table(rows: readonly string[][], headers: readonly string[]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
	);
	const line = (cells: readonly string[]): string =>
		cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
	return [
		line(headers),
		widths.map((width) => "-".repeat(width)).join("  "),
		...rows.map((row) => line(row)),
	].join("\n");
}

async function run(cases: readonly PromptCase[], options: { concurrency: number; model: string; timeoutMs: number; apiKey: string; roots: readonly string[] }): Promise<ResultRow[]> {
	const scan = scanSkillRoots(options.roots.map(expandHome));
	if (scan.skills.length === 0) {
		throw new Error(`no skills found under: ${options.roots.join(", ") || "(skillRoots is empty)"}`);
	}
	if (scan.warnings.length > 0) console.error(`roster warnings: ${scan.warnings.length}`);
	console.error(`roster: ${scan.skills.length} skills (model ${options.model})`);

	const client = createTypeSafeClient({
		apiKey: options.apiKey,
		model: options.model,
		timeoutMs: options.timeoutMs,
	});

	const results: ResultRow[] = [];
	let cursor = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			const testCase = cases[index];
			if (testCase === undefined) return;

			const built = buildDispatchRequest(testCase.prompt, scan.skills);
			let outcome = await client.systemOne(built.request);
			if (!outcome.ok && outcome.failure.status === 429) {
				await new Promise((resolve) => setTimeout(resolve, 3000));
				outcome = await client.systemOne(built.request);
			}
			if (!outcome.ok) {
				results[index] = {
					id: testCase.id,
					prompt: testCase.prompt,
					expected: testCase.expected,
					model: options.model,
					latencyMs: outcome.latencyMs,
					top: "(error)",
					confidence: 0,
					probabilities: {},
					wantsAction: 0,
					specificTask: 0,
					error: `${outcome.failure.kind}: ${outcome.failure.error}`,
				};
				process.stderr.write(`! ${testCase.id}: ${outcome.failure.kind} ${outcome.failure.error}\n`);
				continue;
			}
			results[index] = toRow(testCase, outcome.response, outcome.latencyMs);
		}
	};

	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(options.concurrency, cases.length)) }, () => worker()),
	);

	return results;
}

function toRow(testCase: PromptCase, response: SystemOneResponse, latencyMs: number): ResultRow {
	const choice = response.answers[ANSWER_KEYS.skill];
	const wants = response.answers[ANSWER_KEYS.wantsAction];
	const specific = response.answers[ANSWER_KEYS.specificTask];
	return {
		id: testCase.id,
		prompt: testCase.prompt,
		expected: testCase.expected,
		model: response.model,
		latencyMs,
		...(response.usage?.input_tokens === undefined ? {} : { inputTokens: response.usage.input_tokens }),
		top: choice?.type === "choice" ? choice.choice : "(unusable)",
		confidence: choice?.type === "choice" ? choice.confidence : 0,
		probabilities: choice?.type === "choice" ? choice.probabilities : {},
		wantsAction: wants?.type === "noul" ? wants.noul : 0,
		specificTask: specific?.type === "noul" ? specific.noul : 0,
	};
}

interface Counts {
	hit: number;
	wrong: number;
	falsePositive: number;
	miss: number;
	correctAbstain: number;
}

const EMPTY_COUNTS: Counts = { hit: 0, wrong: 0, falsePositive: 0, miss: 0, correctAbstain: 0 };

function decide(row: ResultRow, thresholds: DispatchThresholds) {
	return interpretDispatch(
		{
			model: row.model,
			answers: {
				[ANSWER_KEYS.skill]: {
					type: "choice",
					choice: row.top,
					confidence: row.confidence,
					probabilities: row.probabilities,
				},
				[ANSWER_KEYS.wantsAction]: { type: "noul", noul: row.wantsAction },
				[ANSWER_KEYS.specificTask]: { type: "noul", noul: row.specificTask },
			},
		},
		thresholds,
		false,
	);
}

/** One prompt against one operating point.  A dispatch is only useful if the
 * expected roster entry contains the chosen skill. */
function classify(row: ResultRow, thresholds: DispatchThresholds): Counts {
	const decision = decide(row, thresholds);
	const covered = row.expected.length > 0;
	if (decision.kind === "dispatch") {
		if (!covered) return { ...EMPTY_COUNTS, falsePositive: 1 };
		if (row.expected.includes(decision.skill ?? "")) return { ...EMPTY_COUNTS, hit: 1 };
		return { ...EMPTY_COUNTS, wrong: 1 };
	}
	return covered ? { ...EMPTY_COUNTS, miss: 1 } : { ...EMPTY_COUNTS, correctAbstain: 1 };
}

function addCounts(left: Counts, right: Counts): Counts {
	return {
		hit: left.hit + right.hit,
		wrong: left.wrong + right.wrong,
		falsePositive: left.falsePositive + right.falsePositive,
		miss: left.miss + right.miss,
		correctAbstain: left.correctAbstain + right.correctAbstain,
	};
}

function totalsFor(rows: readonly ResultRow[], thresholds: DispatchThresholds): Counts {
	return rows.map((row) => classify(row, thresholds)).reduce(addCounts, { ...EMPTY_COUNTS });
}

/**
 * Print one threshold grid as `hit/wrong/FP/miss`.
 *
 * A wrong dispatch and a false positive are both errors the user feels; a miss
 * only costs the feature.  The grid makes that trade visible instead of
 * collapsing it into a single score.
 */
function grid(
	rows: readonly ResultRow[],
	base: DispatchThresholds,
	confidenceValues: readonly number[],
	gateValues: readonly number[],
	gate: "other" | "noul",
): string {
	const header = ["conf \\ gate", ...gateValues.map((value) => value.toFixed(2))];
	const body = confidenceValues.map((confidence) => [
		confidence.toFixed(2),
		...gateValues.map((value) => {
			const thresholds: DispatchThresholds =
				gate === "other"
					? { ...base, gate, confidenceThreshold: confidence, otherThreshold: value }
					: { ...base, gate, confidenceThreshold: confidence, noulThreshold: value };
			const totals = totalsFor(rows, thresholds);
			return `${totals.hit}/${totals.wrong}/${totals.falsePositive}/${totals.miss}`;
		}),
	]);
	return table(body, header);
}

function sweep(rows: readonly ResultRow[], configured: DispatchThresholds): void {
	const usable = rows.filter((row) => row.error === undefined);
	if (usable.length === 0) {
		console.error("no usable rows");
		return;
	}

	const latencies = usable.map((row) => row.latencyMs);
	const tokens = usable.map((row) => row.inputTokens ?? 0).reduce((sum, value) => sum + value, 0);
	const model = usable[0]?.model ?? "?";
	const covered = usable.filter((row) => row.expected.length > 0).length;
	const negative = usable.length - covered;
	console.log(
		`${usable.length} prompts (${covered} covered, ${negative} negative), model ${model}\n` +
			`latency p50 ${percentile(latencies, 0.5)}ms p95 ${percentile(latencies, 0.95)}ms max ${Math.max(...latencies)}ms, ` +
			`${tokens} input tokens total (avg ${Math.round(tokens / usable.length)}/call)`,
	);
	if (usable.length < rows.length) console.log(`(${rows.length - usable.length} rows had errors)`);

	const confidenceValues = [0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.8, 0.9];
	console.log("\nhit/wrong/FP/miss — gate: other probability <= X");
	console.log(grid(usable, configured, confidenceValues, [0.05, 0.1, 0.15, 0.2, 0.3, 0.5], "other"));
	console.log("\nhit/wrong/FP/miss — gate: mean(action nouls) >= X");
	console.log(grid(usable, configured, confidenceValues, [0.2, 0.3, 0.4, 0.5, 0.6, 0.7], "noul"));

	const totals = totalsFor(usable, configured);
	console.log(
		`\nat the configured operating point (gate ${configured.gate}, conf>=${configured.confidenceThreshold}, ` +
			`other<=${configured.otherThreshold}, noul>=${configured.noulThreshold}): ` +
			`hit=${totals.hit} wrong=${totals.wrong} FP=${totals.falsePositive} miss=${totals.miss} correct-abstain=${totals.correctAbstain}`,
	);

	const outcomes = new Map<string, number>();
	for (const row of usable) {
		const decision = decide(row, configured);
		const label = `${row.expected.length === 0 ? "none" : "covered"}:${decision.kind === "dispatch" ? "dispatch" : decision.reason}`;
		outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
	}
	console.log(
		`outcomes: ${[...outcomes.entries()].map(([key, count]) => `${key}=${count}`).join(" ")}`,
	);
	console.log(`reason codes: ${INTERPRET_REASONS.join(", ")}`);

	const detailRows = usable.map((row) => {
		const counts = classify(row, configured);
		const verdict =
			counts.hit === 1
				? "hit"
				: counts.wrong === 1
					? "WRONG"
					: counts.falsePositive === 1
						? "FP"
						: counts.miss === 1
							? "miss"
							: "ok";
		return [
			verdict,
			row.id,
			row.expected.join("/") || "(none)",
			row.top,
			row.confidence.toFixed(2),
			(row.probabilities[OTHER_CHOICE] ?? 0).toFixed(2),
			row.wantsAction.toFixed(2),
			row.specificTask.toFixed(2),
			`${row.latencyMs}ms`,
		];
	});
	console.log("\n" + table(detailRows, ["verdict", "id", "expected", "top", "conf", "other", "want", "task", "latency"]));

	const poor = usable.filter((row) => {
		const counts = classify(row, configured);
		return counts.miss === 1 || counts.wrong === 1 || counts.falsePositive === 1;
	});
	if (poor.length > 0) {
		console.log("\nerrors at the configured operating point:");
		for (const row of poor) {
			console.log(
				`  ${row.id}: expected ${row.expected.join("/") || "(none)"} → ${row.top} ${row.confidence.toFixed(2)} (${row.prompt.slice(0, 50)}…)`,
			);
		}
	}
}

async function main(): Promise<void> {
	const [subcommand = "run", ...rest] = process.argv.slice(2);
	const flag = (name: string, fallback: number): number => {
		const index = rest.indexOf(name);
		return index >= 0 ? Number(rest[index + 1]) : fallback;
	};
	const value = (name: string, fallback: string): string => {
		const index = rest.indexOf(name);
		return index >= 0 ? (rest[index + 1] ?? fallback) : fallback;
	};

	const config = loadConfig();

	if (subcommand === "run") {
		const resolved = await resolveApiKey(config.apiKeySource, { env: process.env });
		if (!resolved.ok) {
			console.error(`cannot resolve the API key: ${resolved.source} → ${resolved.error}`);
			process.exit(1);
		}
		const cases = readCases(value("--prompts", DEFAULT_PROMPTS), flag("--limit", 0));
		const rootOverride = value("--roots", "");
		const roots = rootOverride.length > 0 ? rootOverride.split(",").map((root) => root.trim()) : config.roots;
		const rows = await run(cases, {
			concurrency: flag("--concurrency", 3),
			model: value("--model", config.model),
			timeoutMs: flag("--timeout", config.timeoutMs),
			apiKey: resolved.resolved.key,
			roots,
		});
		mkdirSync(RESULTS_DIR, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const out = join(RESULTS_DIR, `${stamp}.jsonl`);
		writeFileSync(out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		console.error(`wrote ${out}`);
		writeFileSync(join(RESULTS_DIR, "latest.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		console.log(`\n${rows.length} prompts → ${out}`);
		const failures = rows.filter((row) => row.error !== undefined);
		if (failures.length > 0) console.log(`failures: ${failures.map((row) => row.id).join(", ")}`);
		console.log(`key: ${resolved.resolved.source} sha256:${resolved.resolved.fingerprint}`);
		return;
	}

	if (subcommand === "sweep") {
		const path = rest.find((part) => !part.startsWith("--")) ?? join(RESULTS_DIR, "latest.jsonl");
		const rows = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ResultRow);
		sweep(rows, config.thresholds);
		return;
	}

	console.error("usage: measure.ts run|sweep [--limit N] [--concurrency N] [--prompts FILE] [results.jsonl]");
	process.exit(1);
}

await main();
