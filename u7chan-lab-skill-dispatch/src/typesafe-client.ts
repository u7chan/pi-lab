/**
 * Minimal TypeSafe System One transport for the Skill dispatch PoC.
 *
 * The official SDK (`@typesafe-ai/sdk`) is the supported client, but this
 * transport sits in front of every user turn.  There the budget is 70-500ms
 * nominal, the only correct reaction to a slow dependency is Pi's normal
 * behavior, and the numbers we want back are latency and token usage.  So the
 * retry count stays at zero, the deadline is explicit, and every failure is a
 * value instead of an exception.  The request and response shapes mirror the
 * SDK so it can be swapped in later without touching the dispatcher.
 *
 * The API key is passed in by the caller and never logged; error text is
 * redacted before it reaches a caller.
 */

import { redactSecrets } from "./key-source.ts";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const SYSTEM_ONE_PATH = "/v1/systemone";

/**
 * Per-request deadline.  The vendor quotes 70-500ms; two seconds leaves room
 * for a cold connection while still being short enough that a failing
 * dependency does not stall the turn noticeably.
 */
export const DEFAULT_TIMEOUT_MS = 2000;

/** Text, or structured state such as a chat log or the current application state. */
export type EntryType = string | object | unknown[] | null;

export interface NoulQuestion {
	readonly type: "noul";
	readonly instructions: EntryType;
	readonly criteria?: { readonly yes?: EntryType; readonly no?: EntryType };
}

export interface ChoiceQuestion {
	readonly type: "choice";
	readonly instructions: EntryType;
	readonly criteria: Record<string, EntryType>;
}

export type Question = NoulQuestion | ChoiceQuestion;

export interface NoulResponse {
	readonly type: "noul";
	/** Probability of a yes answer, from zero to one. */
	readonly noul: number;
}

export interface ChoiceResponse {
	readonly type: "choice";
	/** The selected label. */
	readonly choice: string;
	readonly confidence: number;
	readonly probabilities: Record<string, number>;
}

export type Answer = NoulResponse | ChoiceResponse;

export interface SystemOneUsage {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
}

export interface SystemOneResponse {
	readonly model: string;
	readonly answers: Record<string, Answer>;
	readonly usage?: SystemOneUsage;
}

export interface SystemOneRequest {
	readonly state: EntryType;
	readonly questions: Record<string, Question>;
	readonly model?: string;
}

export type FailureKind = "timeout" | "aborted" | "network" | "http" | "parse";

export interface SystemOneFailure {
	readonly kind: FailureKind;
	/** Redacted, human-readable reason.  Safe for logs and status output. */
	readonly error: string;
	readonly status?: number;
}

/** Latency is reported on failures too: a timeout is a measurement, not just an error. */
export type SystemOneOutcome =
	| { readonly ok: true; readonly response: SystemOneResponse; readonly latencyMs: number }
	| { readonly ok: false; readonly failure: SystemOneFailure; readonly latencyMs: number };

export interface TypeSafeClientOptions {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof fetch;
	readonly userAgent?: string;
}

export interface SystemOneCallOptions {
	readonly signal?: AbortSignal;
}

export interface TypeSafeClient {
	systemOne(
		request: SystemOneRequest,
		options?: SystemOneCallOptions,
	): Promise<SystemOneOutcome>;
}

const HTTP_LABELS: Record<number, string> = {
	401: "invalid or missing API key",
	422: "request rejected",
	429: "rate limited",
	529: "service overloaded",
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Pull a short message out of an error body without trusting its shape. */
function detailFromBody(body: string): string | undefined {
	if (body.trim().length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "string") return parsed.slice(0, 200);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			const nested = record.error;
			const candidate =
				typeof record.message === "string"
					? record.message
					: typeof nested === "string"
						? nested
						: typeof nested === "object" && nested !== null
							? (nested as Record<string, unknown>).message
							: undefined;
			if (typeof candidate === "string") return candidate.slice(0, 200);
		}
	} catch {
		// Not JSON: fall through and report the status alone.
	}
	return undefined;
}

export function describeHttpFailure(status: number, body: string): string {
	const label = HTTP_LABELS[status] ?? `HTTP ${status}`;
	const detail = detailFromBody(body);
	return redactSecrets(detail === undefined ? label : `${label}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check only; the dispatcher validates the answers it actually reads. */
export function isSystemOneResponse(value: unknown): value is SystemOneResponse {
	return isRecord(value) && typeof value.model === "string" && isRecord(value.answers);
}

/**
 * Create a client.  A missing or blank key is rejected here as well as by the
 * key resolver, so no code path can send an unauthenticated request.
 */
export function createTypeSafeClient(options: TypeSafeClientOptions): TypeSafeClient {
	if (options.apiKey.trim().length === 0) {
		throw new Error("createTypeSafeClient requires a non-empty apiKey");
	}

	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const model = options.model ?? DEFAULT_MODEL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const userAgent = options.userAgent ?? "pi-lab-skill-dispatch";

	return {
		async systemOne(request, callOptions = {}) {
			const started = Date.now();
			const elapsed = (): number => Date.now() - started;
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const signal =
				callOptions.signal === undefined
					? timeoutSignal
					: AbortSignal.any([callOptions.signal, timeoutSignal]);

			const body = JSON.stringify({
				state: request.state,
				questions: request.questions,
				model: request.model ?? model,
			});

			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}${SYSTEM_ONE_PATH}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${options.apiKey}`,
						Accept: "application/json",
						"Content-Type": "application/json",
						"User-Agent": userAgent,
					},
					body,
					signal,
				});
			} catch (error) {
				if (callOptions.signal?.aborted === true) {
					return {
						ok: false,
						latencyMs: elapsed(),
						failure: { kind: "aborted", error: "aborted by caller" },
					};
				}
				if (timeoutSignal.aborted) {
					return {
						ok: false,
						latencyMs: elapsed(),
						failure: { kind: "timeout", error: `timed out after ${timeoutMs}ms` },
					};
				}
				return {
					ok: false,
					latencyMs: elapsed(),
					failure: { kind: "network", error: redactSecrets(messageOf(error)) },
				};
			}

			let text = "";
			try {
				text = await response.text();
			} catch {
				text = "";
			}

			if (!response.ok) {
				return {
					ok: false,
					latencyMs: elapsed(),
					failure: {
						kind: "http",
						status: response.status,
						error: describeHttpFailure(response.status, text),
					},
				};
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return {
					ok: false,
					latencyMs: elapsed(),
					failure: { kind: "parse", error: "response body was not JSON" },
				};
			}

			if (!isSystemOneResponse(parsed)) {
				return {
					ok: false,
					latencyMs: elapsed(),
					failure: { kind: "parse", error: "response did not match the System One shape" },
				};
			}

			return { ok: true, response: parsed, latencyMs: elapsed() };
		},
	};
}
