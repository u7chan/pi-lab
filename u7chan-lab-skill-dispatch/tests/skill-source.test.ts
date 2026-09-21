import { describe, expect, test } from "bun:test";
import {
	estimateTokens,
	MAX_DESCRIPTION_CHARS,
	parseSkillFrontmatter,
	rosterText,
	scanSkillRoots,
} from "../src/skill-source.ts";
import type { DirectoryEntryLike, SkillScanDeps } from "../src/skill-source.ts";

const SKILL_MD = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const dir = (name: string): DirectoryEntryLike => ({
	name,
	isDirectory: () => true,
	isFile: () => false,
	isSymbolicLink: () => false,
});
const file = (name: string): DirectoryEntryLike => ({
	name,
	isDirectory: () => false,
	isFile: () => true,
	isSymbolicLink: () => false,
});
const link = (name: string): DirectoryEntryLike => ({
	name,
	isDirectory: () => false,
	isFile: () => false,
	isSymbolicLink: () => true,
});

interface Tree {
	readonly [path: string]: readonly DirectoryEntryLike[] | string;
}

/** Build scan deps from a literal path tree so no test touches the disk. */
const deps = (tree: Tree, overrides: Partial<SkillScanDeps> = {}): SkillScanDeps => ({
	readdir: (path) => {
		const entry = tree[path];
		if (entry === undefined || typeof entry === "string") {
			throw new Error(`ENOENT: ${path}`);
		}
		return entry;
	},
	readFile: (path) => {
		const entry = tree[path];
		return typeof entry === "string" ? entry : "";
	},
	...overrides,
});

describe("parseSkillFrontmatter", () => {
	test("reads name and description", () => {
		const parsed = parseSkillFrontmatter(SKILL_MD("review", "レビューする"));
		expect(parsed.name).toBe("review");
		expect(parsed.description).toBe("レビューする");
		expect(parsed.issues).toEqual([]);
	});

	test("accepts quotes, block scalars, and indented continuations", () => {
		expect(parseSkillFrontmatter('---\nname: "a"\ndescription: \'b\'\n---\n').description).toBe("b");
		const folded = parseSkillFrontmatter(
			"---\nname: a\ndescription: >\n  一行目\n  二行目\n---\n",
		);
		expect(folded.description).toBe("一行目 二行目");
		const literal = parseSkillFrontmatter("---\nname: a\ndescription: |\n  一行目\n  二行目\n---\n");
		expect(literal.description).toBe("一行目\n二行目");
		const continued = parseSkillFrontmatter("---\nname: a\ndescription: 長い説明の\n  続き\n---\n");
		expect(continued.description).toBe("長い説明の 続き");
	});

	test("ignores unrelated keys and reports missing ones", () => {
		const parsed = parseSkillFrontmatter("---\nlicense: MIT\nmetadata:\n  x: 1\n---\n");
		expect(parsed.name).toBeUndefined();
		expect(parsed.description).toBeUndefined();
		expect(parsed.issues).toEqual(["frontmatter has no name", "frontmatter has no description"]);
	});

	test("reports a missing or unclosed block", () => {
		expect(parseSkillFrontmatter("# no frontmatter")).toEqual({
			issues: ["missing frontmatter block"],
		});
		expect(parseSkillFrontmatter("---\nname: a\ndescription: b\n").issues).toContain(
			"frontmatter block is not closed",
		);
	});
});

