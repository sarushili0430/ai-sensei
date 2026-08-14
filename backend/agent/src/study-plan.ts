import {
  type CompletePlanSessionRequest,
  type PlanIntake,
  type PlanRevisionDraft,
  type PlanTurn,
  type StudyPlan,
  type StudyPlanDraft,
  planIntakeSchema,
  planRevisionDraftSchema,
  planTurnSchema,
  studyPlanDraftSchema,
} from "@ai-sensei/contract";
import { findTopic } from "@ai-sensei/curriculum";
import {
  checkPlanScope,
  filterPlanItems,
  planRejectionGuidanceByLocale,
} from "@ai-sensei/guardrail";

export type PlanFacts = {
  intake: PlanIntake;
  revision: PlanRevisionDraft | null;
};

export type PlanTurnInspection =
  | { kind: "question"; turn: PlanTurn }
  | { kind: "ready"; turn: PlanTurn & { plan: StudyPlanDraft }; filtered_items: number }
  | { kind: "repair"; guidance: string; reason: string }
  | { kind: "fallback"; facts: PlanFacts; reason: string };

type InspectOptions = {
  locale: "ja" | "en";
  today: string;
  currentPlan: StudyPlan | null;
  /** First pass regenerates; second drops only safely droppable items and falls back to the template. */
  finalAttempt?: boolean;
};

const guidance = {
  ja: {
    shape:
      "出力を指定された {speech, plan} のJSONだけに直してください。聞き取り済みの事実は変えないでください。",
    past: "今日より前の日を計画に入れないでください。今日以降だけで割り当て直してください。",
    date: "日付を実在する YYYY-MM-DD に直してください。過ぎたテスト日は推測せず、日付を聞き直してください。",
    revision:
      "これは組み直しです。revision に理由と本人が言ったことを入れ、behind/aheadならintakeを前回のままにしてください。",
    initial: "これは初回の計画です。revision は null にしてください。",
    empty: "休む日だけで終わらせず、範囲内の具体的な割り当てを少なくとも1つ入れてください。",
  },
  en: {
    shape: "Return only the specified {speech, plan} JSON. Do not change any facts already heard.",
    past: "Do not put past dates in the plan. Reallocate using today or later only.",
    date: "Use a real YYYY-MM-DD date. If the test date has passed, ask to confirm it instead of guessing.",
    revision:
      "This is a rebuild. Put the reason and the student's words in revision; for behind/ahead, keep intake exactly as it was.",
    initial: "This is the first plan. Set revision to null.",
    empty: "Do not return only days off. Include at least one concrete item inside the test range.",
  },
} as const;

/**
 * Inspects one turn's structure, dates and scope together.
 *
 * The contract alone knows neither the curriculum contents nor "today". Both are
 * layered here: the first pass regenerates, only the second drops safely
 * removable output. The scope we heard is never trimmed even if one entry is
 * broken - silently narrowing it would drop part of the exam range.
 */
