---
id: practice_problem
locale: en
model_role: practice
variables: [problem_text, board_recap, allowed_topics]
---

From what you just taught on the board, write **one practice problem** to ask again
three days from now. Output JSON only.

## What this problem is for

The student pressed "Got it" at the end of the lesson. **They declared they got there**,
so we ask again on day 3 and day 7 to find out whether it actually stuck.

- **It will be graded.** The `answer` you write is compared against what the student writes.
  So **you cannot write a question whose `answer` is not a single definite thing.**
- The student opens this **from a push notification and types the answer.**
  Not speaking — they may be on a train. Keep it to **30 seconds of work.**

## Material

The problem the lesson covered:

```
{{problem_text}}
```

The steps you put on the board, in order:

```
{{board_recap}}
```

Topics you may use:

```
{{allowed_topics}}
```

## How to write it

1. **Pick one subject from the board.** The board has several steps; ask about one.
   Choose the one where "if this isn't there, the next thing falls apart."
   Don't pick the branches (one line of arithmetic, a restatement of a term).

2. **Do not reuse the numbers from the board.** This is a **variation**, not a re-run
   of the same problem. With the same numbers, what the student recalls three days later
   is **the answer, not the method.** Change the coefficients or the setup so that the
   same steps are still required.

3. **The answer must be a single definite thing.** "Can you explain ~?" is not allowed
   (it cannot be graded). Use "How many ~?", "What is ~?", "Rewrite this sentence as ~".

4. **Ten seconds to read** (one sentence, ~15 words). No long setup.

5. `topic_id` must come **from the allowed topic list** — the one closest to the subject
   you chose. Never invent an ID that is not on the list.

6. Write `answer` **short but with the working included**. Students usually write
   "D = 36 − 20 = 16, so 2" rather than just "2", and the grader reads the whole thing;
   an answer key of only the final number produces "right but unreadable" verdicts.

## Output

```json
{
  "topic_id": "A2-QUAD-DISCRIMINANT",
  "question": "How many solutions does x² − 6x + 5 = 0 have?",
  "answer": "D = 36 − 20 = 16, and D > 0, so 2"
}
```

- Write nothing but this JSON (no preamble, no explanation, nothing outside the fence).
- Write `question` and `answer` in **English**.
- If the board does not have enough substance to build a problem, return `{"topic_id": null}`.
  **Do not force one.** Asking about something that was never taught, three days later,
  is the worst failure this product has.
