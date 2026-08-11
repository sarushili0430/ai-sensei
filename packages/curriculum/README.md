# @ai-sensei/curriculum

カリキュラムマップ。
**後輩AIが触れてよい話題の全集合**であり、同時に「穴」のタグ付け語彙でもある。

**課程(track)ごとに1本**持つ([ADR 0005](../../docs/adr.md#adr-0005) /
[ADR 0007](../../docs/adr.md#adr-0007))。
日本の課程を英訳したものは、どこの国のカリキュラムでもないので作らない。

| track | ファイル | 課程 | トピック数 |
| --- | --- | --- | --- |
| `hs_math_ja` | `data/curriculum.v0.json` | 数学I / A / II / B / III / C(新課程) | 52 |
| `hs_math_en` | `data/curriculum.intl.v0.json` | Algebra 1 / Geometry / Algebra 2 / Precalculus / Calculus / Statistics | 57 |
| `jhs_math_ja` | `data/curriculum.jhs-math.v0.json` | 中学数学(第1〜3学年 × 数と式 / 図形 / 関数 / データの活用) | 27 |
| `jhs_english_ja` | `data/curriculum.jhs-english.v0.json` | 中学英語(文法事項 / 文構造 / 音声) | 25 |
| `hs_english_ja` | `data/curriculum.hs-english.v0.json` | 英語コミュニケーションI・II / 論理・表現I | 32 |

1つの track は `{ locale, subject, stage }` を持つ(`src/schema.ts` の `tracks`)。

- **`locale`(指導言語)は「先輩が話す言語」であって、教える中身の言語ではない。**
  日本の中学生が英語を学ぶ課程は `locale: "ja"` — 先輩は日本語で話し、
  通知も日本語で届く。
- `subject` は板書に使える要素と、同梱する音声補正ヒントを決める。
- `stage` はプロンプトに貼る課程を絞るのに使う。

実体は純JSON。TypeScript以外(Flutter・Python版agent)からも同じファイルを読める。
`src/` は読み出しヘルパと整合性チェック。**データを変えるのはJSONだけ**。

## 使い方

```ts
import {
  isKnownTopicId,
  localeOfTopicId,
  prerequisitesOf,
  suggestTopics,
  topicLabel,
  topicsForTracks,
  tracksForStage,
} from "@ai-sensei/curriculum";

// サーバ側ガード: LLMが返したtopic_idがカリキュラム内か(全課程横断)
isKnownTopicId("M2-ZUKEI-ENCHOKU"); // true
isKnownTopicId("A2-COORD-CIRCLE");  // true

// 写真解析テキストから単元候補を引く(課程を絞る)
suggestTopics("distance from the center to the line", 5, { tracks: ["hs_math_en"] });

// 穴の深掘り: 「そもそも判別式って何のためにある?」の質問先を決める
prerequisitesOf("M2-ZUKEI-ENCHOKU"); // → [M1-NIJI-HANBETSU, M2-ZUKEI-TENTO-KYORI]

// 一覧をプロンプトや画面に出すときは、必ず課程で絞る
topicsForTracks(tracksForStage("high_school", "ja"));

// 穴の言語は topic_id から決まる(通知文・復習画面がこれを使う)
localeOfTopicId("A1-QUAD-SOLVE"); // "en"

// チップや計画画面に出す短いラベル
topicLabel(findTopic("M2-ZUKEI-ENCHOKU")!); // "数学II"
```

`topics` / `findTopic` / `isKnownTopicId` は**全課程横断**で見る。IDが
課程をまたいで衝突しないので、ガードレールの照合は課程を気にせず通せる。
逆に、**一覧を人やLLMに見せるときは `topicsForTracks` で絞る**。混ぜると
英語のノートに「数学II / 図形と方程式」というチップが出る。

「その言語の課程を全部」を返す関数は**意図的に用意していない**。課程が増えた日に
無言でプロンプトが倍になるため。`tracksForStage(stage, locale)` と組で使うこと。

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
  "prerequisites": ["M1-NIJI-HANBETSU"],  // 穴の深掘り先。**同じ言語・同じ教科の**存在するID
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

### `grade_hint`(英語の課程だけ)

学年の目安。**表示ラベルにしか使わない。範囲の判定には絶対に使わない。**

学習指導要領は中学校英語の文法事項を**学年別に配当していない**(解説の付録7は
「中学校」一括で示し、配当は各校・教科書会社の裁量と本文にある)。
「中1でbe動詞」は教科書側の慣行なので、これで範囲を絞ると、別の教科書を
使っている生徒の単元が消える。

読んでよいのは `topicLabel()` ただ1つ。`suggestTopics` / `resolveDetectedTopics` に
**学年を渡す引数は存在しない**のが、この約束の実体。
学年が課程そのもので決まる中学数学(`course` が「中学1年 数学」)には書かない
— 書くと `checkIntegrity` が落とす。

## 課程を1本足すとき

1. `src/schema.ts` の `trackIds` に id を足す
2. 同じく `tracks` に `{ locale, subject, stage }` を書く
3. `jaCourseNames` などにコース名、`courseCodeByName` / `trackByCourseCode` に接頭辞
4. `courseNamesByTrack` にその課程で使えるコース名
5. `data/` に JSON を足し、`src/index.ts` の `curricula` に登録
6. **`packages/contract/src/karte.ts` の `topicIdSchema` の正規表現に接頭辞を足す**
   (contract は依存を持たない層なので二重定義。忘れると新しいIDが形で弾かれる)
7. **`apps/mobile/lib/src/l10n/strings.dart` の `planSubject()` に分岐を足す**
   (`apps/mobile/test/curriculum_label_test.dart` が忘れを検出する)

`curricula` が `Record<TrackId, Curriculum>` なので、1 で id を足して 5 を忘れると
**型で落ちる**。

チェックは `pnpm test` の中で回る:

- スキーマ(zod)— 未知フィールドは `strict()` で弾く
- ID重複 / 未定義の前提 / 自己参照 / 循環(**全課程横断**)
- IDの接頭辞と `course` の一致、接頭辞とファイルの `track` の一致、
  `course` とその課程の一致
- **別の言語・別の教科をまたいだ前提参照** — Algebra 2 の前提が 数学II に
  なっていないこと。段(中学 → 高校)はまたいでよい
- `grade_hint` が英語の課程にしか無いこと
- 宣言だけしてトピックが0件のコースが無いこと
- **新課程の配当**(`hs_math_ja`)— ベクトルが数学C、統計的な推測が数学B、
  仮説検定が数学I にあること(旧課程の知識で書き足すとここで落ちる)
- **科目名が訳語になっていないこと**(`hs_math_en`)— "Math II" のような名前を弾く

## v0の範囲

到達目標は技能(「因数分解できる」/ "Factor by pattern")だけで終わらせず、
**各トピックに必ず1つ以上、説明を問える目標**(「〜の理由を説明できる」/
"Explain why ...")を入れる。このアプリが測るのは説明であって正誤ではないので、
ここが薄いと質問が「解けますか?」になってしまう。テストで全トピックを検査している。

`hs_math_ja` は数I・数IIの頻出単元を厚めに、数A/B/III/Cは主要単元を1〜3トピックずつ。
`hs_math_en` は Algebra 1 → Calculus の主系列に Statistics を並走させた構成で、
行列・級数展開のように国や学校で扱いが割れるものは v0 では持たない。

`jhs_math_ja` は学習指導要領の領域(A 数と式 / B 図形 / C 関数 / D データの活用)を
学年ごとに割った27件。`jhs_english_ja` は解説の付録7「外国語の言語材料」から
文法事項・文構造を起こした25件で、**学年は `grade_hint`(表示専用)にしか無い**。

`hs_english_ja` は「5領域 × 論理の型」(解説本文)と、付録9の文法事項8項目
(不定詞 / 関係代名詞 / 関係副詞 / 接続詞 / 助動詞 / 前置詞 / 時制及び相 / 仮定法)で
32件。**付録9の高校の欄は「中学校の言語材料に加えて扱うもの」だけを示す**ので、
中学と重なる7項目は複製せず、`prerequisites` で中学英語(`JE-*`)を指している
(中学に無いのは関係副詞だけ)。

### キーワードの書き方(英語の課程)

**1語の一般英単語は入れない。** 英語のノートには `is` / `for` / `when` が必ず
出てくるので、それをキーワードにすると常にそのトピックが最上位に来る。
日本語の文法用語を主にし、英語は2語以上の句(`have been` / `in front of`)か、
その文法に特有の語(`whose` / `than`)だけにする。

それでも英語は数学よりキーワードが効きにくい(ノートに「to不定詞」とは書かれず、
写っているのは英文)。**空振り前提で `fallback_topic_id` を置く**のはそのため。

拡充の手順は、LLMで下書き → 人手レビュー → JSONに追記 → `pnpm test`。