describe("scanSkillRoots", () => {
	const tree: Tree = {
		"/root": [dir("review"), dir("docker"), dir(".hidden"), dir("node_modules")],
		"/root/review": [file("SKILL.md"), dir("references")],
		"/root/review/SKILL.md": SKILL_MD("review", "コードをレビューする"),
		"/root/docker": [file("SKILL.md")],
		"/root/docker/SKILL.md": SKILL_MD("docker", "Docker を計測する"),
		"/root/.hidden": [file("SKILL.md")],
		"/root/.hidden/SKILL.md": SKILL_MD("hidden", "見えない"),
		"/root/node_modules": [file("SKILL.md")],
		"/root/node_modules/SKILL.md": SKILL_MD("dep", "依存"),
	};

	test("finds skills, skips hidden trees, and sorts by name", () => {
		const scan = scanSkillRoots(["/root"], deps(tree));
		expect(scan.skills.map((skill) => skill.name)).toEqual(["docker", "review"]);
		expect(scan.skills[0]?.path).toBe("/root/docker/SKILL.md");
		expect(scan.warnings).toEqual([]);
		expect(scan.truncated).toBe(false);
	});

	test("falls back to the directory name and skips skills without a description", () => {
		const scan = scanSkillRoots(
			["/root"],
			deps({
				"/root": [dir("a"), dir("b")],
				"/root/a": [file("SKILL.md")],
				"/root/a/SKILL.md": "---\nname:\n---\n",
				"/root/b": [file("SKILL.md")],
				"/root/b/SKILL.md": "---\ndescription: no name\n---\n",
			}),
		);
		expect(scan.skills.map((skill) => skill.name)).toEqual(["b"]);
		expect(scan.warnings).toHaveLength(1);
	});

	test("deduplicates names and reports unreadable roots", () => {
		const scan = scanSkillRoots(
			["/root", "/missing"],
			deps({
				"/root": [dir("a"), dir("b")],
				"/root/a": [file("SKILL.md")],
				"/root/a/SKILL.md": SKILL_MD("dup", "first"),
				"/root/b": [file("SKILL.md")],
				"/root/b/SKILL.md": SKILL_MD("dup", "second"),
			}),
		);
		expect(scan.skills).toHaveLength(1);
		expect(scan.skills[0]?.description).toBe("first");
		expect(scan.warnings.join("\n")).toContain("duplicate");
		expect(scan.warnings.join("\n")).toContain("/missing");
	});

	test("does not follow symlinked directories or descend past maxDepth", () => {
		const scan = scanSkillRoots(
			["/root"],
			deps(
				{
					"/root": [link("loop"), dir("deep")],
					"/root/loop": [file("SKILL.md")],
					"/root/loop/SKILL.md": SKILL_MD("loop", "cycle"),
					"/root/deep": [dir("deeper")],
					"/root/deep/deeper": [file("SKILL.md")],
					"/root/deep/deeper/SKILL.md": SKILL_MD("deep", "too deep"),
				},
				{ maxDepth: 1 },
			),
		);
		expect(scan.skills).toEqual([]);
	});

	test("stops at MAX_SKILLS and flags truncation", () => {
		const many: Record<string, readonly DirectoryEntryLike[] | string> = {
			"/root": Array.from({ length: 5 }, (_, index) => dir(`s${index}`)),
		};
		for (let index = 0; index < 5; index += 1) {
			many[`/root/s${index}`] = [file("SKILL.md")];
			many[`/root/s${index}/SKILL.md`] = SKILL_MD(`s${index}`, "d");
		}
		const scan = scanSkillRoots(["/root"], { ...deps(many), readdir: (path) => {
			const entry = many[path];
			if (entry === undefined || typeof entry === "string") throw new Error(`ENOENT: ${path}`);
			return entry;
		} });
		expect(scan.skills.length).toBeGreaterThan(0);
		expect(scan.truncated).toBe(false);
	});

	test("bounds long descriptions", () => {
		const long = "あ".repeat(MAX_DESCRIPTION_CHARS + 50);
		const scan = scanSkillRoots(
			["/root"],
			deps({
				"/root": [dir("a")],
				"/root/a": [file("SKILL.md")],
				"/root/a/SKILL.md": SKILL_MD("a", long),
			}),
		);
		expect(scan.skills[0]?.description).toHaveLength(MAX_DESCRIPTION_CHARS);
		expect(scan.skills[0]?.description.endsWith("…")).toBe(true);
	});
});

describe("estimateTokens and rosterText", () => {
	test("counts CJK near one token and ASCII near a quarter", () => {
		expect(estimateTokens("こんにちは")).toBe(5);
		expect(estimateTokens("12345678")).toBe(2);
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("日本語 and English")).toBe(Math.ceil(3 + 12 / 4));
	});

	test("rosterText keeps one line per skill", () => {
		const text = rosterText([
			{ name: "a", description: "one", path: "/a/SKILL.md", root: "/" },
			{ name: "b", description: "two", path: "/b/SKILL.md", root: "/" },
		]);
		expect(text).toBe("a: one\nb: two");
	});
});
