import { z } from "zod";
import { topicIdSchema } from "./karte.ts";

/**
 * The contract for study plans (plan mode).
 *
 * The input is a conversation transcript, not screen form fields (pivot plan v1 §4-3):
 *
 *   senpai "When is the test?"          -> "10 September"
 *   senpai "What's the scope?"          -> "Math II trigonometry, textbook pp.120-150"
 *   senpai "Any workbooks you use?"     -> "4STEP and Blue Chart"
 *   senpai "Then how about this?"       -> the plan appears on screen
 *
 * Design promises:
 *
 *   - No forms. §1 rejected "build the study plan from form input" (maximum
 *     friction before any value is felt -> first-run drop-off). Adding one field
 *     equals adding one senpai question. When you want to ask more, first ask
 *     whether you can avoid asking at all.
 *
 *   - No scores (deck §0's promise 2). There are no fields for target scores,
 *     accuracy, comprehension, deviation values or completion rates. The schema is
 *     `.strict()`, so adding one later fails the tests. Study plans are where
 *     promise 2 is easiest to break - "target: 80 points", "this week's completion
 *     rate" are planning-app staples. And since this shape is meant to appear in
 *     §5's parent report, one number here goes straight to the parent (the ❌ side
 *     of §5-2).
 *
 *   - Facts and assignments are separate. {@link planIntakeSchema} holds the facts
 *     heard; `days` holds the generated assignments. A rebuild regenerates only the
 *     assignments - catching a cold does not move the test date. Conflated, every
 *     rebuild re-asks the facts, which is a form again.
 *
 *   - You cannot assign material the student does not have. `material` is an index
 *     into `materials`, not a name ({@link planItemDraftSchema}).
 *
 *   - You cannot write an unkeepable plan. There is a daily cap
 *     ({@link planDayMinutesMax}) and nothing may pass the test date. An unkept
 *     plan teaches "plans are not for me", so the cap lives in the schema rather
 *     than in a prompt request (like `speech` in `board.ts`).
 *
 *   - It must stay degradable. In §7's "what to drop first" ①, plan generation
 *     falls back to the senpai simply proposing a fixed template. The shape stays
 *     the same; only who fills it changes ({@link planSources}).
 *
 * Content validity is not checked here. Whether a topic_id is in the curriculum,
 * and whether an assigned unit falls within the scope (or its prerequisites), is
 * `@ai-sensei/guardrail`'s job. contract is a dependency-free layer and knows
 * nothing about prerequisites (the same split as `karte.ts`'s `topicIdSchema`).
 * This file checks shape and caps only.
 */

/**
 * The test date and the assignment days. A local date (`YYYY-MM-DD`), never a `datetime`.
 *
 * "The test on 10 September" is one day on the student's calendar and has no time.
 * Held as an instant (UTC), `2026-09-10T00:00:00Z` becomes 9am in Japan and the
 * test moves a day earlier depending on the device timezone. Treated the same as
 * `karte.ts`'s `last_session_date`.
 *
 * In this form, lexicographic string order matches date order, so the ordering
 * checks below are straightforward.
 */
export const planDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What the test is called ("second-term midterm"). Their own words, not a classification. */
export const planExamNameMaxLength = 40;

/**
 * The cap on how the student described the scope.
 * "Textbook pp.120-150" has no curriculum unit id, but it is the page they will
 * actually open, so it cannot be dropped (same reason as §5-2's "their own words").
 */
export const planScopeSaidMaxLength = 120;

/**
 * The cap on units in scope. A term test covers a few units; beyond 8 it is not a
 * scope but a whole term, which does not fit a two-week plan.
 */
export const planScopeTopicsMaxCount = 8;

/** The cap on a material's name ("4STEP", "Blue Chart", "textbook"). */
export const planMaterialNameMaxLength = 40;

/**
 * The cap on how many materials. A high-schooler actually works through 3-4 books
 * at most before a test. Raising it only adds books they own but never open.
 */
export const planMaterialsMaxCount = 4;

