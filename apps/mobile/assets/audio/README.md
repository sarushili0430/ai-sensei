# Pre-rendered audio

The `.m4a` files here are the short lines played on the device at the start of a
lesson (plan §3-2). The app never calls a TTS API, so however often they play, there
is no network traffic and no metered cost.

## The current files are silent placeholders

Both files in the repository are **0.8 seconds of silence** made with ffmpeg, not the
senpai's real voice. They exist so the asset bundling, the playback path and the
degradation on failure can be tested even where real audio cannot be generated. This
README and the git history are the marker that they are placeholders.

| cue | ja | en | When it plays |
| --- | --- | --- | --- |
| `lesson_opening` | なるほど、じゃあ一緒に見てみようか。 | Okay, let's take a look at this together. | After the LiveKit connection, until the first board step or senpai utterance |

The text (speech bubble) remains for every cue, so no information is lost on silent
mode, with audio disabled in the app, or with a missing file.

## Replacing them with real Deepgram audio

Configure the same API key and voice model as `backend/agent`, then run from the
repository root.

```bash
node --experimental-strip-types --env-file=backend/agent/.env \
  scripts/generate-prerendered-audio.ts
```

Without `.env`, pass `DEEPGRAM_API_KEY` as an environment variable. The model
defaults match the agent's:

- ja: `DEEPGRAM_TTS_MODEL_JA`, defaulting to `aura-2-izanami-ja`
- en: `DEEPGRAM_TTS_MODEL_EN`, defaulting to `aura-2-andromeda-en`

The script receives AAC from Deepgram's `/v1/speak`, wraps it into m4a with the
installed `ffmpeg`, and atomically swaps only finished files into place. It sends
only the fixed lines in the table above and never reads the user's problem, board or
speech. To see what would be generated without calling the API:

```bash
node --experimental-strip-types scripts/generate-prerendered-audio.ts --list
```

After replacing them, listen to both, check the Japanese and English, the voice, the
endings and the leading/trailing silence, then commit. At minimum the container and
duration can be checked with:

```bash
ffprobe -v error -show_entries format=filename,duration \
  -of default=noprint_wrappers=1 apps/mobile/assets/audio/*.m4a
```

## Playback promises

- iOS uses `AVAudioSessionCategory.ambient`; Android reads the ringer mode and media
  volume. Silent and vibrate modes win. The app never changes the volume.
- A missing asset, a decode failure or a failed stop never propagates to the screen.
  The audio is decoration; the speech bubble is authoritative.
- The lesson cue stops as soon as the first board step or senpai utterance arrives.
  Two voices never overlap.
