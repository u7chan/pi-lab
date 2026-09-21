import { describe, expect, test } from "bun:test";
import {
	createTypeSafeClient,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	describeHttpFailure,
	isSystemOneResponse,
} from "../.pi/extensions/skill-dispatch.ts";
import type { SystemOneRequest } from "../src/typesafe-client.ts";

const KEY = "tsk_unit_test_key_0123456789abcdef";

const request: SystemOneRequest = {
	state: "こんにちは",
	questions: { greeting: { type: "noul", instructions: "挨拶ですか" } },
};

const okBody = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		model: DEFAULT_MODEL,
		answers: { greeting: { type: "noul", noul: 0.98 } },
		usage: { input_tokens: 12, output_tokens: 0 },
		...overrides,
	});

interface SeenRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
}

function jsonFetch(body: string, status = 200): { fetch: typeof fetch; seen: SeenRequest[] } {
	const seen: SeenRequest[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({
			url: String(input),
			method: init?.method,
			headers: init?.headers as Record<string, string>,
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetch: impl, seen };
}

describe("createTypeSafeClient", () => {
	test("posts to the System One path with auth and the resolved model", async () => {
		const { fetch, seen } = jsonFetch(okBody());
		const client = createTypeSafeClient({ apiKey: KEY, fetch });
		const outcome = await client.systemOne(request);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.response.answers.greeting).toEqual({ type: "noul", noul: 0.98 });
		expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);

		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe(`${DEFAULT_BASE_URL}/v1/systemone`);
		expect(seen[0].method).toBe("POST");
		expect(seen[0].headers?.Authorization).toBe(`Bearer ${KEY}`);
		expect(seen[0].body).toEqual({
			state: "こんにちは",
			questions: request.questions,
			model: DEFAULT_MODEL,
		});
	});

	test("honors baseUrl, model, and per-request model overrides", async () => {
		const { fetch, seen } = jsonFetch(okBody());
		const client = createTypeSafeClient({
			apiKey: KEY,
			baseUrl: "https://example.test/",
			model: "jev-1.12",
			fetch,
		});
		await client.systemOne(request);
		await client.systemOne({ ...request, model: "jev-latest" });

		expect(seen[0].url).toBe("https://example.test/v1/systemone");
		expect((seen[0].body as { model: string }).model).toBe("jev-1.12");
		expect((seen[1].body as { model: string }).model).toBe("jev-latest");
	});

	test("rejects a blank key so no unauthenticated request is possible", () => {
		const { fetch } = jsonFetch(okBody());
		expect(() => createTypeSafeClient({ apiKey: "   ", fetch })).toThrow("non-empty apiKey");
	});

	test("maps an HTTP error to a redacted failure with the status", async () => {
		const { fetch } = jsonFetch(JSON.stringify({ error: { message: "invalid key" } }), 401);
		const outcome = await createTypeSafeClient({ apiKey: KEY, fetch }).systemOne(request);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.failure.kind).toBe("http");
		expect(outcome.failure.status).toBe(401);
		expect(outcome.failure.error).toContain("invalid or missing API key");
	});

	test("never lets a server that echoes the key leak it into the failure", async () => {
		const { fetch } = jsonFetch(JSON.stringify({ message: `bad key ${KEY}` }), 401);
		const outcome = await createTypeSafeClient({ apiKey: KEY, fetch }).systemOne(request);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.failure.error).not.toContain(KEY);
	});

	test("reports a timeout as a measurement, not an exception", async () => {
		const hangingFetch = ((_: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as typeof fetch;
		const outcome = await createTypeSafeClient({
			apiKey: KEY,
			fetch: hangingFetch,
			timeoutMs: 10,
		}).systemOne(request);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.failure.kind).toBe("timeout");
		expect(outcome.failure.error).toContain("timed out after 10ms");
	});

	test("distinguishes a caller abort from a timeout", async () => {
		const hangingFetch = ((_: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as typeof fetch;
		const controller = new AbortController();
		const promise = createTypeSafeClient({ apiKey: KEY, fetch: hangingFetch, timeoutMs: 5000 }).systemOne(
			request,
			{ signal: controller.signal },
		);
		controller.abort();
		const outcome = await promise;

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.failure.kind).toBe("aborted");
	});

	test("classifies network, body, and shape failures", async () => {
		const failingFetch = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as typeof fetch;
		const network = await createTypeSafeClient({ apiKey: KEY, fetch: failingFetch }).systemOne(request);
		expect(network.ok).toBe(false);
		if (network.ok) return;
		expect(network.failure.kind).toBe("network");

		const notJson = jsonFetch("<html>gateway</html>");
		const parse = await createTypeSafeClient({ apiKey: KEY, fetch: notJson.fetch }).systemOne(request);
		expect(parse.ok).toBe(false);
		if (parse.ok) return;
		expect(parse.failure.kind).toBe("parse");

		const wrongShape = jsonFetch(JSON.stringify({ model: "jev-latest" }));
		const shape = await createTypeSafeClient({ apiKey: KEY, fetch: wrongShape.fetch }).systemOne(request);
		expect(shape.ok).toBe(false);
		if (shape.ok) return;
		expect(shape.failure.error).toContain("System One shape");
	});
});

describe("describeHttpFailure", () => {
	test("labels known statuses and appends a bounded detail", () => {
		expect(describeHttpFailure(529, "")).toBe("service overloaded");
		expect(describeHttpFailure(503, "")).toBe("HTTP 503");
		const long = describeHttpFailure(422, JSON.stringify({ message: "missing field ".repeat(40) }));
		expect(long.startsWith("request rejected: missing field")).toBe(true);
		expect(long.length).toBe(200 + "request rejected: ".length);
		// A detail that is one long opaque run is masked rather than shown.
		expect(describeHttpFailure(422, JSON.stringify({ message: "x".repeat(500) }))).toBe(
			"request rejected: ***",
		);
	});
});

describe("isSystemOneResponse", () => {
	test("accepts the documented shape and rejects near misses", () => {
		expect(isSystemOneResponse({ model: "jev-latest", answers: {} })).toBe(true);
		expect(isSystemOneResponse({ model: "jev-latest" })).toBe(false);
		expect(isSystemOneResponse({ answers: {} })).toBe(false);
		expect(isSystemOneResponse([])).toBe(false);
		expect(isSystemOneResponse(null)).toBe(false);
	});
});
