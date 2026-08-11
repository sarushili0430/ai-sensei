# @ai-sensei/curriculum

高校数学のカリキュラムマップ。
**後輩AIが触れてよい話題の全集合**であり、同時に「穴」のタグ付け語彙でもある。

**ロケールごとに1本**持つ([ADR 0005](../../docs/adr.md#adr-0005))。
日本の課程を英訳したものは、どこの国のカリキュラムでもないので作らない。

| ロケール | ファイル | 課程 | トピック数 |
| --- | --- | --- | --- |
| `ja` | `data/curriculum.v0.json` | 数学I / A / II / B / III / C(新課程) | 52 |
| `en` | `data/curriculum.intl.v0.json` | Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics | 57 |

- 実体は純JSON。TypeScript以外(Flutter・Python版agent)からも同じファイルを読める。
- `src/` は読み出しヘルパと整合性チェック。**データを変えるのはJSONだけ**。

## 使い方

```ts
import {
  isKnownTopicId,
  localeOfTopicId,
  prerequisitesOf,
  suggestTopics,
  topicsFor,
} from "@ai-sensei/curriculum";

// サーバ側ガード: LLMが返したtopic_idがカリキュラム内か(全ロケール横断)
isKnownTopicId("M2-ZUKEI-ENCHOKU"); // true
isKnownTopicId("A2-COORD-CIRCLE");  // true

// 写真解析テキストから単元候補を引く(課程を絞る)
suggestTopics("distance from the center to the line", 5, { locale: "en" });

// 穴の深掘り: 「そもそも判別式って何のためにある?」の質問先を決める
prerequisitesOf("M2-ZUKEI-ENCHOKU"); // → [M1-NIJI-HANBETSU, M2-ZUKEI-TENTO-KYORI]

// 一覧をプロンプトや画面に出すときは、必ずロケールで絞る
topicsFor("en");

// 穴の言語は topic_id から決まる(通知文・復習画面がこれを使う)
localeOfTopicId("A1-QUAD-SOLVE"); // "en"
```

`topics` / `findTopic` / `isKnownTopicId` は**全ロケール横断**で見る。IDが
ロケールをまたいで衝突しないので、ガードレールの照合は課程を気にせず通せる。
逆に、**一覧を人やLLMに見せるときは `topicsFor(locale)` で絞る**。混ぜると
英語のノートに「数学II / 図形と方程式」というチップが出る。

## トピックを追加するとき

```jsonc
{
  "id": "M2-ZUKEI-ENCHOKU",       // {コース接頭辞}-{単元}-{トピック} を大文字ローマ字で
  "course": "数学II",              // 接頭辞と一致していないとCIで落ちる
  "unit": "図形と方程式",
  "topic": "円と直線の位置関係",
  "goals": [                       // 質問生成のネタ元。最低1つは説明を問える形にする
    "中心と直線の距離dと半径rの比較で位置関係を判定できる",
    "2つの方法の使い分けの理由を説明できる"
  ],
  "prerequisites": ["M1-NIJI-HANBETSU"],  // 穴の深掘り先。**同じ課程の**存在するIDのみ
  "keywords": ["円の方程式", "判別式"]     // 写真解析テキストとの突き合わせ用
}
```

海外向けも同じ形。接頭辞は `A1`(Algebra 1)/ `GE`(Geometry)/ `A2`(Algebra 2)/
`PC`(Precalculus)/ `CL`(Calculus)/ `ST`(Statistics)。

```jsonc
{
  "id": "A2-COORD-CIRCLE",
  "course": "Algebra 2",
  "unit": "Coordinate Geometry",
  "topic": "Lines and circles",
  "goals": [
    "Decide how a line and a circle meet by comparing the centre-to-line distance with the radius",
    "Explain why you would choose one of the two methods over the other"
  ],
  "prerequisites": ["A1-QUAD-SOLVE", "A2-COORD-DISTANCE"],
  "keywords": ["equation of a circle", "tangent line", "discriminant"]
}
```

チェックは `pnpm test` の中で回る:

- スキーマ(zod)— 未知フィールドは `strict()` で弾く
- ID重複 / 未定義の前提 / 自己参照 / 循環(**全ロケール横断**)
- IDの接頭辞と `course` の一致、`course` とファイルの `locale` の一致
- **課程をまたいだ前提参照** — Algebra 2 の前提が 数学II になっていないこと
- **新課程の配当**(`ja`)— ベクトルが数学C、統計的な推測が数学B、仮説検定が数学I にあること
  (旧課程の知識で書き足すとここで落ちる)
- **科目名が訳語になっていないこと**(`en`)— "Math II" のような名前を弾く

## v0の範囲

到達目標は技能(「因数分解できる」/ "Factor by pattern")だけで終わらせず、
**各トピックに必ず1つ以上、説明を問える目標**(「〜の理由を説明できる」/
"Explain why ...")を入れる。このアプリが測るのは説明であって正誤ではないので、
ここが薄いと質問が「解けますか?」になってしまう。テストで全トピックを検査している。

`ja` は数I・数IIの頻出単元を厚めに、数A/B/III/Cは主要単元を1〜3トピックずつ。
`en` は Algebra 1 → Calculus の主系列に Statistics を並走させた構成で、
行列・級数展開のように国や学校で扱いが割れるものは v0 では持たない。

拡充の手順は、LLMで下書き → 人手レビュー → JSONに追記 → `pnpm test`。