export function inspectPlanTurn(raw: string, options: InspectOptions): PlanTurnInspection {
  let value: unknown;
  try {
    value = extractPlanJson(raw);
  } catch {
    return fallbackOrRepair(value, options, "invalid_json", guidance[options.locale].shape);
  }

  const parsed = planTurnSchema.safeParse(value);
  if (!parsed.success) {
    return fallbackOrRepair(value, options, "invalid_shape", guidance[options.locale].shape);
  }
  const turn = parsed.data;
  if (turn.plan === null) return { kind: "question", turn };

  if (options.currentPlan === null && turn.plan.revision !== null) {
    return options.finalAttempt
      ? fallbackOrRepair(value, options, "unexpected_revision", guidance[options.locale].initial)
      : {
          kind: "repair",
          reason: "unexpected_revision",
          guidance: guidance[options.locale].initial,
        };
  }
  if (options.currentPlan !== null && turn.plan.revision === null) {
    return {
      kind: "repair",
      reason: "missing_revision",
      guidance: guidance[options.locale].revision,
    };
  }
  if (
    options.currentPlan !== null &&
    turn.plan.revision?.reason !== "facts_changed" &&
    JSON.stringify(turn.plan.intake) !== JSON.stringify(options.currentPlan.intake)
  ) {
    return options.finalAttempt
      ? fallbackOrRepair(value, options, "intake_rewritten", guidance[options.locale].revision)
      : {
          kind: "repair",
          reason: "intake_rewritten",
          guidance: guidance[options.locale].revision,
        };
  }

  if (!isRealPlanDate(turn.plan.intake.exam_date) || turn.plan.intake.exam_date < options.today) {
    return { kind: "repair", reason: "invalid_exam_date", guidance: guidance[options.locale].date };
  }

  const scope = checkPlanScope(turn.plan.intake.scope.topic_ids);
  if (!scope.ok) {
    return {
      kind: "repair",
      reason: scope.reason,
      guidance: planRejectionGuidanceByLocale[options.locale][scope.reason],
    };
  }

  const badDate = turn.plan.days.some((day) => !isRealPlanDate(day.date));
  if (badDate) {
    return fallbackOrRepair(value, options, "invalid_day_date", guidance[options.locale].date);
  }

  let filteredItems = 0;
  const days = turn.plan.days
    .filter((day) => {
      if (day.date >= options.today) return true;
      filteredItems += day.items.length;
      return false;
    })
    .map((day) => {
      const result = filterPlanItems(day.items, scope.allowed);
      filteredItems += result.rejected.length;
      return { ...day, items: result.accepted };
    });

  if (!options.finalAttempt) {
    if (turn.plan.days.some((day) => day.date < options.today)) {
      return { kind: "repair", reason: "past_day", guidance: guidance[options.locale].past };
    }
    const firstRejected = turn.plan.days
      .map((day) => filterPlanItems(day.items, scope.allowed).rejected[0])
      .find((entry) => entry !== undefined);
    if (firstRejected) {
      return {
        kind: "repair",
        reason: firstRejected.reason,
        guidance: planRejectionGuidanceByLocale[options.locale][firstRejected.reason],
      };
    }
  }

  const acceptedCount = days.reduce((count, day) => count + day.items.length, 0);
  if (days.length === 0 || acceptedCount === 0) {
    return fallbackOrRepair(value, options, "empty_after_filter", guidance[options.locale].empty);
  }

  const sanitized = planTurnSchema.parse({
    speech: turn.speech,
    plan: { ...turn.plan, days },
  });
  if (sanitized.plan === null) throw new Error("検証済み計画がnullになりました");
  return {
    kind: "ready",
    turn: { ...sanitized, plan: sanitized.plan },
    filtered_items: filteredItems,
  };
}

function fallbackOrRepair(
  value: unknown,
  options: InspectOptions,
  reason: string,
  repairGuidance: string,
): PlanTurnInspection {
  if (options.finalAttempt) {
    const facts = extractPlanFacts(value, options.currentPlan);
    if (facts) {
      const scope = checkPlanScope(facts.intake.scope.topic_ids);
      if (
        scope.ok &&
        isRealPlanDate(facts.intake.exam_date) &&
        facts.intake.exam_date >= options.today
      ) {
        return { kind: "fallback", facts, reason };
      }
    }
  }
  return { kind: "repair", guidance: repairGuidance, reason };
}

/** From a broken assignment, keep only the heard facts that may feed the template. */
function extractPlanFacts(value: unknown, currentPlan: StudyPlan | null): PlanFacts | null {
  if (!isRecord(value) || !isRecord(value["plan"])) return null;
  const rawPlan = value["plan"];
  const revision = planRevisionDraftSchema.nullable().safeParse(rawPlan["revision"]);
  if (!revision.success) return null;

  if (currentPlan === null) {
    const intake = planIntakeSchema.safeParse(rawPlan["intake"]);
    return intake.success ? { intake: intake.data, revision: null } : null;
  }
  if (revision.data === null) return null;

  // Never use LLM output that rewrote the facts to catch up or get ahead; fall
  // back to the previous facts from the API.
  if (revision.data.reason !== "facts_changed") {
    return { intake: currentPlan.intake, revision: revision.data };
  }
  const intake = planIntakeSchema.safeParse(rawPlan["intake"]);
  return intake.success ? { intake: intake.data, revision: revision.data } : null;
}

