import { describe, expect, test } from "bun:test";
import {
	buildDispatchRequest,
	buildTransformText,
	formatDecision,
	interpretDispatch,
	MAX_STATE_CHARS,
	OTHER_CHOICE,
	OTHER_CRITERIA,
	ANSWER_KEYS,
} from "../src/dispatcher.ts";
import type { SkillSummary } from "../src/skill-source.ts";
import type { DispatchThresholds } from "../src/dispatcher.ts";
import type { SystemOneResponse } from "../src/typesafe-client.ts";

const skills: readonly SkillSummary[] = [
	{ name: "docker", description: "Docker 環境を計測して改善する", path: "/s/docker/SKILL.md", root: "/s" },
	{ name: "review", description: "コード変更をレビューする", path: "/s/review/SKILL.md", root: "/s" },
];

/** Default operating point measured in eval/report.md: gate on P(other). */
const otherGate: DispatchThresholds = {
	gate: "other",
	confidenceThreshold: 0.7,
	otherThreshold: 0.15,
	noulThreshold: 0.5,
};

/** The rejected alternative, kept so the difference stays covered by tests. */
const noulGate: DispatchThresholds = { ...otherGate, gate: "noul" };

const response = (overrides: {
	choice?: string;
	confidence?: number;
	probabilities?: Record<string, number>;
	wantsAction?: number;
	specificTask?: number;
	skip?: "choice" | "noul";
}): SystemOneResponse => {
	const answers: SystemOneResponse["answers"] = {
		[ANSWER_KEYS.skill]: {
			type: "choice",
			choice: overrides.choice ?? "review",
			confidence: overrides.confidence ?? 0.9,
			probabilities: overrides.probabilities ?? { review: 0.9, docker: 0.05, [OTHER_CHOICE]: 0.05 },
		},
		[ANSWER_KEYS.wantsAction]: { type: "noul", noul: overrides.wantsAction ?? 0.95 },
		[ANSWER_KEYS.specificTask]: { type: "noul", noul: overrides.specificTask ?? 0.9 },
		usage: undefined as never,
	};
	if (overrides.skip === "choice") delete answers[ANSWER_KEYS.skill];
	if (overrides.skip === "noul") delete answers[ANSWER_KEYS.wantsAction];
	delete answers.usage;
	return { model: "jev-1.13.0", answers, usage: { input_tokens: 900, output_tokens: 20 } };
};

describe("buildDispatchRequest", () => {
	test("sends every skill plus other in the caller's order", () => {
		const { request } = buildDispatchRequest("この変更をレビューして", skills);
		const choice = request.questions[ANSWER_KEYS.skill];
		expect(choice.type).toBe("choice");
		if (choice.type !== "choice") return;
		expect(Object.keys(choice.criteria)).toEqual(["docker", "review", OTHER_CHOICE]);
		expect(choice.criteria[OTHER_CHOICE]).toBe(OTHER_CRITERIA);
		expect(choice.criteria.review).toBe("コード変更をレビューする");
	});

	test("asks both action gates as noul questions about the request", () => {
		const { request } = buildDispatchRequest("レビューして", skills);
		expect(request.questions[ANSWER_KEYS.wantsAction]?.type).toBe("noul");
		expect(request.questions[ANSWER_KEYS.specificTask]?.type).toBe("noul");
	});

	test("clamps a long prompt and reports it", () => {
		const long = "あ".repeat(MAX_STATE_CHARS + 100);
		const { request, truncated } = buildDispatchRequest(long, skills);
		expect(truncated).toBe(true);
		expect(String(request.state).length).toBeLessThan(long.length);
		expect(String(request.state).startsWith("あ")).toBe(true);
	});

	test("does not clamp a normal prompt", () => {
		const { request, truncated } = buildDispatchRequest("レビューして", skills);
		expect(truncated).toBe(false);
		expect(request.state).toBe("レビューして");
	});
});

