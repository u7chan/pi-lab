/**
 * Skill dispatch decision for the PoC.
 *
 * One request carries the whole decision: a `Choice` over every skill name
 * plus `other`, and two `Noul` gates that ask whether the request wants work
 * done at all.  Questions are evaluated in isolation, so the `Noul`s talk
 * about the request itself and never refer to the roster.
 *
 * Everything that shaped a decision is returned, not just the winner: the
 * probabilities, the gate values, the model that answered, and the token
 * usage.  The PoC exists to measure false positives and false negatives, which
 * is impossible from a name alone.
 *
 * Instructions are Japanese because the prompts and descriptions are Japanese.
 * `INSTRUCTION_VERSION` is logged so measurements stay comparable after a
 * wording change.
 */

import type { SkillSummary } from "./skill-source.ts";
import type {
	NoulQuestion,
	SystemOneRequest,
	SystemOneResponse,
	SystemOneUsage,
} from "./typesafe-client.ts";

/** Answer key for the `other` option; also the abstain signal. */
export const OTHER_CHOICE = "other";

/** Bump when any instruction text below changes. */
export const INSTRUCTION_VERSION = "ja-1";

/** Named answers in the request, kept together so logs and tests agree. */
export const ANSWER_KEYS = {
	skill: "skill",
	wantsAction: "wants_action",
	specificTask: "specific_task",
} as const;

/** Above this the prompt is clamped before it is sent. */
export const MAX_STATE_CHARS = 4000;
const HEAD_CHARS = 3000;

export const SKILL_CHOICE_INSTRUCTIONS =
	"次の依頼に最も適したスキルを criteria から1つ選んでください。" +
	"スキルは、依頼された作業を進めるための手順を提供します。" +
	"criteria の中にこの依頼に合うものがない場合は other を選んでください。";

export const WANTS_ACTION_INSTRUCTIONS =
	"この依頼は、何らかの作業の実行を求めていますか。" +
	"説明・解説・意見・雑談だけを求めている場合は、いいえと判断してください。";

export const SPECIFIC_TASK_INSTRUCTIONS =
	"この依頼は、具体的な対象や成果物を伴う作業の依頼ですか。" +
	"一般知識の質問、挨拶、相づちだけの場合は、いいえと判断してください。";

export const OTHER_CRITERIA = "上記のどのスキルも、この依頼に適していない";

export const NOUL_CRITERIA = {
	yes: "依頼はその性質を持っている",
	no: "依頼はその性質を持っていない",
} as const;

export interface DispatchThresholds {
	/** Minimum `choice.confidence` for the selected skill. */
	readonly confidenceThreshold: number;
	/** Minimum mean of the two action gates. */
	readonly noulThreshold: number;
}

export interface DispatchChoiceSummary {
	readonly top: string;
	readonly confidence: number;
	readonly probabilities: Record<string, number>;
}

export interface DispatchGates {
	readonly wantsAction: number;
	readonly specificTask: number;
	readonly mean: number;
}

export interface DispatchDecision {
	readonly kind: "dispatch" | "abstain";
	/** Machine-readable reason code, stable for grouping in logs. */
	readonly reason: string;
	readonly skill?: string;
	readonly choice: DispatchChoiceSummary;
	readonly gates: DispatchGates;
	readonly model: string;
	readonly usage?: SystemOneUsage;
	/** True when the prompt was clamped before sending. */
	readonly truncated: boolean;
}

function clamp(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_STATE_CHARS) return { text, truncated: false };
	const tail = MAX_STATE_CHARS - HEAD_CHARS;
	return {
		text: `${text.slice(0, HEAD_CHARS)}\n…\n${text.slice(text.length - tail)}`,
		truncated: true,
	};
}

/**
 * Build the request for one user turn.
 *
 * The roster order is the caller's (name-sorted) order, so the same prompt and
 * the same skills always produce the same request body.
 */
