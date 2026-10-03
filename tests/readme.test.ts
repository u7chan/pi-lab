/**
 * Keep the PoC table in the root README in sync with the repository.
 *
 * The table is the only place a reader learns whether an extension is shipped
 * through `pi.extensions` or is a dev-only PoC, so it drifts silently as soon
 * as a directory is added or registered.  This test derives both facts from the
 * filesystem and the manifest instead of trusting the prose.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REGISTERED = "登録済み";
const UNREGISTERED = "未登録";
const MIGRATION_STATES = ["未移行", "移行済み", "対象外"];

/** PoC directories as they exist on disk. */
function pocDirectories(): string[] {
	return readdirSync(ROOT)
		.filter((entry) => entry.startsWith("u7chan-lab-"))
		.filter((entry) => statSync(join(ROOT, entry)).isDirectory())
		.sort();
}

/** Directories that ship through the package manifest. */
function registeredDirectories(): { dirs: string[]; entries: string[] } {
	const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	const entries = manifest.pi?.extensions ?? [];
	return { entries, dirs: [...new Set(entries.map((entry) => entry.split("/")[0]!))].sort() };
}

/** Rows of the PoC table: directory, 配布 state, 移行状況, description. */
function tableRows(): { dir: string; state: string; migration: string }[] {
	const readme = readFileSync(join(ROOT, "README.md"), "utf8");
	return readme
		.split("\n")
		.map((line) => /^\|\s*`([^`]+)`\s*\|\s*\*{0,2}(登録済み|未登録)\*{0,2}\s*\|\s*([^|]*?)\s*\|/.exec(line))
		.filter((match) => match !== null)
		.map((match) => ({ dir: match![1]!, state: match![2]!, migration: match![3]! }));
}

describe("root README PoC table", () => {
	test("lists every PoC directory on disk", () => {
		const listed = tableRows().map((row) => row.dir);
		expect(listed.toSorted()).toEqual(pocDirectories());
	});

	test("matches the 配布 column to package.json pi.extensions", () => {
		const { dirs: registered } = registeredDirectories();
		const rows = tableRows();
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(`${row.dir}: ${row.state}`).toBe(
				`${row.dir}: ${registered.includes(row.dir) ? REGISTERED : UNREGISTERED}`,
			);
		}
	});

	test("gives every PoC a valid 移行状況 independent of 配布", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		expect(readme).toContain("| ディレクトリ | 配布 | 移行状況 | 内容 |");
		const rows = tableRows();
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(`${row.dir}: ${MIGRATION_STATES.includes(row.migration)}`).toBe(`${row.dir}: true`);
		}
	});

	test("points every registered entry at an existing file", () => {
		const { entries } = registeredDirectories();
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(`${entry}: ${existsSync(join(ROOT, entry))}`).toBe(`${entry}: true`);
		}
	});
});
