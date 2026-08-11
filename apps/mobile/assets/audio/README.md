# プリレンダ音声

このディレクトリの `.m4a` は、授業冒頭(計画書 §3-2)と自習室(§4-2)で端末内再生する
短い一言です。アプリから TTS API は呼びません。何回鳴っても通信・従量原価はゼロです。

## 現在のファイルは無音プレースホルダ

リポジトリに入っている8本はすべて、ffmpeg で作った **0.8秒の無音**です。実際の先輩の
声ではありません。実音声を生成できない環境でも、アセットの束ね方・再生経路・失敗時の
縮退をテストできるように置いてあります。この README と git 履歴がプレースホルダの印です。

| cue | ja | en | 鳴る瞬間 |
| --- | --- | --- | --- |
| `lesson_opening` | なるほど、じゃあ一緒に見てみようか。 | Okay, let's take a look at this together. | LiveKit 接続後〜最初の板書手順/先輩の発話 |
| `study_room_going` | 順調? | How's it going? | 自習室 10分 |
| `study_room_break` | そろそろ休憩する? | Want to take a break? | 自習室 25分 |
| `study_room_long` | けっこう集中してるね。ひと息ついてきな。 | You've been at this a while. Go stretch. | 自習室 50分 |

入室直後の吹き出し(`SenpaiNudge.start`)は鳴らしません。「たまの声かけ」ではなく、
自習室の使い方を最初から表示している案内だからです。文字はすべての cue で残るため、
消音モード・アプリ側の音声無効化・ファイル欠落でも情報は失われません。

## Deepgram の実音声へ差し替える

`backend/agent` と同じ API キー・声モデルを設定し、リポジトリルートで実行します。

```bash
node --experimental-strip-types --env-file=backend/agent/.env \
  scripts/generate-prerendered-audio.ts
```

`.env` を使わない場合は `DEEPGRAM_API_KEY` を環境変数で渡してください。モデルの既定値も
agent と同じです。

- ja: `DEEPGRAM_TTS_MODEL_JA`、未指定なら `aura-2-izanami-ja`
- en: `DEEPGRAM_TTS_MODEL_EN`、未指定なら `aura-2-andromeda-en`

スクリプトは Deepgram `/v1/speak` から AAC を受け、インストール済みの `ffmpeg` で m4a に
包み、完成したファイルだけを原子的に同名へ差し替えます。送るのは上表の固定文だけで、
ユーザーの問題・板書・発話は読みません。生成対象を API 呼び出しなしで確認するには:

```bash
node --experimental-strip-types scripts/generate-prerendered-audio.ts --list
```

差し替え後は8本を実際に聴き、日英・声・語尾・前後の無音を確認してからコミットします。
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
