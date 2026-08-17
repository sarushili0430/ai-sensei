# prompts/

システムプロンプトとfew-shot。**Markdownが正**で、差分レビューできるようにここに置く。

ファイル名は `<id>.<locale>.md`。**言語ごとに別本**を持つ
([ADR 0005](../docs/adr.md#adr-0005))。

| id | 使う場所 | 役割 |
| --- | --- | --- |
| `photo_analysis` | backend/api(Vision LLM) | ノート写真 → 単元検出・質問の種 |
| `senpai_conversation` | agent(会話LLM) | 先輩ペルソナ + 教え返しのガードレール([ピボット計画 v1](../docs/pivot_plan_v1.md) §2) |
| `question_types_few_shot` | agent | 教え返しを聞くときの聞き方4型をそろえるfew-shot |
| `karte_generation` | agent(セッション終了時) | transcript → カルテJSON |
| `math_speech_hints` | 両方 | 数式音声の補正ヒント(§4(d)) |
| `senpai_board` | agent(新規 / 復習の板書LLM) | 写真または対象穴を起点に、先輩ペルソナ + 板書JSON生成([ピボット計画 v1](../docs/pivot_plan_v1.md) §2・§3) |
| `study_plan` | agent(計画モード) | 先輩が**口で聞いて**学習計画を組む / 組み直す(同 §4-3) |

現在のロケールは `ja` と `en` の2つ。**id の数 × 2ロケール**が揃って
いないとテストが落ちる(片方だけ足すと、その言語のセッションだけ静かに
日本語へフォールバックする)。id を1つ足すたびに `.md` は2本増え、
`packages/prompts/src/index.ts` の `promptIds` にも足す。

日本語の本文に「英語で答えてください」を足す作りにはしない。足す作りだと
ペルソナも禁止事項も日本語のまま英語で言い直されるだけで、few-shot は
日本語の例文のままになる。**文体の見本がない状態**で英語を喋らせると、
先輩の口調ではなく試験官の口調に寄る。

## TypeScriptからの読み込み

Workers/agentはファイルシステムを前提にできないため、Markdownを文字列定数へ変換した
`packages/prompts/src/generated.ts` を経由します。**手で編集しないこと。**

```bash
pnpm --filter @ai-sensei/prompts generate   # .md → generated.ts
```

`.md` を編集して再生成を忘れると `packages/prompts/src/index.test.ts` が落ちます。
**再生成しても、常駐している agent は古い本文を持ったまま**なので再起動が要ります。
直したものを実際に授業で試すときは [`apps/tuner`](../apps/tuner/README.md)
(web の勉強画面)から回すと、この2つの取りこぼしを画面が知らせます。

```ts
getPrompt("senpai_conversation", "en");       // 言語を指定して取り出す
conversationSystemPrompt(variables, "en");    // few-shot と音声ヒントも英語で同梱
boardLessonSystemPrompt(variables, "en");     // 先輩(新規 / 復習の板書)+ 音声ヒント
studyPlanSystemPrompt(variables, "en");       // 先輩(計画)。音声ヒントは同梱しない
```

`study_plan` にだけ音声ヒントを同梱していないのは、あれが**数式の読み上げ**
(「さんぶんのに」= 2/3)を直すためのもので、計画の聞き取りに出てくる数字が
**日付・ページ番号・問題集の名前**という別物だからです。計画側で要る聞き取りの注意は
`study_plan.<locale>.md` に直接書いてあります。

未対応の言語は黙って `ja` に落とします(ここで例外にすると、言語が1つ増えた
瞬間に会話が始まらなくなるため)。

## フロントマター

各ファイルの先頭に、埋め込み変数の一覧を持たせています。

```yaml
---
id: senpai_conversation
locale: ja
model_role: conversation
variables: [photo_summary, visible_work, allowed_topics, question_seeds, lesson_recap, remaining_seconds]
---
```

`renderPrompt()` は `variables` に宣言されていない変数を渡すとエラーにし、
本文に残った未展開の `{{...}}` も検出します(プロンプトの穴埋め漏れは、
そのままLLMの範囲逸脱につながるため)。

**同じ id なら、ロケール間で `variables` を揃えること。** ずれていると
片方の言語だけ `renderPrompt` が落ちます(= その言語では会話が始まらない)。
テストで見ています。

## 書くときの約束

プロンプトは仕様書です。以下はコードのガードレール(`@ai-sensei/guardrail`)と
**二重に**書きます。片方だけ直さないこと。**言語ごとにも二重**です
(英語側だけ抜けると、海外のユーザーにだけ約束が破られる)。

| # | 約束 | |
| --- | --- | --- |
| 1 | ~~答え・解き方・正解を言わない~~ → **教える。そのあと教え返させる** | **2026-08-09 改正** |
| 2 | 写真に写っていない話題に触れない(topic_idは許可リストから選ぶ) | 維持 |
| 3 | 点数・評価語を使わない | 維持 |
| 4 | パス(説明できない)を責めない | 維持 |

### 1番目の改正について(2026-08-09)

家庭教師AIへのピボットで、**1番目だけが改正されました**
([ピボット計画 v1](../docs/pivot_plan_v1.md) §0「憲法の部分改正」)。
残る3つは無傷です。**この事実を知らずに「答えを教えない」に戻すと、製品が別物になります。**

> **答えを教える。そのあと、あなたに教え返してもらう。**

改正が及ぶ範囲は id ごとに違います。プロンプトを直すときは、まずどちらかを確かめること。

| id | 1番目の扱い |
| --- | --- |
| `senpai_board` | **改正後。** 写真の問題も復習の穴も教える。ただし教えっぱなしにせず、必ず説明してもらうところまで行く |
| `senpai_conversation` `question_types_few_shot` | **改正後。** 説明が詰まったら教える。ただし**先に答えを埋めない** — まず言わせてから(言ってしまうと、そこが穴だったのかが永久に分からなくなる) |
| `photo_analysis` | **改正前のまま。** 解析器の出力は「何を教えるか」を決めるための材料で、ここに解答が入ると誤読が下流に固定される |
| `karte_generation` | 対象外(採点しない ≒ 約束3の側の話) |
| `study_plan` | 対象外(計画は教える場ではない)。効くのは約束3「点数をつけない」のほう |

`@ai-sensei/guardrail` の `containsAnswerLeak()` は**改正前の約束1を見るための関数**で、
教える先輩(板書・会話)には**もう当てていません**(agent 側の呼び出しは削除済み)。
当てたままだと、先輩が詰まった箇所を教えるたびに漏れとして記録され、警告が鳴りっぱなしになります。
板書側の二重書きの相手は別で、こちらです:

| プロンプトに書くこと | コード側の相手 |
| --- | --- |
| `speech` は120字以内・数式を読み上げない | `contract` の `boardSpeechMaxLength` と `speech` のLaTeX禁止 |
| 使ってよいLaTeXコマンドの一覧 | `guardrail` の `allowedLatexCommands` |
| 日本語は数式ではなく `text` 要素へ | `guardrail` の `text_in_math` |
| 1手順=1行(`\\` を使わない・多行環境を使わない) | `contract` の `tex` の正規表現 / `guardrail` の `row_separator_outside_environment` |
| 長い式は `=` の前で割って2手順にする | **コード側の相手がまだいない**(計画書 §3-6b。W2でNode側の幅推定を入れるまで、ここはプロンプトだけが守っている) |
| 答えを待つ問いかけには `awaits_student: true` を付け、`steps` をそこで終える(授業は往復する) | `contract` の `boardStepSchema.awaits_student` + `senpai.ts` の `stepAwaitsStudent`(欄が無い手順だけ `handsTurnToStudent` の言い回し推測に落ちる)。`backend/agent/src/lesson.ts` の `stopAfter` がそこで止め、答えを受けた続きは `lesson-loop.ts` が同じ板書に積む |
| 教え返しへの受け渡しは「じゃあ今の、**自分の言葉で説明してみて**」の形で言い、**途中の問いかけには「説明して」を使わない** | `senpai.ts` の `asksForTeachBack`。**授業の往復を終える唯一の合図**なので、文言の族を変えるときは判定とテストも一緒に変える |

学習計画(`study_plan`)の二重書きの相手は、さらに別です:

| プロンプトに書くこと | コード側の相手 |
| --- | --- |
| 目標点・達成率を書かない | `contract` の `studyPlanSchema`(`strict()` に置き場が無い) |
| 1日は合計120分まで / 1項目10〜60分 | `contract` の `planDayMinutesMax` と `planItemMinutes*` |
| `material` は聞いた教材の**番号** | `contract` の `material` の添字と範囲検査 |
| 日付は昇順・テスト日を越えない | `contract` の `checkPlanShape` |
| `topic_ids` は許可リストから選ぶ | `guardrail` の `filterHoleTopicIds()` と同じ照合(**計画向けはまだ無い** — 下記) |
| 組み直しで `intake` を聞き直さない | **コード側の相手がいない。**ここはプロンプトだけが守っている |

教え返し(`senpai_conversation`)にも、締めの検出という二重書きの相手があります。

| プロンプトに書くこと | コード側の相手 |
| --- | --- |
| 締めるときは「**今日は**ここまでにしよっか」 / "Let's stop here for today" を明示して終える(「説明はここまで」のような話の区切りの言い方では締めない) | `backend/agent/src/closing.ts` の `CLOSING_PATTERNS`。「今日は」「そろそろ」のような**今日ぜんぶを指す語**を前に要求している。文言を変えるときは検出とテストも更新する |
| 採点しない・「合ってる / 違う」を宣告しない | **無し。**プロンプトだけが守っている |
| 命令・催促をしない、数字を見せない(約束4) | **無し。**同上 |
| 先に答えを埋めない(まず言わせる) | **無し。**`containsAnswerLeak()` は当てられない(下記) |

「先に答えを埋めない」に機械の相手がいないのは、**字面では判定できない**からです。
同じ「答えは2点で交わる」が、生徒が説明したあとなら正しく、説明する前なら違反になる。
判定に要るのは語句ではなく**ターンの順序**なので、`containsAnswerLeak()` の
正規表現では原理的に置き換えられません。ここを機械で見るなら、その設計から始めること。

配役が後輩から先輩に変わって**新しく開いた穴**です。後輩は「勉強しろ」と言えませんが、
先輩は言える立場なので、ここが緩むと素で言います。書き換えるときは弱めないこと。

差し込む定型句も本文と同じ言語で書きます(`(なし)` / `(none)`、
`先輩:` / `Senpai:`、板書の引用符 `「」` / `"`)。
日本語が1行混ざると、そこだけ日本語で返ってきます。