/** What one assignment involves ("4STEP examples 42-50"). */
export const planItemWhatMaxLength = 80;

/**
 * The lower bound on one assignment's minutes.
 * Under 10 minutes is over before it starts. An over-sliced plan only grows the
 * item count, making a day look heavier than it is.
 */
export const planItemMinutesMin = 10;

/** The upper bound on one assignment's minutes. Past 60 minutes it is two items. */
export const planItemMinutesMax = 60;

/** How many assignments a day can hold. */
export const planItemsPerDayMaxCount = 3;

/**
 * The cap on a day's total minutes.
 *
 * Two hours is what fits a weekday for a high-schooler home from club activities.
 * A plan writing more is not kept, and an unkept plan teaches only "plans are not
 * for me". So this is a cap, not guidance, and it is deliberately smaller than
 * `planItemMinutesMax x planItemsPerDayMaxCount` (180 minutes) - the three-item cap
 * exists to vary the kinds of work, not to make them do three times as much.
 */
export const planDayMinutesMax = 120;

/**
 * The cap on how many days a plan can span.
 *
 * Term-test scopes are announced 2-3 weeks ahead, and the entry product is the
 * weekly plan (§6-2). A test more than 35 days (5 weeks) out is something to plan
 * for nearer the time, not "every day from today". Hitting the cap usually means
 * the student's date was misread (interpreted as next year), so it doubles as a
 * safety valve.
 */
export const planDaysMaxCount = 35;

/** The cap on rebuild history. A plan rebuilt 20 times is a diary, not a plan. */
export const planRevisionsMaxCount = 20;

/**
 * The cap on how much is spoken in one interview turn ({@link planTurnSchema}).
 *
 * The value and the reasoning match `board.ts`'s `boardSpeechMaxLength` (Japanese
 * TTS at ~330 chars/min, so 20-25 seconds per turn). The same number is kept
 * separately so a decision to move one does not silently move the other - the
 * board cap draws the line at "do not speak formulas", this one at "do not drag
 * out the interview", and the reasons to move them differ.
 */
export const planSpeechMaxLength = 120;

/** What the student said as the reason for a rebuild. Same length as a karte's `desc`. */
export const planRevisionSaidMaxLength = 200;

/**
 * Who built this plan.
 *
 * `template` is the degraded version from §7's "what to drop first" ① - the senpai
 * merely fitted a fixed template to the facts heard, with no LLM building daily
 * assignments.
 *
 * It lives in the contract so the degradation is noticeable. The screen shows both
 * as the same plan (students are never told "this is the simple version"), so
 * without the field nobody would know a degraded build had gone into production
 * (the same failure as §10-7's "Sentry added as a dependency but not running").
 */
export const planSources = ["senpai", "template"] as const;
export const planSourceSchema = z.enum(planSources);
export type PlanSource = (typeof planSources)[number];

/**
 * An assignment's status. Self-reported by the student; the AI does not grade it
 * (the same constraint as §2's quiz).
 *
 * `moved` means it was shifted to another day in a rebuild - not "could not do
 * it". A shape that records "days they skipped" makes the plan a tool for blame
 * (promise 4). The move is recorded; the failure is not.
 *
 * There is no field for an aggregate ratio (completion or achievement rate).
 * Individual facts are observations, but the moment they become a ratio they are a
 * score (promise 2).
 */
export const planItemStatuses = ["todo", "done", "moved"] as const;
export const planItemStatusSchema = z.enum(planItemStatuses);
export type PlanItemStatus = (typeof planItemStatuses)[number];

/**
 * The reason for a rebuild. Not an assessment of the student but a branch in how
 * the plan is rebuilt.
 *
 *   - `behind` / `ahead` ... the facts are unchanged; only the assignments are rebuilt
 *   - `facts_changed` ... the test date, scope or materials changed, so it is
 *     rewritten from {@link planIntakeSchema}
 *
 * Conflated, a rebuild for merely running behind re-runs the interview (= a form again).
 *
 * Repeated `behind` is not evidence of laziness but an observation that the first
 * plan was too heavy, and it is material for making the next plan lighter - never
 * material for blame (promise 4).
 */
