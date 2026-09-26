# 紹介動画(デモ動画)

`demo-en.mp4`(1920x1080・30fps・1分45秒・**ナレーション・声・BGMつき**)と
`demo-ja.mp4`(約80秒・音なし)。
**絵の正はコード**です。動画を編集ソフトで直さず、
[`apps/mobile/tool/demo_video/generate_demo_video.dart`](../../../apps/mobile/tool/demo_video/generate_demo_video.dart)
を直して書き出し直してください。

```bash
# 1. 声とBGM(英語版だけ。できている音声は作り直さない)
GOOGLE_API_KEY=... FFMPEG=/path/to/ffmpeg \
  node --experimental-strip-types apps/mobile/tool/demo_video/generate_demo_audio.ts

# 2. 映像(声の長さに合わせて間を取り、最後にBGMとミックスする)
cd apps/mobile
FFMPEG=/path/to/ffmpeg fvm flutter test tool/demo_video/generate_demo_video.dart
```

## 声とBGM(英語版)

`audio/en/` に1本ずつ置いてあります(`manifest.json` に話者・モデル・声・長さ)。
声は Gemini TTS で作りました。

| 話者 | 声 | モデル |
| --- | --- | --- |
| 先輩 | `Leda`(agent と同じ声・同じ読み方の指示) | `gemini-3.1-flash-tts-preview` |
| 生徒 | `Puck` | `gemini-2.5-flash-preview-tts` |
| ナレーション | `Charon` | `gemini-2.5-flash-preview-tts` |

先輩だけモデルが違うのは、2.5 Flash の無料枠(1日10回)を使い切ったため。
**同じ話者の中でモデルを混ぜない**(1本だけ声の質が変わる)ので、先輩の台詞は全部 3.1 で揃えてあります。
先輩の台詞は板書の fixture(`board-lesson.en.json` の `speech`)をそのまま読んでいます。

BGM は **“Carefree” Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 License**
(<http://creativecommons.org/licenses/by/4.0/>)。
**クレジット表記が利用の条件**です。動画の締めに入れてあります。YouTube などに上げるときは
説明欄にも同じ一文を書いてください。曲のファイルはコミットせず、スクリプトが取ってきます。

撮影 → 板書つき授業 → 「わかった」→ 3日後の通知 → 採点 → ホーム、の順
([`shipaton_submission.md`](../../shipaton_submission.md) §5 と同じ)。
章ごとの静止画が `frames/` に出ます(見直し用。コミットしない)。

## 何が本物で、何が台本か

画面・画面遷移・状態の持ち方はアプリ本体そのもの。端末の外にあるもの
(backend/api・LiveKit の部屋・カメラ・ロック画面)だけを、`packages/contract/fixtures`
の JSON と描いた絵で置き換えています。

**Shipaton の提出には、別に実機の録画が要ります**("footage that shows the Project
functioning on the device")。この動画は紹介用と、実機で撮るときの台本を兼ねます。
