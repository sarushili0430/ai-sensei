# apps/tuner — プロンプトチューニング用の web 画面

**アプリの勉強画面(写真登録 → 音声 → 板書)を、ブラウザで1枚に畳んだもの。**
プロンプト(`prompts/*.md`)を直して、その場で授業を1本回して、
何が変わったかを見るための道具です。

```
apps/tuner/
  serve.ts        依存なしの開発サーバ(public/ の配信 + /vendor + /api/status)
  public/         画面。素のHTML/JS(ビルド手順を持たない)
    index.html    3段組み(① 接続と写真 / ② 板書と音声 / ③ 観測)
    app.js        画面の配線。「何を出すか」だけ
    api.js        backend/api の叩き方(apps/mobile の api_client.dart と同じ形)
    room.js       LiveKit(session_controller.dart の web 版)
    board.js      板書の受信箱。**アプリと同じ欠落判定**
    board-view.js 板書8種の描画(KaTeX + SVG)
    plot.js       plot.fn の評価器(eval を使わない)
  test/           web と実機で答えが違ってはいけない部分だけのテスト
```

**開発専用で、どこにも配信しません。** `apps/lp` と違って wrangler の設定を
持たせていないのはそのためです(ここを公開すると、リポジトリのファイルを
配る口になります)。

## 何のためにあるか

Flutter をビルドして実機に載せる往復が、プロンプトの1文字を直すたびに要るのが問題でした。
この画面は同じAPIを同じ形で叩き、同じ LiveKit の部屋に入り、
**板書の封筒(`board` topic)をアプリと同じ検査で受けます**。だから

- 先輩が何を喋り、何を板書したか
- **agent に渡っている会話文脈**(トークンの `metadata`)
- 最初の手順まで何秒かかったか
- カルテに何が残ったか

を、ブラウザの再読み込みだけで回せます。

**アプリの代わりではありません。** 見た目は実機に寄せていない(golden test は
`apps/mobile` の担当)ので、レイアウトの確認には使わないでください。

## 使いかた

3つのプロセスを別々に立てます。**API と agent は本物**です(手元の鍵で動かす)。

```bash
pnpm --filter @ai-sensei/api   dev     # http://localhost:8787
pnpm --filter @ai-sensei/agent dev     # LiveKit のルームで待機
pnpm --filter @ai-sensei/tuner dev     # http://localhost:5273  ← ここを開く
```

初回だけ、それぞれの環境変数を用意してください(ルートの README「2. 環境変数」)。
`backend/api/.dev.vars` の `ANTHROPIC_API_KEY` が無いと写真の解析が 500 になり、
`backend/agent/.env` の LiveKit / Deepgram が無いと先輩が来ません。

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `TUNER_PORT` | `5273` | 画面のポート |
| `API_BASE_URL` | `http://localhost:8787` | 画面が最初に入れておくAPIのURL(develop に当てるときに使う) |

画面の手順はアプリと同じです。

1. **問題の写真**(と、あればノートの写真)を入れる。ドラッグ&ドロップ、
   クリップボードからの貼り付け(問題の枠に入ります)、クリックでのファイル選択。
2. **写真を解析** → `POST /v1/sessions`。読み取った問題文と単元のチップが出ます。
   チップを外して **単元を反映する** と `PATCH /v1/sessions/{id}/topics`(解析はし直しません)。
3. **授業を始める** → `POST /v1/sessions/{id}/start`。**ここで今日の1回を使います。**
   ブラウザがマイクの許可を聞くので、許可すると会話が始まります。
4. 板書が積まれ、字幕が流れます。**教え返し**はそのまま声で答えてください。
5. **会話を終える** → カルテ(`GET /v1/sessions/{id}/result`)を待って表示します。

無料枠は1日1セッションです(サーバが数えます)。使い切ったら **device id の「新規」**
を押すと別の生徒として続けられます。手元とdevelopの `BETA_OPEN_ACCESS_UNTIL` が
効いている間は1日10本です。

## プロンプトを直したとき

**`prompts/*.md` を直しただけでは、授業は変わりません。**

```bash
pnpm --filter @ai-sensei/prompts generate   # prompts/*.md → src/generated.ts
# そのあと agent を再起動する(常駐プロセスが古い本文を持っているため)
```

画面の上に出る**橙色の帯**が、この取りこぼしを見張っています。
帯は `prompts/*.md` から作り直した本文と、コミット済みの `generated.ts` を
**そのまま比較**して出しています(更新時刻では見ません。クローン直後は全ファイルが
同じ秒に並ぶので、空振りする帯になるため)。

帯が消えていても、**再起動していない agent は古いまま**です。順番は
「直す → generate → agent を再起動 → 画面を再読み込み」。

## 何を見る画面か(右の「③ 観測」)

| 欄 | 中身 | プロンプトを直すときの使い道 |
| --- | --- | --- |
| 時間 | 解析・入室・最初の手順・カルテまでの秒数 | 沈黙が伸びていないか。`board_step` までの時間がそのまま沈黙の長さ |
| 会話(字幕) | 先輩と生徒の発話 | 喋りすぎていないか(音声は問いかけと接続だけ) |
| agent に渡した文脈 | トークンの `metadata` を復号したもの | **板書が的外れなとき、プロンプトが悪いのか渡した文脈が悪いのかを切り分ける** |
| 板書の封筒 | `board` topic を流れた生JSON | `speech` の字数、`awaits_student`、要素の種類 |
| カルテ | `/result` の応答 | 穴の粒度、`said_well`、フォローアップの質 |
| イベント | 起きたことの1行ログ | 失敗したときの `trace_id`(`wrangler tail` と突き合わせる) |

各手順の `speech` の右に**字数**が出ます。上限は120字(≒22秒)ですが、
それは安全弁であって目標値ではありません([`board.ts`](../../packages/contract/src/board.ts) の
`boardSpeechMaxLength`)。ここが伸びていたら、板書に置くべきものを喋らせています。

**この試行をJSONで保存** を押すと、上の全部(設定・文脈・封筒・字幕・カルテ・時間)が
1ファイルで落ちます。プロンプトのbefore/afterを比べるときは、これを2本並べてください。

## 制約

- **マイクは `localhost` か HTTPS でしか使えません**(ブラウザの制約)。
  develop のAPIに当てるときも、画面自体はこの開発サーバから開いてください。
- 実機と揃えているのは**中身の解釈**(欠落判定・座標系・`plot.fn` の意味)だけで、
  見た目は揃えていません。
- `figure` の SVG は `<img>` で描きます(SVGは `<script>` を持てるため、
  板書の経路を任意のマークアップの流し込み口にしないための措置)。
- 依存はブラウザ用の2つ(`livekit-client` / `katex`)だけで、
  どちらも `node_modules` から `/vendor/` として配ります(CDNは使いません)。
