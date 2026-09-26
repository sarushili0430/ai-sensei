## Inspiration

It started with my younger sister. I was helping with homework, but my time was finite, and the real question became: **how do you help someone keep learning when you aren't in the room?** Working as a private tutor raised a second one. The students I taught got a patient explainer every week; their classmates whose families couldn't afford one got nothing. The gap wasn't talent, it was income. So we built a _senpai_ that teaches on a whiteboard, then comes back three days later to check it stuck. The free tier is a real product: one full lesson a day, no account, no email.

## What it does

**Katarute is a voice tutor that writes instead of talking.** Photograph a problem you're stuck on, and a senpai teaches it out loud while filling a shared whiteboard. Equations are written, never spoken: the voice only asks, _"Look at D here. It's positive, right? So?"_ You can interrupt anytime, and the lesson ends only when **you** tap "Got it". That board then becomes one review question, sent as a notification three days later and again after seven. You answer in text and the senpai grades it. No scores, no rankings. It covers Japanese and overseas math and English curricula.

## How we built it

**Flutter** on iOS talks to a **Cloudflare Workers + Hono** API, which stores the photo in R2, identifies the topic with Claude, and dispatches a **LiveKit** agent. The agent runs Silero VAD, Deepgram STT, Claude and Gemini TTS, streaming one object: `{speech, board}`. Each board step is sent over LiveKit Text Streams before its speech plays, so the writing never lags the voice. Topic IDs are checked against a curriculum whitelist, and every LaTeX command is allowlisted and parsed with KaTeX. **RevenueCat** runs the paywall and syncs entitlements to D1; **OneSignal** holds the review schedules, so there's no cron.

## Challenges we ran into

**Spoken equations don't work.** _"X squared minus three X plus two"_ doesn't survive the trip into anyone's head, so the senpai split in two: a voice that asks and a board that writes. That drove the whole streaming design. Our first TTS vendor couldn't read Japanese math at all, so we moved to one Gemini voice for both languages. The hardest cut was a feature we liked: having the student teach the lesson back. It demoed well but made the loop too long, so we folded it into one review question. Apple also rejected 1.0 for Japanese permission dialogs in an English build.

## Accomplishments that we're proud of

**The board.** A whiteboard that fills up as someone explains, never erases the previous step, and never reads a formula aloud. Each step arrives before the voice that refers to it; that one rule makes it feel like a person beside you rather than a search box. **The loop is finished**: photo, lesson, "Got it", a question three days later, a graded answer, a second visit after seven, in Japanese and English. **What we refused to ship**: no score, no ranking, no guilt-trip notifications. And **a free tier that is the real product**, so a family's income isn't the first gate.

## What we learned

**Write down what you are not building.** Our "not doing" list is why we shipped a whole loop rather than most of a bigger one, and why cutting teach-back was a decision, not a crisis. **Build the paywall and notifications early**: both hide product questions about what a subscription unlocks and when the senpai may reach out. **Cost the product before pricing it**: our first price list would have lost money on every daily user. **Treat the model as a colleague who forgets fields**, and validate everything it sends. And **voice needs silence**: a short pause between board steps helped comprehension more than any prompt change.

## What's next for Katarute

**Android** comes first: it's the same Flutter codebase, and the Play Store listing is already written. Then **Sign in with Apple**, so review history survives a new phone. We want a **text lane for the lesson itself**, for students on a train or in a library who can't speak aloud. The **curriculum** will keep growing on both the Japanese and overseas tracks. Most of all, we want to learn from real students whether AI grading catches _"I think I get it but I don't"_, and to keep the free tier free, because the student with no tutor is exactly who this is for.
