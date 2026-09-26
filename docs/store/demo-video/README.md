# 紹介動画(デモ動画)

`demo-ja.mp4` / `demo-en.mp4`(1920x1080・30fps・約85秒)。
**絵の正はコード**です。動画を編集ソフトで直さず、
[`apps/mobile/tool/demo_video/generate_demo_video.dart`](../../../apps/mobile/tool/demo_video/generate_demo_video.dart)
を直して書き出し直してください。

```bash
cd apps/mobile
FFMPEG=/path/to/ffmpeg fvm flutter test tool/demo_video/generate_demo_video.dart
```

撮影 → 板書つき授業 → 「わかった」→ 3日後の通知 → 採点 → ホーム、の順
([`shipaton_submission.md`](../../shipaton_submission.md) §5 と同じ)。
章ごとの静止画が `frames/` に出ます(見直し用。コミットしない)。

## 何が本物で、何が台本か

画面・画面遷移・状態の持ち方はアプリ本体そのもの。端末の外にあるもの
(backend/api・LiveKit の部屋・カメラ・ロック画面)だけを、`packages/contract/fixtures`
の JSON と描いた絵で置き換えています。動画の隅にもその旨を出しています。

**Shipaton の提出には、別に実機の録画が要ります**("footage that shows the Project
functioning on the device")。この動画は紹介用と、実機で撮るときの台本を兼ねます。