export function buildDispatchRequest(prompt: string, skills: readonly SkillSummary[]): {
	readonly request: SystemOneRequest;
	readonly truncated: boolean;
} {
	const criteria: Record<string, string> = {};
	for (const skill of skills) criteria[skill.name] = skill.description;
	criteria[OTHER_CHOICE] = OTHER_CRITERIA;

	const { text, truncated } = clamp(prompt);

	const wantsAction: NoulQuestion = {
		type: "noul",
		instructions: WANTS_ACTION_INSTRUCTIONS,
		criteria: NOUL_CRITERIA,
	};
	const specificTask: NoulQuestion = {
		type: "noul",
		instructions: SPECIFIC_TASK_INSTRUCTIONS,
		criteria: NOUL_CRITERIA,
	};

	return {
		truncated,
		request: {
			state: text,
			questions: {
				[ANSWER_KEYS.skill]: {
					type: "choice",
					instructions: SKILL_CHOICE_INSTRUCTIONS,
					criteria,
				},
				[ANSWER_KEYS.wantsAction]: wantsAction,
				[ANSWER_KEYS.specificTask]: specificTask,
			},
		},
	};
}

function abstain(
	reason: string,
	choice: DispatchChoiceSummary,
	gates: DispatchGates,
	response: SystemOneResponse,
	truncated: boolean,
): DispatchDecision {
	return {
		kind: "abstain",
		reason,
		choice,
		gates,
		model: response.model,
		...(response.usage === undefined ? {} : { usage: response.usage }),
		truncated,
	};
}

/**
 * Turn a System One response into a decision.
 *
 * The abstain order is fixed and reported, so a run can tell "the model chose
 * `other`" apart from "the model picked a skill but the gate said no" — the two
 * failure modes need different fixes.
 */
export function interpretDispatch(
	response: SystemOneResponse,
	thresholds: DispatchThresholds,
	truncated: boolean,
): DispatchDecision {
	const choiceAnswer = response.answers[ANSWER_KEYS.skill];
	const wantsActionAnswer = response.answers[ANSWER_KEYS.wantsAction];
	const specificTaskAnswer = response.answers[ANSWER_KEYS.specificTask];

	const emptyChoice: DispatchChoiceSummary = { top: "(unusable)", confidence: 0, probabilities: {} };
	const emptyGates: DispatchGates = { wantsAction: 0, specificTask: 0, mean: 0 };

	if (choiceAnswer === undefined || choiceAnswer.type !== "choice") {
		return abstain("unusable-choice-answer", emptyChoice, emptyGates, response, truncated);
	}
	if (wantsActionAnswer === undefined || wantsActionAnswer.type !== "noul") {
		return abstain("unusable-noul-answer", emptyChoice, emptyGates, response, truncated);
	}
	if (specificTaskAnswer === undefined || specificTaskAnswer.type !== "noul") {
		return abstain("unusable-noul-answer", emptyChoice, emptyGates, response, truncated);
	}

	const choice: DispatchChoiceSummary = {
		top: choiceAnswer.choice,
		confidence: choiceAnswer.confidence,
		probabilities: choiceAnswer.probabilities,
	};
	const gates: DispatchGates = {
		wantsAction: wantsActionAnswer.noul,
		specificTask: specificTaskAnswer.noul,
		mean: (wantsActionAnswer.noul + specificTaskAnswer.noul) / 2,
	};

	if (choice.top === OTHER_CHOICE) {
		return abstain("choice-other", choice, gates, response, truncated);
	}
	if (gates.mean < thresholds.noulThreshold) {
		return abstain("noul-gate", choice, gates, response, truncated);
	}
	if (choice.confidence < thresholds.confidenceThreshold) {
		return abstain("low-confidence", choice, gates, response, truncated);
	}

	return {
		kind: "dispatch",
		reason: "confident",
		skill: choice.top,
		choice,
		gates,
		model: response.model,
		...(response.usage === undefined ? {} : { usage: response.usage }),
		truncated,
	};
}

/**
 * The text handed back to Pi.
 *
 * Pi appends everything after `/skill:<name>` to the skill content as
 * `User: <args>`, so the original prompt stays intact and explicit user
 * wording is not rewritten.
 */
export function buildTransformText(skill: string, prompt: string): string {
	return `/skill:${skill} ${prompt}`;
}

/** One-line summary used by status output and dry-run logs. */
export function formatDecision(decision: DispatchDecision): string {
	const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
	const gates = `action ${decision.gates.wantsAction.toFixed(2)}/task ${decision.gates.specificTask.toFixed(2)}`;
	if (decision.kind === "dispatch") {
		return `dispatch ${decision.skill} (${percent(decision.choice.confidence)}, ${gates})`;
	}
	return `abstain ${decision.reason} (top ${decision.choice.top} ${percent(decision.choice.confidence)}, ${gates})`;
}