export const planRevisionReasons = ["behind", "ahead", "facts_changed"] as const;
export const planRevisionReasonSchema = z.enum(planRevisionReasons);
export type PlanRevisionReason = (typeof planRevisionReasons)[number];

/**
 * The scope. It holds both the unit ids and the student's own wording.
 *
 * Either one alone makes the plan unusable:
 *   - unit ids only -> the screen says just "trigonometry" and the student does not
 *     know which page to open
 *   - their words only -> it does not mesh with the curriculum and connects to
 *     neither holes, reviews nor the parent report
 */
export const planScopeSchema = z
  .object({
    /** The scope's units. Whether they are in the curriculum is matched by `@ai-sensei/guardrail`. */
    topic_ids: z.array(topicIdSchema).min(1).max(planScopeTopicsMaxCount),
    /** The scope as the student said it ("textbook pp.120-150"). Kept verbatim, not summarised. */
    said: z.string().min(1).max(planScopeSaidMaxLength),
  })
  .strict();
export type PlanScope = z.infer<typeof planScopeSchema>;

/**
 * The facts heard. The side that does not change on a rebuild.
 *
 * Only three things are asked (test date / scope / materials in use). Adding a
 * field here adds a senpai question and moves closer to the form §1 rejected.
 *
 * There is no locale (curriculum) field. Per ADR 0005 it follows from the
 * topic_id prefix, so holding it would create a second source of truth.
 */
export const planIntakeSchema = z
  .object({
    /** What the test is called: "second-term midterm". Shown as the screen's heading. */
    exam_name: z.string().min(1).max(planExamNameMaxLength),
    /** The test date. The end of the plan. */
    exam_date: planDateSchema,
    scope: planScopeSchema,
    /**
     * Materials in use, as the student named them (not translated, not corrected
     * to official titles). It may be empty - "nothing in particular" means planning
     * with the textbook alone. A plan with no materials gets done more often than
     * one recommending a book they do not have.
     */
    materials: z.array(z.string().min(1).max(planMaterialNameMaxLength)).max(planMaterialsMaxCount),
  })
  .strict();
export type PlanIntake = z.infer<typeof planIntakeSchema>;

/**
 * One assignment (the generated side).
 *
 * The point is that `material` is an index, not a name. Held as a string, the LLM
 * could assign "Blue Chart example 42" to a student who does not own Blue Chart.
 * As an index, pointing outside the materials heard is impossible in the schema
 * (the same trick as `board.ts`'s `angleMark.vertex` indexing vertices).
 * The upper bound depends on `intake.materials`'s length, so the check lives in
 * {@link studyPlanDraftSchema}.
 */
export const planItemDraftSchema = z
  .object({
    /** Which unit. Whether it is within scope (or its prerequisites) is matched by `@ai-sensei/guardrail`. */
    topic_id: topicIdSchema,
    /** What to do, in one line: "4STEP examples 42-50", "derive the addition formula in your notes". */
    what: z.string().min(1).max(planItemWhatMaxLength),
    /** An index into `intake.materials`. `null` means no material (reviewing notes, etc.). */
    material: z.number().int().min(0).nullable(),
    /**
     * Estimated minutes. A plan, not a record.
     * There is deliberately no field for time actually spent: with one, "X hours
     * this week" appears in the parent report, one step from §5-2's ❌ "study-time
     * leaderboard".
     */
    minutes: z.number().int().min(planItemMinutesMin).max(planItemMinutesMax),
  })
  .strict();
export type PlanItemDraft = z.infer<typeof planItemDraftSchema>;

/** A stored assignment. Carries the self-reported status ({@link planItemStatuses}). */
export const planItemSchema = planItemDraftSchema.extend({ status: planItemStatusSchema }).strict();
export type PlanItem = z.infer<typeof planItemSchema>;

