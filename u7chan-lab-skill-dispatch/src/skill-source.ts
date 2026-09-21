/**
 * Skill roster scanning for the Skill dispatch PoC.
 *
 * The dispatcher and Pi must agree on which skills exist, so both read the
 * same `skillRoots`: Pi gets them through `resources_discover` and Jev gets
 * `name` + `description` built here.  Only the frontmatter is read; skill
 * bodies are never sent to the API and are only loaded by Pi after a dispatch.
 *
 * Scanning is local and read-only.  Results are cached by the caller, so this
 * module stays a pure function of the filesystem.
 */

import { readFileSync, readdirSync } from "node:fs";

/** Longest a description may be when it becomes a Jev criteria value. */
export const MAX_DESCRIPTION_CHARS = 600;

/** Maximum skills sent in one Choice.  The API accepts 255 options; one is `other`. */
export const MAX_SKILLS = 254;

export const DEFAULT_MAX_DEPTH = 4;

const IGNORED_DIRECTORIES = new Set(["node_modules", "references", "assets", "scripts", "tests"]);
const SKILL_FILE_NAME = "SKILL.md";

export interface SkillSummary {
	/** Frontmatter `name`, or the directory name when the frontmatter omits it. */
	readonly name: string;
	/** Frontmatter `description`, trimmed to a single line. */
	readonly description: string;
	/** Absolute path of the SKILL.md file. */
	readonly path: string;
	/** Root this skill was found under. */
	readonly root: string;
}

export interface SkillScan {
	readonly skills: readonly SkillSummary[];
	readonly warnings: readonly string[];
	/** True when the roster hit `MAX_SKILLS` and more skills were skipped. */
	readonly truncated: boolean;
}

export interface DirectoryEntryLike {
	readonly name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

/** Injected for tests; production callers use `node:fs`. */
export interface SkillScanDeps {
	readonly readdir?: (path: string) => readonly DirectoryEntryLike[];
	readonly readFile?: (path: string) => string;
	readonly maxDepth?: number;
}

interface Frontmatter {
	readonly name?: string;
	readonly description?: string;
	readonly issues: readonly string[];
}

function unquote(value: string): string {
	const first = value.at(0);
	if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
		return value.slice(1, -1).trim();
	}
	return value.trim();
}

/** Collapse a frontmatter value to one line and bound its length. */
function normalizeDescription(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_DESCRIPTION_CHARS
		? `${collapsed.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
		: collapsed;
}

/**
 * Parse the small subset of YAML frontmatter the Agent Skills standard uses.
 *
 * Only `name` and `description` are read.  Block scalars (`|`, `>`) and
 * indented continuations are accepted because long Japanese descriptions are
 * easy to wrap by hand; anything else is ignored rather than reported, so a
 * richer SKILL.md does not produce noise.
 */
export function parseSkillFrontmatter(text: string): Frontmatter {
	const issues: string[] = [];
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { issues: ["missing frontmatter block"] };

	let index = 1;
	const values = new Map<string, string>();
	let currentKey: string | undefined;
	let blockStyle: "|" | ">" | undefined;

	for (; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === "---") break;

		const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (keyMatch !== null) {
			const [, key, rawValue] = keyMatch;
			currentKey = key;
			const value = rawValue.trim();
			if (value === "|" || value === ">" || value === "|-" || value === ">-") {
				blockStyle = value.startsWith("|") ? "|" : ">";
				values.set(key, "");
				continue;
			}
			blockStyle = undefined;
			values.set(key, unquote(value));
			continue;
		}

		// An indented line continues the previous key.
		if (line.trim().length === 0 || currentKey === undefined) continue;
		const continuation = line.trim();
		const previous = values.get(currentKey) ?? "";
		if (blockStyle === "|") values.set(currentKey, previous.length === 0 ? continuation : `${previous}\n${continuation}`);
		else values.set(currentKey, previous.length === 0 ? continuation : `${previous} ${continuation}`);
	}

	if (index >= lines.length) issues.push("frontmatter block is not closed");

	const name = values.get("name")?.trim();
	const description = values.get("description")?.trim();
	if (name === undefined || name.length === 0) issues.push("frontmatter has no name");
	if (description === undefined || description.length === 0) issues.push("frontmatter has no description");

	return {
		...(name === undefined || name.length === 0 ? {} : { name }),
		...(description === undefined || description.length === 0 ? {} : { description }),
		issues,
	};
}

function defaultReaddir(path: string): readonly DirectoryEntryLike[] {
	return readdirSync(path, { withFileTypes: true });
}

function defaultReadFile(path: string): string {
	return readFileSync(path, "utf8");
}

function joinPath(parent: string, child: string): string {
	return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

/**
 * Find `SKILL.md` folders under the given roots.
 *
 * Sibling folders such as `references/` and `assets/` are skipped: a skill's
 * supporting files are not skills.  Symlinked directories are skipped too, so
 * a cyclic link cannot loop the scan.
 */
export function scanSkillRoots(roots: readonly string[], deps: SkillScanDeps = {}): SkillScan {
	const readdir = deps.readdir ?? defaultReaddir;
	const readFile = deps.readFile ?? defaultReadFile;
	const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;

	const skills: SkillSummary[] = [];
	const warnings: string[] = [];
	const seenNames = new Set<string>();
	let truncated = false;

	const walk = (directory: string, root: string, depth: number): void => {
		if (truncated || depth > maxDepth) return;

		let entries: readonly DirectoryEntryLike[];
		try {
			entries = readdir(directory);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`cannot read ${directory}: ${message}`);
			return;
		}

		const skillFile = entries.find((entry) => entry.isFile() && entry.name === SKILL_FILE_NAME);
		if (skillFile !== undefined) {
			const path = joinPath(directory, SKILL_FILE_NAME);
			try {
				const parsed = parseSkillFrontmatter(readFile(path));
				const directoryName = directory.slice(directory.lastIndexOf("/") + 1);
				const name = parsed.name ?? directoryName;
				if (parsed.description === undefined) {
					warnings.push(`${path}: no usable description, skill skipped`);
				} else if (seenNames.has(name)) {
					warnings.push(`${path}: duplicate skill name "${name}", skill skipped`);
				} else if (skills.length >= MAX_SKILLS) {
					truncated = true;
				} else {
					seenNames.add(name);
					skills.push({
						name,
						description: normalizeDescription(parsed.description),
						path,
						root,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`cannot read ${path}: ${message}`);
			}
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
			walk(joinPath(directory, entry.name), root, depth + 1);
		}
	};

	for (const root of roots) {
		walk(root.replace(/\/+$/, ""), root, 1);
	}

	skills.sort((left, right) => left.name.localeCompare(right.name));
	return { skills, warnings, truncated };
}

/**
 * Rough token estimate for status output and dry runs.
 *
 * CJK characters are close to one token each and ASCII averages roughly four
 * characters per token.  This is for pre-flight sizing only; the authoritative
 * numbers come back as `usage` from a live request.
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		const isCjk =
			(code >= 0x3000 && code <= 0x30ff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xff00 && code <= 0xffef);
		if (isCjk) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}

/** Size of the roster as it would be sent: name plus description per skill. */
export function rosterText(skills: readonly SkillSummary[]): string {
	return skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n");
}