describe("interpretDispatch", () => {
	test("dispatches a confident in-roster choice", () => {
		const decision = interpretDispatch(response({}), otherGate, false);
		expect(decision.kind).toBe("dispatch");
		expect(decision.skill).toBe("review");
		expect(decision.reason).toBe("confident");
		expect(decision.model).toBe("jev-1.13.0");
		expect(decision.usage?.input_tokens).toBe(900);
		expect(decision.gates.mean).toBeCloseTo(0.925, 5);
	});

	test("abstains when the model picks other", () => {
		const decision = interpretDispatch(
			response({ choice: OTHER_CHOICE, confidence: 0.8 }),
			otherGate,
			false,
		);
		expect(decision).toMatchObject({ kind: "abstain", reason: "choice-other" });
		expect(decision.skill).toBeUndefined();
	});

	test("abstains when the action gates say no", () => {
		const decision = interpretDispatch(response({ wantsAction: 0.2, specificTask: 0.1 }), noulGate, false);
		expect(decision).toMatchObject({ kind: "abstain", reason: "noul-gate" });
		expect(decision.gates.mean).toBeCloseTo(0.15, 5);
	});

	test("abstains on low confidence even with a valid choice", () => {
		const decision = interpretDispatch(response({ confidence: 0.51 }), otherGate, false);
		expect(decision).toMatchObject({ kind: "abstain", reason: "low-confidence" });
	});

	test("checks other before the gates so the reason is the useful one", () => {
		const decision = interpretDispatch(
			response({ choice: OTHER_CHOICE, wantsAction: 0.1, specificTask: 0.1 }),
			otherGate,
			false,
		);
		expect(decision.reason).toBe("choice-other");
	});

	test("survives missing or mistyped answers", () => {
		expect(interpretDispatch(response({ skip: "choice" }), otherGate, false).reason).toBe(
			"unusable-choice-answer",
		);
		expect(interpretDispatch(response({ skip: "noul" }), otherGate, false).reason).toBe(
			"unusable-noul-answer",
		);
		const mistyped = response({});
		mistyped.answers[ANSWER_KEYS.skill] = { type: "noul", noul: 1 };
		expect(interpretDispatch(mistyped, otherGate, false).reason).toBe("unusable-choice-answer");
	});

	test("carries the truncation flag through", () => {
		expect(interpretDispatch(response({}), otherGate, true).truncated).toBe(true);
	});
});

describe("gate modes", () => {
	test("the other-probability gate rejects a high P(other) even with strong action gates", () => {
		const decision = interpretDispatch(
			response({ probabilities: { review: 0.6, docker: 0.2, [OTHER_CHOICE]: 0.2 } }),
			otherGate,
			false,
		);
		expect(decision).toMatchObject({ kind: "abstain", reason: "other-probability" });
	});

	test("the noul gate ignores P(other)", () => {
		const decision = interpretDispatch(
			response({ probabilities: { review: 0.6, docker: 0.2, [OTHER_CHOICE]: 0.2 } }),
			noulGate,
			false,
		);
		expect(decision).toMatchObject({ kind: "dispatch", skill: "review" });
	});

	test("a missing other probability counts as zero", () => {
		const decision = interpretDispatch(
			response({ probabilities: { review: 1 } }),
			otherGate,
			false,
		);
		expect(decision.kind).toBe("dispatch");
	});

	test("the confidence floor still applies after the other gate", () => {
		const decision = interpretDispatch(
			response({ confidence: 0.4, probabilities: { review: 0.4, docker: 0.3, [OTHER_CHOICE]: 0.1 } }),
			otherGate,
			false,
		);
		expect(decision.reason).toBe("low-confidence");
	});
});

describe("buildTransformText", () => {
	test("prefixes the skill command and keeps the prompt intact", () => {
		expect(buildTransformText("review", "この PR を見て")).toBe("/skill:review この PR を見て");
	});
});

describe("formatDecision", () => {
	test("summarizes dispatch and abstain", () => {
		expect(formatDecision(interpretDispatch(response({}), otherGate, false))).toContain("dispatch review");
		expect(formatDecision(interpretDispatch(response({ choice: OTHER_CHOICE }), otherGate, false))).toContain(
			"abstain choice-other",
		);
	});
});
