# プロンプト評価ハーネス

**AI(または人)が、実機もブラウザも使わずにプロンプト改善ループを回すための道具。**

`apps/tuner`(#138)が「人間が1本ずつ観測する」ための画面なのに対し、ここは
「同じ授業をN本ヘッドレスで回して機械で採点する」ための装置。両者は同じ一次資料を
扱う: ここが保存する試行JSONの `envelopes` は本物の `board` トピックの封筒なので、
tunerの `/debug` にそのまま貼って描画できる。

鍵は `ANTHROPIC_API_KEY` 1本だけで、LiveKit・Deepgram・マイク・日次枠は使わない。
音声(STT/TTS)を通らないぶん、測れるのは**プロンプトとハーネスの振る舞い**であって、
聞き取りの品質ではない(そこはtunerと実機の担当)。

コマンドは **`backend/agent` で走らせる前提**で書いてある。

```bash
cd backend/agent
pnpm run eval list
pnpm run eval run --stage board --scenario all --locale all --trials 3
```

`--out` を省いたときの置き場(`backend/agent/eval-out/`)は `cli.ts` が
`import.meta.dirname` から引くので、リポジトリルートから
`node --experimental-strip-types backend/agent/src/eval/cli.ts list` と打っても同じ場所に落ちる。

## 1. 前提

- `.env`(backend/agent)に `ANTHROPIC_API_KEY` があれば読む。無ければ環境変数で渡す
- **agentの再起動は要らない**。tunerと違い常駐プロセスを経由せず、`generated.ts` を
  直接importする。ただし **`prompts/*.md` を直したら
  `pnpm --filter @ai-sensei/prompts generate` は必要**。忘れると古い本文を測る
  (`packages/prompts/src/index.test.ts` が落ちるので気づける)
- モデルは環境変数で差し替えられる。**板書は本番の既定と同じモデルで測る**のが原則

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (必須) | 全LLM呼び出し |
| `EVAL_MODEL_BOARD` | 本番の `LLM_MODEL_BOARD` の既定と同じ | 板書LLM |
| `EVAL_MODEL_JUDGE` | claude-opus-5 | ジャッジ。生成より上のモデルを充てる |
| `EVAL_MODEL_STUDENT` | claude-haiku-4-5-20251001 | 生徒シミュレータ。安くてよい |
| `EVAL_MODEL_KARTE` | 本番の `LLM_MODEL_KARTE` の既定と同じ | L2のカルテ生成 |
| `EVAL_ANTHROPIC_BASE_URL` | (無し) | プロキシ経由で測るときだけ |

## 2. 基本ループ

```bash
cd backend/agent

# 1. baseline を測る(L1: 板書1パス。1シナリオ×3試行が目安)
pnpm run eval run --stage board --scenario all --trials 3 --out eval-out/base

# 2. prompts/*.md を直す
# 3. 反映(忘れると古い本文を測る)
pnpm --filter @ai-sensei/prompts generate
pnpm vitest run backend/agent packages/prompts   # 二重書きの相手を壊していないか

# 4. candidate を同じ条件で測る
pnpm run eval run --stage board --scenario all --trials 3 --out eval-out/cand

# 5. 機械の相手がいない約束はジャッジに聞く
pnpm run eval judge eval-out/base
pnpm run eval judge eval-out/cand

# 6. 差分を読む(> report.md でそのままPRに貼れる)
pnpm run eval report eval-out/base eval-out/cand
```

- 改善かつ回帰なしなら採用、悪化ならrevert。**単発の勝ち負けで決めない**
  (LLMの分散があるので、pass率で比べる。迷ったら `--trials` を増やす)
- run は途中で止めても、**同じ `--out` でもう一度打てば続きから**回る
  (`docs/figeval` と同じ。判定済みの試行は `judge` も飛ばす)
- `record.error` が付いた試行は**ハーネス側の事故**(429・切断)。分母から外して読む。
  `error` 無しで `ok=false` がモデルの成績(レポートは自動でこの扱いをする)
- 板書1パス(`--stage board`)が内側ループ。候補が2〜3案に絞れてから
  往復(`--stage loop --persona cooperative|stuck|silent`)でターン順序系を測る。
  **1つのrunディレクトリは1ペルソナ**(試行ファイルの名前にペルソナが入らないため、
  ペルソナを変えるときは `--out` も変える)

プロンプトの**言い回しの族**(教え返しの合図・締めの文言)を変えるときは、
`senpai.ts` / `closing.ts` の検出器とテストも**対で**直すこと。どの行に機械の相手が
いるかは `prompts/README.md` の二重書きの表が正。

## 3. ジャッジの回し方と過適合への注意

ジャッジ(`judge.ts` / `rubrics.ts`)が裁くのは、**機械の相手がいない約束だけ**
(prompts/README.md の表で「無し」の行): 先に答えを埋めない(R1・ターンの順序)・
採点語(R2)・命令/催促(R3)・パスを責めない(R4)・教えっぱなし(R5)・
話題の逸脱(R6)・カルテの接地(R7)。字面で判定できる行は `score.ts` の担当で、
ジャッジには聞かない。

**ルーブリックは2026-08-09の改正後**で書いてある。「教えた」こと自体を違反と数える
ジャッジに書き換えないこと(製品が別物になる。prompts/README.md「1番目の改正について」)。

ジャッジ固定のままプロンプトを最適化し続けると、ジャッジの癖に寄る:

- ルーブリック本文もこのディレクトリでバージョン管理される。判定がおかしいと感じたら、
  その試行JSONを残してルーブリック側を直す
- 採用判断の前に、代表的な試行を1本 tuner の `/debug` でリプレイして目視する
- `detector_mismatches`(ジャッジと `asksForTeachBack()` の食い違い一覧)は
  **ハーネスチューニングの一次データ**: ジャッジだけが拾った発話は検出器の語彙を広げる
  候補、検出器だけが拾った発話は過検出の候補。**どちらが誤りかは人が決める**。
  直すときは `senpai.ts` のテストも一緒に

## 4. シナリオの増やし方

失敗報告(ドッグフーディング・tunerで保存した試行JSON)が出たら、その文脈から
`scenario.ts` に1本足して回帰させる。シナリオは `SessionMetadata` のfixtureなので、
tunerの「agentに渡した文脈」欄からほぼコピーで作れる。

- `topic_ids` は実在するもののみ(テストが curriculum と突き合わせる)
- 整形済み文字列は `@ai-sensei/prompts` の整形関数(`formatProblemText` 等)を通す。
  手書きするとプレースホルダが1文字ずれて、本番では起きない入力を測る
- 英語科目に `locale:"en"` は作れない(`senpai_board_english` はja版のみ。
  `promptCatalog` が正)

## 5. tuner との関係

| | apps/tuner (#138) | src/eval (ここ) |
| --- | --- | --- |
| 実行 | 人間がブラウザで1本 | AIがヘッドレスでN本 |
| 音声 | 本物(マイク/TTS/STT) | 通らない(テキスト直結) |
| 観測 | 画面 + 試行JSON | 試行JSON + スコア + ジャッジ |
| 用途 | 定性・レイアウト・音声 | 定量・回帰・before/after |

evalで拾った失敗は、試行JSONの `envelopes` を tuner の `/debug` に貼って
そのまま目視できる(同じ受信箱・同じ検査を通る)。逆に、tunerで保存した試行は
§4の手順でシナリオになる。