/**
 * Fixed template for when the LLM could not produce an assignment.
 * Stays within the materials and scope we heard, and lightens the load on a redo.
 * The on-screen shape is identical; `source: template` rides only on the
 * complete body so the degradation is observable in operations.
 */
export function buildTemplatePlan(input: {
  facts: PlanFacts;
  today: string;
  locale: "ja" | "en";
}): StudyPlanDraft {
  const { intake, revision } = input.facts;
  const dates = planDates(input.today, intake.exam_date);
  const minutes = revision ? 20 : 30;
  const material = intake.materials.length > 0 ? 0 : null;

  const days = dates.map((date, index) => {
    // A rest day every fourth day, stated as part of the plan rather than a gap.
    if ((index + 1) % 4 === 0) return { date, items: [] };
    const topicId = intake.scope.topic_ids[index % intake.scope.topic_ids.length]!;
    const topicName = findTopic(topicId)?.topic ?? intake.scope.said;
    const book = material === null ? null : (intake.materials[material] ?? null);
    const what = templateWhat({ locale: input.locale, topicName, book }).slice(0, 80);
    return {
      date,
      items: [{ topic_id: topicId, what, material, minutes }],
    };
  });

  return studyPlanDraftSchema.parse({ intake, days, revision });
}

function templateWhat(input: {
  locale: "ja" | "en";
  topicName: string;
  book: string | null;
}): string {
  if (input.locale === "en") {
    return input.book
      ? `Work through one set of ${input.topicName} examples in ${input.book}`
      : `Write out and explain one ${input.topicName} example`;
  }
  return input.book
    ? `${input.book}で${input.topicName}の例題を一周する`
    : `${input.topicName}の例題を、説明しながらノートに解く`;
}

function planDates(today: string, examDate: string): string[] {
  const todayMs = localDateMs(today);
  const examMs = localDateMs(examDate);
  if (examMs < todayMs) throw new Error("過ぎたテスト日にはテンプレ計画を作れません");
  const dayMs = 86_400_000;
  const startMs = Math.max(todayMs, examMs - 34 * dayMs);
  const result: string[] = [];
  for (let at = startMs; at <= examMs; at += dayMs) result.push(formatLocalDate(at));
  return result;
}

function isRealPlanDate(value: string): boolean {
  try {
    return formatLocalDate(localDateMs(value)) === value;
  } catch {
    return false;
  }
}

function localDateMs(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`日付の形式が不正です: ${value}`);
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(at)) throw new Error(`日付を解釈できません: ${value}`);
  return at;
}

function formatLocalDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractPlanJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("計画LLMの出力にJSONが見つかりません");
  return JSON.parse(candidate.slice(start, end + 1));
}

export const postPlanCompleteTimeoutMs = 15_000;

export async function postPlanComplete(input: {
  apiBaseUrl: string;
  internalToken: string;
  planSessionId: string;
  body: CompletePlanSessionRequest;
  fetchImpl?: typeof fetch;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts = input.attempts ?? 3;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(
        `${input.apiBaseUrl}/v1/plans/${input.planSessionId}/complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.internalToken}`,
          },
          body: JSON.stringify(input.body),
          signal: AbortSignal.timeout(postPlanCompleteTimeoutMs),
        },
      );
      if (response.ok) return;

      const detail = await response.text().catch(() => "");
      const error = new Error(`計画completeが失敗しました: ${response.status} ${detail}`);
      if (response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof Error && /失敗しました: 4/.test(error.message)) throw error;
      lastError = error;
    }
    if (attempt < attempts) await sleep(attempt * 1000);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
