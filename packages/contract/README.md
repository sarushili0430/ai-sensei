# @ai-sensei/contract

`apps/mobile`(Dart)・`backend/api`(TS)・`agent`(TS)の3者をつなぐ契約。
言語をまたぐので「型」ではなく **スキーマとfixture** を正とする。

```
src/         zodスキーマ(TypeScript側の正)
fixtures/    実データのサンプル。TS・Dartの両方のテストがこれをパースする
schema/      zodから生成したJSON Schema(Dart実装時の参照用。コミット済み)
```

## 契約ドリフトの検知

1. `src/fixtures.test.ts` — 全fixtureをzodでパースする(TS側)
2. `apps/mobile/test/contract_fixture_test.dart` — 同じfixtureをfreezedのモデルでパースする(Dart側)
3. `src/json-schema.test.ts` — `schema/*.json` がzodと一致しているか

zodを変えたら:

```bash
pnpm --filter @ai-sensei/contract generate:schema   # schema/*.json を再生成
pnpm test                                          # fixtureとの整合を確認
```

fixtureに新しい形が必要になったら、**fixtureを先に書いてからスキーマを直す**。
fixtureはレビューで一番読まれる場所なので、実際に起きる会話の粒度で書く。

## カルテのスキーマで守っていること

- **点数・正答率のフィールドを持たない。** `strict()` なので、後から `score` を足そうとすると
  テストが落ちる。数えるのは連続日数(`streak_days`)と埋めた穴(`filled_holes`)だけ。
- **穴は最大5件。** カルテを責める道具にしないため、上限をスキーマで縛る。
- **解答・解説の入る場所がない。** `said_well` / `holes` / `term_notes` の3つだけで、
  正しい解法を書き込むフィールドは意図的に用意していない。
  **この制約は残るが、理由が変わった。** 以前は「答えを教えないため」だった。
  ピボット([`docs/pivot_plan_v1.md`](../../docs/pivot_plan_v1.md) §0・約束1の改正
  「答えを教える。そのあと教え返させる」)で、先輩は解法を教えるようになっている。
  解法が入るのは **板書**(`src/board.ts`)であって、カルテではない。
  カルテは**その場で観測できたこと**の記録で、AIが教えた内容を書き戻す場所ではない
  (書き戻すと、AIの誤読を1/3/7日の復習で強化してしまう。計画書 §2 の小テストの設計制約と同じ理由)。
- `severity` は復習の並び順にだけ使い、UIには数値として出さない。

## 板書のスキーマで守っていること

解法が入る唯一の場所。だからこそ縛りが要る(`src/board.ts` の冒頭に根拠を書いてある)。

- **`speech` は120字まで。** 日本語TTSの約330字/分から逆算した、1手順20〜25秒ぶん。
  「数式・計算・図は板書、音声は問いかけと接続だけ」(計画書 §3-1)は見た目ではなく**原価の主柱**なので、
  プロンプトのお願いではなくスキーマで守る。数式を読み上げ始めた瞬間に必ず超える。
- **自由描画がない。** 要素は `latex` / `text` / `plot` / `triangle` / `circle` の5種で、
  LLMが出せるのはパラメータだけ。SVGもcanvasコマンドも受け取るフィールドがない。
- **解答を丸ごと1要素に流し込めない。** `tex`(200字)・`body`(100字)の上限、
  多行LaTeX環境(`align` など)の禁止、**1回の出力あたりの**手順数の上限(12)の3枚で塞ぐ。
  1要素の上限だけだと「1行ずつだが40行」で抜けられる。
- **手順数の上限は2つある。混同すると板書が毎ターン消える。**
  | 定数 | 何の上限か | 値 |
  | --- | --- | --- |
  | `boardLessonStepsMaxCount` | **LLMが1回に出せる**手順数(`board-lesson` の `steps`) | 12 |
  | `boardStepsMaxCount` | **板書1枚**(= 1つの問題)に積める手順数(ワイヤーの `index` / `step_count`) | 40 |

  板書は1つの問題ぶん生き続け、何回かの説明(切り分け → 教える → 教え返させる)が
  同じ `board_id` に積み上がる。**LLMを呼ぶたびに `board_open` を送ると、
  会話が1往復するたびに板書が消える**(計画書 §3-2 の「前の行は消さない」が毎ターン破れる)。
