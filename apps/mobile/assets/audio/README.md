# プリレンダ音声

このディレクトリの `.m4a` は、授業冒頭(計画書 §3-2)で端末内再生する短い一言です。
アプリから TTS API は呼びません。何回鳴っても通信・従量原価はゼロです。

## 現在のファイルは無音プレースホルダ

リポジトリに入っている2本はどちらも、ffmpeg で作った **0.8秒の無音**です。実際の先輩の
声ではありません。実音声を生成できない環境でも、アセットの束ね方・再生経路・失敗時の
縮退をテストできるように置いてあります。この README と git 履歴がプレースホルダの印です。

| cue | ja | en | 鳴る瞬間 |
| --- | --- | --- | --- |
| `lesson_opening` | なるほど、じゃあ一緒に見てみようか。 | Okay, let's take a look at this together. | LiveKit 接続後〜最初の板書手順/先輩の発話 |

文字(吹き出し)はすべての cue で残るため、消音モード・アプリ側の音声無効化・ファイル
欠落でも情報は失われません。

## Gemini TTS の実音声へ差し替える

`backend/agent` と同じ API キー・声を設定し、リポジトリルートで実行します。

```bash
node --experimental-strip-types --env-file=backend/agent/.env \
  scripts/generate-prerendered-audio.ts
```

`.env` を使わない場合は `GOOGLE_API_KEY` を環境変数で渡してください。モデルと声の
既定値は agent と同じ定数(`backend/agent/src/senpai-voice.ts`)を読んでいます。

- モデル: `GEMINI_TTS_MODEL`、未指定なら `gemini-2.5-flash-tts`
- 声: `GEMINI_TTS_VOICE`、未指定なら `Leda`。**日英で同じ1つ**([ADR 0008](../../../../docs/adr.md#adr-0008))

**会話中と同じ読み方の指示まで含めて同じ形で投げます。**ここがずれると、冒頭の一言だけ
別人が喋ってから先輩の声にバトンタッチする、といういちばん気づきにくい壊れ方をします。

スクリプトは Gemini から生PCMを受け、インストール済みの `ffmpeg` で AAC へ焼いて m4a に
包み、完成したファイルだけを原子的に同名へ差し替えます。送るのは上表の固定文だけで、
ユーザーの問題・板書・発話は読みません。生成対象を API 呼び出しなしで確認するには:

```bash
node --experimental-strip-types scripts/generate-prerendered-audio.ts --list
```

差し替え後は2本を実際に聴き、日英・声・語尾・前後の無音を確認してからコミットします。
少なくともコンテナと長さは次で確認できます。

```bash
ffprobe -v error -show_entries format=filename,duration \
  -of default=noprint_wrappers=1 apps/mobile/assets/audio/*.m4a
```

## 再生時の約束

- iOS は `AVAudioSessionCategory.ambient`、Android は ringer mode と media volume を読み、
  無音・マナーモードを優先します。アプリは音量を変更しません。
- アセット欠落・デコード失敗・停止失敗は画面へ伝播させません。音は装飾で、吹き出しが正本です。
- 授業 cue は最初の板書手順か先輩の発話が来たら停止します。2つの声を重ねません。