/**
 * One day's worth.
 *
 * Empty `items` are allowed so rest days can be stated explicitly.
 * A day absent from the array (= nothing written) is outside the plan, while a day
 * present but empty is one the senpai placed as "let's rest here" - different
 * meanings. A plan with no rest days gets abandoned whole on the first day it slips.
 */
export const planDayDraftSchema = z
  .object({
    date: planDateSchema,
    items: z.array(planItemDraftSchema).max(planItemsPerDayMaxCount),
  })
  .strict();
export type PlanDayDraft = z.infer<typeof planDayDraftSchema>;

export const planDaySchema = z
  .object({
    date: planDateSchema,
    items: z.array(planItemSchema).max(planItemsPerDayMaxCount),
  })
  .strict();
export type PlanDay = z.infer<typeof planDaySchema>;

/**
 * A rebuild record. It keeps only the fact of the rebuild and the student's own
 * words, never the previous assignments. Keeping both would put "last week's plan"
 * and "this week's plan" side by side on screen with no way to tell which to do.
 */
export const planRevisionDraftSchema = z
  .object({
    reason: planRevisionReasonSchema,
    /**
     * What the student said ("I was ill and lost three days").
     *
     * `null` if they did not say it. Never invent. §5-2's top item for the parent
     * report is "a quote of the student's explanation", and this reaches the parent
     * verbatim. When the degraded (`template`) path or the app rebuilt it, having
     * no quote is correct.
     */
    said: z.string().min(1).max(planRevisionSaidMaxLength).nullable(),
  })
  .strict();
export type PlanRevisionDraft = z.infer<typeof planRevisionDraftSchema>;

export const planRevisionSchema = planRevisionDraftSchema
  .extend({
    /**
     * The moment of the rebuild. Only this is a `datetime`, because it is an event
     * that needs sorting rather than a calendar day (a plan can be rebuilt twice in
     * one day).
     *
     * It is absent from the draft because the LLM does not know the current time.
     * Asking it for what it does not know leaves a hallucinated timestamp in the
     * history (the same reason as `id`).
     */
    at: z.string().datetime(),
  })
  .strict();
export type PlanRevision = z.infer<typeof planRevisionSchema>;

/**
 * The plan's own invariants. The same checks apply to the draft (what the LLM
 * emits) and to the stored form.
 *
 * `.superRefine()` leaves nothing in JSON Schema, so the Dart side adds it by
 * hand. The README's "invariants absent from JSON Schema" lists them all.
 */
type PlanShape = {
  intake: { exam_date: string; materials: string[] };
  days: { date: string; items: { material: number | null; minutes: number }[] }[];
};

function checkPlanShape(plan: PlanShape, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  const materialCount = plan.intake.materials.length;
  let previousDate: string | null = null;

  plan.days.forEach((day, position) => {
    // Dates ascend and never repeat. A duplicate day shows twice on screen with
    // nothing to say which is authoritative.
    // `YYYY-MM-DD` sorts lexicographically = chronologically (planDateSchema).
    if (previousDate !== null && day.date <= previousDate) {
      issue(`日付は昇順で、同じ日を2回置かないでください(${previousDate} のあとに ${day.date})`, [
        "days",
        position,
        "date",
      ]);
    }
    previousDate = day.date;

    // The plan runs to the day of the test. Work placed after it is never done.
    // (The lower bound cannot be constrained: a rebuilt plan starts after
    //  `created_at`, so "no days before today" is the agent's responsibility.)
    if (day.date > plan.intake.exam_date) {
      issue(`テスト日(${plan.intake.exam_date})より後の日には置けません`, [
        "days",
        position,
        "date",
      ]);
    }

    const total = day.items.reduce((sum, item) => sum + item.minutes, 0);
    if (total > planDayMinutesMax) {
      issue(`1日は合計${planDayMinutesMax}分までです(${total}分)`, ["days", position, "items"]);
    }

    day.items.forEach((item, index) => {
      // Material that was never mentioned cannot be assigned (the index does not exist).
      if (item.material !== null && item.material >= materialCount) {
        issue("聞き取っていない教材は割り当てられません", [
          "days",
          position,
          "items",
          index,
          "material",
        ]);
      }
    });
  });
}

