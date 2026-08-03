# @ai-sensei/curriculum

高校数学(新課程・2022年度〜)のカリキュラムマップ。
**後輩AIが触れてよい話題の全集合**であり、同時に「穴」のタグ付け語彙でもある。

- 実体は `data/curriculum.v0.json` の純JSON。TypeScript以外(Flutter・Python版agent)からも
  同じファイルを読めるようにしている。
- `src/` は読み出しヘルパと整合性チェック。**データを変えるのはJSONだけ**。

## 使い方

```ts
import { isKnownTopicId, suggestTopics, prerequisitesOf } from "@ai-sensei/curriculum";

// サーバ側ガード: LLMが返したtopic_idがカリキュラム内か
isKnownTopicId("M2-ZUKEI-ENCHOKU"); // true

// 写真解析テキストから単元候補を引く
suggestTopics("円と直線の位置関係 中心と直線の距離 判別式"); // → [M2-ZUKEI-ENCHOKU, ...]

// 穴の深掘り: 「そもそも判別式って何のためにある?」の質問先を決める
prerequisitesOf("M2-ZUKEI-ENCHOKU"); // → [M1-NIJI-HANBETSU, M2-ZUKEI-TENTO-KYORI]
```

## トピックを追加するとき

```jsonc
{
  "id": "M2-ZUKEI-ENCHOKU",       // {コース接頭辞}-{単元}-{トピック} を大文字ローマ字で
  "course": "数学II",              // 接頭辞と一致していないとCIで落ちる
  "unit": "図形と方程式",
  "topic": "円と直線の位置関係",
  "goals": [                       // 質問生成のネタ元。「〜を説明できる」で書く
    "中心と直線の距離dと半径rの比較で位置関係を判定できる"
  ],
  "prerequisites": ["M1-NIJI-HANBETSU"],  // 穴の深掘り先。存在するIDのみ
  "keywords": ["円の方程式", "判別式"]     // 写真解析テキストとの突き合わせ用
}
```

チェックは `pnpm test` の中で回る:

- スキーマ(zod)— 未知フィールドは `strict()` で弾く
- ID重複 / 未定義の前提 / 自己参照 / 循環
- IDの接頭辞と `course` の一致
- **新課程の配当** — ベクトルが数学C、統計的な推測が数学B、仮説検定が数学I にあること
  (旧課程の知識で書き足すとここで落ちる)

## v0の範囲

52トピック。数I・数IIの頻出単元を厚めに、数A/B/III/Cは主要単元を1〜3トピックずつ。
到達目標は「解ける」ではなく **「説明できる」** で書く。このアプリが測るのは説明であり、
正誤ではないため。

拡充の手順は、LLMで下書き → 人手レビュー → JSONに追記 → `pnpm test`。
