## Inspiration

It started with my younger sister. I used to help with homework, but my time was limited, and I kept wondering how to help someone keep learning when I wasn't in the room. Working as a private tutor made a second problem hard to ignore. The students I taught got a patient explainer every week, while classmates whose families couldn't pay for one got nothing. The difference wasn't talent. It was income. So we built a senpai that teaches on a whiteboard and checks back three days later to see if it stuck, with a free tier that gives everyone one full lesson a day.

## What it does

Katarute is a voice tutor that writes instead of talking. You take a photo of a problem you're stuck on, and a senpai explains it out loud while filling a shared whiteboard. Equations go on the board and are never read aloud, so the voice only asks things like "Look at D here. It's positive, right? So?" You can cut in at any time, and the lesson ends only when you tap "Got it". That board then turns into one review question, which arrives as a notification three days later and again after seven. You answer in text and the senpai grades it. There are no scores or rankings.

## How we built it

The iOS app is built with Flutter and talks to an API on Cloudflare Workers and Hono. The API saves the photo to R2, asks Claude what topic it is, and sends a LiveKit agent into the room. That agent runs Silero VAD, Deepgram for speech recognition, Claude, and Gemini for the voice. The model streams speech and board content together, and each board step is sent before the voice that describes it, so the writing never falls behind. Every topic is checked against a curriculum whitelist, and every formula is parsed with KaTeX before it reaches the phone. RevenueCat handles the paywall, and OneSignal schedules the review notifications.

## Challenges we ran into

Spoken equations just don't work. Nobody can follow "x squared minus three x plus two" by ear, so we split the senpai into a voice that asks and a board that writes, and that one decision shaped the whole streaming design. Our first text-to-speech provider couldn't read Japanese math at all, so we switched to a single Gemini voice for both languages. The hardest cut was a feature we liked, where the student taught the lesson back. It looked great in demos but made each session too long, so we folded it into one review question. Apple also rejected our first build over Japanese permission dialogs in the English version.

## Accomplishments that we're proud of

We're proudest of the board. It fills up as the senpai explains, never erases the previous step, and never reads a formula aloud. Because each step shows up just before the voice mentions it, the lesson feels like someone sitting beside you rather than a search result. We're also proud that the whole loop works end to end in Japanese and English, from the photo to the lesson to a graded answer a week later. We left out scores, rankings and guilt-trip notifications on purpose. And the free tier is the real product, so a family's income doesn't decide who gets a lesson.

## What we learned

Writing down what we would not build turned out to be the most useful thing we did. That list is why we shipped one complete loop instead of half of a bigger one, and why dropping the teach-back feature felt like a decision and not a crisis. We learned to build payments and notifications early, because both forced product questions we would otherwise have put off. We learned to work out costs before setting prices, since our first price list would have lost money on every daily user. We learned to double-check everything the model sends. And we learned that a short pause between board steps helped students more than any prompt change.

## What's next for Katarute

Android is next. It shares the same Flutter code, and the Play Store listing is already written. After that we want Sign in with Apple so review history survives a new phone, and a text-only mode for students on a train or in a library who can't speak out loud. We'll keep adding to the Japanese and overseas curricula. Most of all, we want to find out from real students whether AI grading can catch the moment someone thinks they understand but doesn't. Through all of it, the free tier stays free, because the student without a tutor is exactly who we built this for.
