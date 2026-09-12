/**
 * Stats-free footer renderer for Pi.
 *
 * The built-in footer always prints the token/cost stats block
 * (`↑input ↓output R… W… CH% $cost`) next to the context-window usage.  This
 * PoC replaces the footer with one that keeps the parts that matter for
 * cache watching — context window, model info, and extension statuses — and
 * drops the always-growing token/cost block entirely.
 *
 * The rendering mirrors the built-in footer component (cwd line, context
 * colouring thresholds, right-aligned model info, alphabetically sorted
 * statuses) so switching between them does not feel different.
 */

export interface MinimalFooterTheme {
	fg(color: "dim" | "error" | "warning", text: string): string;
}

export interface ContextUsageInfo {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface FooterModelInfo {
	id?: string;
	provider?: string;
	reasoning?: boolean;
	contextWindow?: number;
}

/** The read-only footer data Pi hands to `ctx.ui.setFooter()` factories. */
export interface FooterRenderData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	/** Subscribe to git branch changes; returns the unsubscribe function. */
	onBranchChange(callback: () => void): () => void;
}

export interface FooterRenderInput {
	theme: MinimalFooterTheme;
	footerData: FooterRenderData;
	model?: FooterModelInfo;
	thinkingLevel?: string;
	cwd: string;
	home?: string;
	sessionName?: string;
	contextUsage?: ContextUsageInfo;
	width: number;
}

/** The slice of the Pi extension context the adapter needs. */
export interface MinimalFooterContext {
	mode: string;
	hasUI: boolean;
	model?: FooterModelInfo;
	thinkingLevel?: string;
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	getContextUsage(): ContextUsageInfo | undefined;
	ui: {
		setFooter(
			factory:
				| ((tui: { requestRender(): void }, theme: MinimalFooterTheme, footerData: FooterRenderData) => {
						invalidate(): void;
						dispose?(): void;
						render(width: number): string[];
				  })
				| undefined,
		): void;
	};
}

/** Same compaction as the built-in footer's formatTokens. */
export function formatFooterTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Escape sequences that occupy no columns: CSI (colours), OSC (hyperlinks,
 * window titles), and APC (kitty images).  OSC may end with BEL or ST, so
 * stripping `\x1b[...m` alone is not enough: an OSC 8 URL would count toward
 * the width and push real text (for example the PR number next to the
 * repository link) out of the footer.
 */
const ZERO_WIDTH_SEQUENCE =
	/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** One escape sequence or one character - the units truncation walks. */
const TOKEN = new RegExp(`${ZERO_WIDTH_SEQUENCE.source}|[\\s\\S]`, "g");

/** OSC 8 close: the same sequence with empty parameters and URI. */
const OSC8_CLOSE = /^\x1b\]8;;(?:\x07|\x1b\\)$/;

/** Visible length ignoring escape sequences. */
function visibleLength(text: string): number {
	return text.replace(ZERO_WIDTH_SEQUENCE, "").length;
}

/** ANSI/OSC-aware truncation: escape sequences never count toward the width. */
function truncate(text: string, width: number, ellipsis = ""): string {
	if (visibleLength(text) <= width) return text;
	const budget = Math.max(0, width - visibleLength(ellipsis));
	let out = "";
	let seen = 0;
	let openHyperlink = false;
	for (const token of text.match(TOKEN) ?? []) {
		if (token.startsWith("\x1b")) {
			out += token;
			if (token.startsWith("\x1b]8;")) openHyperlink = !OSC8_CLOSE.test(token);
			continue;
		}
		if (seen >= budget) break;
		out += token;
		seen++;
	}
	// Keep a truncated link from spanning the rest of the footer line.
	if (openHyperlink) out += "\x1b]8;;\x1b\\";
	return out + ellipsis;
}

function replaceHome(cwd: string, home?: string): string {
	if (!home || !cwd.startsWith(home)) return cwd;
	return `~${cwd.slice(home.length)}`;
}

/** Collapse whitespace like the built-in footer's sanitizeStatusText. */
function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** `2.0%/256k` or `?/256k`, coloured by the built-in thresholds. */
function formatContextUsage(input: FooterRenderInput): string {
	const contextWindow = input.contextUsage?.contextWindow ?? input.model?.contextWindow ?? 0;
	const windowText = formatFooterTokens(contextWindow);
	const percent = input.contextUsage?.percent;
	const text = percent === null || percent === undefined ? `?/${windowText}` : `${percent.toFixed(1)}%/${windowText}`;
	if (percent === null || percent === undefined) return input.theme.fg("dim", text);
	if (percent > 90) return input.theme.fg("error", text);
	if (percent > 70) return input.theme.fg("warning", text);
	return input.theme.fg("dim", text);
}

/** Right side of the stats line: `(provider) model • level`, as the built-in. */
function formatModelInfo(input: FooterRenderInput): string {
	const modelName = input.model?.id || "no-model";
	let info = modelName;
	if (input.model?.reasoning) {
		const level = input.thinkingLevel || "off";
		info = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
	}
	if (input.footerData.getAvailableProviderCount() > 1 && input.model?.provider) {
		info = `(${input.model.provider}) ${info}`;
	}
	return info;
}

function joinLeftRight(left: string, right: string, width: number): string {
	const minWidth = visibleLength(left);
	const rightWidth = visibleLength(right);
	const totalNeeded = minWidth + 2 + rightWidth;
	if (totalNeeded <= width) {
		return left + " ".repeat(width - minWidth - rightWidth) + right;
	}
	const availableForRight = width - minWidth - 2;
	if (availableForRight > 0) {
		const truncatedRight = truncate(right, availableForRight);
		const padding = " ".repeat(Math.max(0, width - minWidth - visibleLength(truncatedRight)));
		return left + padding + truncatedRight;
	}
	return left;
}

/**
 * The stats-free footer lines:
 * 1. `~/cwd (branch) • session`
 * 2. `context%/window` … right-aligned model info (no token/cost stats)
 * 3. extension statuses, sorted by key like the built-in footer
 */
export function buildFooterLines(input: FooterRenderInput): string[] {
	const { theme, width } = input;

	let pwd = replaceHome(input.cwd, input.home);
	const branch = input.footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	if (input.sessionName) pwd = `${pwd} • ${input.sessionName}`;
	const pwdLine = truncate(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

	const left = formatContextUsage(input);
	const right = formatModelInfo(input);
	const statsLine = joinLeftRight(left, theme.fg("dim", right), width);

	const lines = [pwdLine, truncate(statsLine, width)];
	const statuses = Array.from(input.footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text));
	if (statuses.length > 0) {
		lines.push(truncate(statuses.join(" "), width, theme.fg("dim", "...")));
	}
	return lines;
}