/**
 * What the LLM emits - the facts heard plus the assignments.
 *
 * The absence of `id` / `created_at` / `source` / `revisions` is deliberate.
 * Identifiers and provenance are added by the storage side (the same reason
 * `board.ts` separates the envelope - hallucinated ids flow downstream otherwise).
 *
 * This schema is fillable even by the degraded path. Test date, scope and
 * materials come from the interview, and `what` and `minutes` can be written by a
 * fixed template ({@link planSources}'s `template`). Creating no field that only
 * an LLM can fill is what keeps §7's "what to drop first" ① actually droppable.
 */
export const studyPlanDraftSchema = z
  .object({
    intake: planIntakeSchema,
    days: z.array(planDayDraftSchema).min(1).max(planDaysMaxCount),
    /**
     * For a rebuild, the reason and the student's words. `null` for a first build.
     *
     * The LLM emits this because the LLM is the only one hearing the student's own
     * words. Having the agent classify it after the fact from the transcript would
     * mean composing the quote (and that quote reaches the parent under §5-2, so it
     * is the worst thing to fabricate). The storage side stamps a time on it and
     * appends it to `revisions`.
     */
    revision: planRevisionDraftSchema.nullable(),
  })
  .strict()
  .superRefine(checkPlanShape);
export type StudyPlanDraft = z.infer<typeof studyPlanDraftSchema>;

/**
 * What the LLM emits in plan mode: one interview turn.
 *
 * A plan is born mid-conversation (§4-3). The turn that says "when is the test?"
 * and the turn that says "then how about this?" while producing the plan are the
 * same shape; the only difference is whether `plan` is present. Composed the same
 * way as `board.ts`'s `boardStepSchema`, which represents a step as `{speech, board}`.
 *
 * That way the agent calls the LLM identically during the interview and at
 * generation time, and the user can interrupt at any point (there is no stretch of
 * silent waiting for a plan).
 *
 * There is no board. What appears on screen in plan mode is the plan itself;
 * adding a board here would allow "explain the plan on the board", turning the
 * interview into a lesson.
 */
export const planTurnSchema = z
  .object({
    /**
     * The line to read aloud. One question per turn ({@link planSpeechMaxLength}).
     *
     * Unlike `board.ts`'s `speech` it carries no LaTeX ban, because plan mode has
     * nowhere to put a formula. Banning it would be an instruction with no answer
     * to "then where does the formula go?".
     */
    speech: z.string().min(1).max(planSpeechMaxLength),
    /**
     * The finished plan. `null` while still interviewing.
     *
     * A "plan so far" is not emitted every turn. Putting a plan built from half the
     * facts on screen makes the student read it as "it's decided now". The plan
     * should appear exactly once.
     */
    plan: studyPlanDraftSchema.nullable(),
  })
  .strict();
export type PlanTurn = z.infer<typeof planTurnSchema>;

/**
 * The stored plan. What the plan screen and (eventually) the parent report read.
 *
 * It has no `session_id`. A karte is one session's output, but a plan lives across
 * several sessions (a rebuild happens on another day, in another session). Which
 * session it was born in is not a property of the plan.
 *
 * `days` is the current plan and is replaced on a rebuild. Past assignments are
 * not kept (see {@link planRevisionSchema}).
 */
export const studyPlanSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.string().datetime(),
    source: planSourceSchema,
    intake: planIntakeSchema,
    days: z.array(planDaySchema).min(1).max(planDaysMaxCount),
    /**
     * Oldest first. Empty = never rebuilt.
     * Each rebuild ({@link studyPlanDraftSchema}'s `revision`) appends one entry.
     */
    revisions: z.array(planRevisionSchema).max(planRevisionsMaxCount),
  })
  .strict()
  .superRefine(checkPlanShape);
export type StudyPlan = z.infer<typeof studyPlanSchema>;
