/**
 * Keep the PoC table in the root README in sync with the repository.
 *
 * The table lists all PoCs; a separate note identifies those not shipped through
 * `pi.extensions`. Derive both facts from the filesystem and manifest so the
 * documentation cannot silently drift when a directory is added or registered.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MIGRATION_STATES = ["未移行", "✅", "—"];

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

/** Rows of the PoC table: directory, migration status, description. */
function tableRows(): { dir: string; migration: string }[] {
	const readme = readFileSync(join(ROOT, "README.md"), "utf8");
	return readme
		.split("\n")
		.map((line) => /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*[^|]+\|\s*$/.exec(line))
		.filter((match) => match !== null)
		.map((match) => ({ dir: match![1]!, migration: match![2]! }));
}

describe("root README PoC table", () => {
	test("lists every PoC directory on disk", () => {
		const listed = tableRows().map((row) => row.dir);
		expect(listed.toSorted()).toEqual(pocDirectories());
	});

	test("matches the distribution exclusion note to package.json pi.extensions", () => {
		const { dirs: registered } = registeredDirectories();
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const notes = readme.split("\n").filter((line) => line.startsWith("配布対象外:"));
		expect(notes).toHaveLength(1);
		const excluded = [...notes[0]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
		expect(excluded.toSorted()).toEqual(pocDirectories().filter((dir) => !registered.includes(dir)));
	});

	test("gives every PoC a valid migration status independent of distribution", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		expect(readme).toContain("| ディレクトリ | 移行 | 内容 |");
		expect(readme).toContain("✅が移行済み、—が対象外");
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