- **LLMが出す形と、data channelを流れる形を分けている。** `board-lesson` は識別子を持たない
  (幻覚したIDが配送層に流れ込まないように)。宛先・順序・板書の切り替えは封筒
  (`board-channel-log` の各メッセージ)の責務。**通し番号の付け直しも配送層**で、
  LLMは自分が何回目の呼び出しかを知らない(知らせると幻覚した番号がワイヤーに出る)。
- 送信経路は **LiveKit の Text Streams(agent → mobile・topic `board`)** で、
  `backend/api` を経由しない。下の「主なエンドポイント」表に出てこないのはそのため。
- **LaTeXコマンドの中身は照合しない。** ここが見るのは長さと「1行かどうか」だけ。
  `flutter_math_fork` が描けるかの検証は `packages/guardrail` と agent の担当
  (計画書 §3-6 の三段構え)。contract は依存を持たない層なので、`topicIdSchema` と同じ分担にする。

## JSON Schema に現れない不変条件

`schema/*.json` はDart実装時の参照用だが、**zodの `.refine()` / `.superRefine()` は
JSON Schema に何も残さない**。単一の正規表現で書けるものは `.regex()` で書いてあるので
`pattern` として残る(残っていることを `src/json-schema.test.ts` が固定している)。
残りは JSON Schema では原理的に書けないので、**Dart側は手で実装する**必要がある。
「契約ドリフトの検知」の3本足のうち、**Dart側の足がここだけ細くなる**。

| 不変条件 | どこ | Dart側でやること |
| --- | --- | --- |
| `domain` は `min < max` | `plot` | 描画前に検査して落とす |
| 手順の `index` は0始まりで1ずつ増える(**`board-lesson` では1回の出力の中で / `board_step` では板書1枚の中で**) | `board-lesson` / `board_step` | 期待値と突き合わせる(**板書ごとに数える**。1回の出力ごとではない) |
| 封筒の `seq` は0始まりで1ずつ増える(種別をまたいで) | `board-channel-log` | 飛んだら**欠落として扱う** |
| `board_close.step_count` が実際に届いた手順数と一致する | 同上 | **末尾の欠落**の検知 |
| 手順は `board_open` と `board_close` の間にしか来ない | 同上 | 未開封の `board_id` は捨てる |
| `board_open` は前の板書を消す(それ以外で板書は消えない) | 同上 | 受信時に盤面をクリア |
| 1つのセッションのメッセージだけが混ざる(`session_id` が全部同じ) | 同上 | **別セッション宛ては捨てる**(宛先の確認) |

**`seq` と `step_count` はモバイル側の欠落検知そのもの。** JSON Schema だけを見て実装すると、
板書が虫食いのまま黙って表示される。`session_id` も同じ性質で、
**部屋を取り違えた配送を受信側で落とす**ための宛先確認。

### JSON Schema には出ているが、Dartの型に落ちないもの

こちらは理由が違う。**JSON Schema には制約が出力されている**(`src/json-schema.test.ts` が
出ていることを固定している)が、**Dartの `List<T>` は固定長を型で表現できない**。
参照を読んでも型に落とし込めないので、結局**上の表と同じく実行時チェックが要る**。

| 不変条件 | JSON Schema での表現 | Dart側でやること |
| --- | --- | --- |
| `triangle.vertices` は3点ちょうど | `minItems: 3` / `maxItems: 3` | 長さ3を実行時に検査する |
| `triangle.labels` は付けるなら3つ揃える | 同上(`labels` は省略可) | 省略可・付いたら長さ3を検査する |

zod側がタプル(`z.tuple`)なのは、**同種の値の固定長列は配列で持つ**という
`board.ts` の方針による(異種の値の組 — `{x, y}` や `{min, max}` — だけをオブジェクトにする)。

## 主なエンドポイント

| メソッド | パス | 誰が呼ぶ |
| --- | --- | --- |
| POST | `/v1/sessions` | mobile(写真 + meta を multipart で) |
| POST | `/v1/sessions/{id}/complete` | agent(内部トークン必須) |
| GET | `/v1/me/progress` | mobile(ホーム画面) |
| GET | `/v1/me/reviews` | mobile(復習画面。無料は `requires_premium: true` で空) |
| POST | `/v1/webhooks/revenuecat` | RevenueCat |

エラーはすべて `{ "error": { "code", "message" } }` の形で返す。
クライアントは `code` で分岐し、`message` はそのまま表示する(煽らない文体で書く)。
