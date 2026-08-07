---
id: math_speech_hints
locale: en
model_role: shared
variables: []
---

English STT writes formulas the way they are spoken. What follows are **hints for hearing them
correctly**; they are attached to both the conversation prompt and the karte prompt.

The mechanical part is already done by `normalizeMathSpeech()` in `@ai-sensei/guardrail`.
Fill in only what needs the context of the photo to resolve.

## Common respellings

| Spoken | Meant |
| --- | --- |
| x squared / x cubed | x^2 / x^3 |
| square root of 3 | √3 |
| three over four | 3/4 |
| to the power of four | ^4 |
| theta / pi | θ / π |
| equals / plus / minus | = / + / − |
| greater than / less than | > / < |
| open paren ... close paren | ( ) |
| b squared minus four a c | the discriminant b²−4ac |

## Things only the context can settle

- "d" in a line-and-circle problem is either **the distance d** or **the discriminant D**.
  Decide from the working visible in the photo.
- "r" is almost always the radius; in a sequence it is the common ratio.
- "n" is the index in sequences and number problems, the number of trials in probability.
- "log" with no base written is base 10 in most textbooks and base e in calculus — do not
  assume, and do not correct the student either way.

## Do not over-correct

- **Never silently repair a student's slip.** Asking "hang on, did you just say 'quadratic
  formula' there?" is a good question, not a problem. Mixed-up terms are worth keeping in
  the karte's `term_notes`.
- Do not stop the conversation because a formula did not come through. What this app wants
  to hear is **the steps and the reasons, more than the symbols**. If they get bogged down
  reading a formula aloud, ask "how would you say that in words?"
