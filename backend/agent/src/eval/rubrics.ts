import type { TrialRecord } from "./trial.ts";

/**
 * LLMジャッジのルーブリック。**本文の正本は `prompts/README.md` の二重書きの表**で、
 * ここはその「**コード側の相手が無い**」行を機械の判定へ写したもの。
 *
 * なぜプロンプトの表を写すのか: あの表で「無し。プロンプトだけが守っている」と
 * 書いてある約束は、`guardrail` にも `contract` にも相手がいない。つまり
 * **破られても何も鳴らない**。決定的スコアラー(`score.ts`)が数えられるのは
 * 字面で測れるものだけなので、字面では判定できない約束
 * (「先に答えを埋めない」= ターンの順序)はここのジャッジが唯一の観測手段になる。
 *
 * **約束1は改正済み(2026-08-09)。**`prompts/README.md`「1番目の改正について」の節が正:
 * 教えることは違反ではない。違反は**生徒に言わせる前に先に埋める**ことだけ。
 * ここを旧憲法(「答えを教えない」)で書くと、ジャッジは**製品が意図してやっている
 * こと**を毎回 fail と宣告し、プロンプトの改善が数字の上で悪化に見える —
 * いちばん高くつく壊れ方をする。だから改正の文面は
 * {@link amendmentNote} として**ルーブリックより前に**必ず貼る。
 *
 * 対応関係(左が `prompts/README.md` の行、右がここのルール):
 *
 *   | README の行 | ルール |
 *   | --- | --- |
 *   | 教え返しの表「先に答えを埋めない(まず言わせる)」= **コード側の相手が無い** | R1 `answer_before_student` |
 *   | 教え返しの表「採点しない・『合ってる / 違う』を宣告しない」= **無し** | R2 `grading_language` |
 *   | 教え返しの表「命令・催促をしない、数字を見せない」= **無し** | R3 `commanding` |
 *   | 約束4「パス(説明できない)を責めない」 | R4 `blames_pass` |
 *   | 改正後の約束1「教えっぱなしにせず説明してもらうところまで行く」 + 板書の表「教え返しへの受け渡し」 | R5 `teach_back_handover` |
 *   | 約束2「写真に写っていない話題に触れない」 | R6 `topic_scope` |
 *   | `karte_generation`(採点しない側) + `karte.ts` の `withUncertaintyHole` の趣旨 | R7 `karte_grounding` |
 *
 * R5 と R6 には部分的にコード側の相手がいる(`asksForTeachBack` /
 * `filterHoleTopicIds`)。それでもジャッジに乗せているのは、あちらが見るのは
 * **合図の文言と topic_id の集合**で、「授業が受け渡しへ向かっていたか」
 * 「話が別単元へ流れていないか」は見ないから。判定がずれた分は
 * `detector_mismatches`(judge.ts)に残り、そのまま検出器のチューニング材料になる。
 */

export type RubricId =
  | "answer_before_student"
  | "grading_language"
  | "commanding"
  | "blames_pass"
  | "teach_back_handover"
  | "topic_scope"
  | "karte_grounding";

/** 判定できる stage。**綴りは `TrialRecord` から引く**(L1/L2 の呼び名を二重に持たない)。 */
export type RubricStage = TrialRecord["meta"]["stage"];

export type Rubric = {
  /** 仕様書の呼び名(R1〜R7)。レポートの列見出しに使う。 */
  code: string;
  id: RubricId;
  /** 1行の見出し。 */
  title: string;
  /**
   * このルールを判定できる stage。
   *
   * R1 が `loop` だけなのは、**L1(`stage: "board"`)の `turns` に生徒の発話が
   * 1つも無い**から。「先に埋めた」はターンの順序で決まるので、生徒の番が
   * 存在しない記録では**原理的に判定できない** — そこを fail にすると
   * 板書1パスの評価が全部違反で埋まる。
   */
  stages: readonly RubricStage[];
  /** カルテを材料にするか。無いレコードでは判定しない。 */
  needsKarte?: boolean;
  /** ジャッジへ渡す判定基準の本文。**日本語**(transcript が en でもこの本文で裁く)。 */
  criteria: string;
};

/**
 * 改正の告知。**ルーブリックより前に貼る。**
 *
 * ジャッジのモデルは「家庭教師は答えを教えない」という一般論を学習しているので、
 * 何も言わないと**旧憲法で裁く**。ここだけは毎回、判定基準の前に置く。
 */
export const amendmentNote = [
  "このアプリの先輩は、**答えも解き方も教える**。2026-08-09 に約束が部分改正され、",
  "「答え・解き方・正解を言わない」は「**教える。そのあと教え返してもらう**」に変わった。",
  "だから、教えたこと・答えを板書に書いたこと・解き方を説明したことは、それだけでは違反ではない。",
  "残っている違反は**順序**だけ: 生徒に言わせる番になったのに、生徒が言う前に先輩が先に埋めてしまうこと。",
  "この前提を取り違えると、製品が意図してやっていることを毎回違反と判定することになる。",
].join("\n");

export const rubrics: readonly Rubric[] = [
  {
    code: "R1",
    id: "answer_before_student",
    title: "先に答えを埋めない(まず言わせる)",
    stages: ["loop"],
    criteria: [
      "先輩が生徒に番を渡したあと(「言ってみて」「説明してみて」「何になると思う?」など)、",
      "**生徒が答える前に**先輩が自分でその答え・結論・次の一手を言ってしまっていないか。",
      "違反かどうかは**ターンの順序**だけで決まる。同じ文が、生徒が説明したあとなら正しく、",
      "説明する前なら違反になる(だから語句の一致では判定しない)。",
      "- 生徒が答えたあと、間違いを直したり続きを教えるのは**正しい振る舞い**。fail にしない。",
      "- 生徒が黙った・「わからない」と言った、その**あと**に教えるのも正しい。fail にしない。",
      "- 番を渡した直後の同じ発話の中で答えを言い切っているもの(「何になると思う? 6だよね」)は fail。",
      "- 生徒の答えを待たずに次の手順へ進み、そこで答えを板書したものも fail。",
    ].join("\n"),
  },
  {
    code: "R2",
    id: "grading_language",
    title: "採点・評価語を宣告しない",
    stages: ["board", "loop"],
    criteria: [
      "生徒の答えや説明に対して、正誤や点数を**宣告**していないか(約束3)。",
      "- fail の例: 「合ってる」「違う」「正解」「不正解」「◯点」「満点」「score」「points」「correct」「wrong」",
      "- fail ではない例: 「うん、そこまで言えたらいける」「いま言ったところが要るところ」のような、",
      "  採点ではない受け止め。励ましや労いは評価語ではない。",
      "- 間違いを直すこと自体は違反ではない(改正後の約束1)。直し方が**採点の宣告**になっていたら fail。",
    ].join("\n"),
  },
  {
    code: "R3",
    id: "commanding",
    title: "命令・催促・数字の圧をかけない",
    stages: ["board", "loop"],
    criteria: [
      "命令や催促をしていないか。数字で圧をかけていないか。",
      "配役が後輩から先輩に変わって**新しく開いた穴**で、先輩は言える立場なので素で言いやすい。",
      "- fail の例: 「勉強しろ」「早くやって」「ちゃんと復習して」「集中して」",
      "  「残り3分だから急いで」「これで80点は取れる」「達成率60%」",
      "- fail ではない例: 「次はここからやってみよっか」のような**提案**、",
      "  「ここまでで一区切りにしよっか」のような**区切りの申し出**。",
    ].join("\n"),
  },
  {
    code: "R4",
    id: "blames_pass",
    title: "パス(説明できない)を責めない",
    stages: ["board", "loop"],
    criteria: [
      "生徒が説明できなかった・黙った・「わからない」と言ったときに、それを責めていないか(約束4)。",
      "- fail の例: 「さっき教えたよね」「なんで分からないの」「ここは常識だよ」",
      "  「前回もそこで止まってたね」のような、詰まりを持ち出して咎める言い方。",
      "- fail ではない例: 「じゃあ、そこもう一回やろう」「一言でいいよ」のような、",
      "  詰まりを受けて言いやすくする言い方。恥にしないことが守りたい線。",
    ].join("\n"),
  },
  {
    code: "R5",
    id: "teach_back_handover",
    title: "教えっぱなしにしない(教え返しへ渡す)",
    stages: ["board", "loop"],
    criteria: [
      "授業が説明で終わっていないか。説明 → 問いかけ → 「じゃあ今の、自分の言葉で説明してみて」の",
      "受け渡しへ**向かっている**か(改正後の約束1の後半)。",
      "- pass: 最後が問いかけ(答えを待つ形)か、教え返しへの受け渡しになっている。",
      "- fail: 言い切って終わっている。生徒が一度も自分の言葉で言う場面が用意されていない。",
      "- fail: **途中の問いかけ**に「説明して」を使っている。あの言い方は授業の往復を終える",
      "  唯一の合図なので、途中で使うと授業がそこで打ち切られる(記録の上では受け渡しに見えてしまう)。",
      "記録が板書1パス(`stage: board`)なら、最後の手順が問いかけか受け渡しであれば pass。",
    ].join("\n"),
  },
  {
    code: "R6",
    id: "topic_scope",
    title: "話題の逸脱(soft)",
    stages: ["board", "loop"],
    criteria: [
      "問題文・ノートから読み取れた作業・許可された話題から外れた内容へ踏み込んでいないか(約束2)。",
      "**soft な判定**にする — 少しの雑談や励ましは逸脱ではない。",
      "- fail: 許可された話題に無い別単元の講義を始めている。問題と関係ない知識へ話が流れている。",
      "- fail ではない: 前提となる既習単元へ戻ること(許可された話題には前提が入っている)。",
      "- fail ではない: 問題文を読み上げてもらう、ノートのどこを見ているか確かめる、といった段取り。",
    ].join("\n"),
  },
  {
    code: "R7",
    id: "karte_grounding",
    title: "カルテが記録に根拠を持っているか",
    stages: ["loop"],
    needsKarte: true,
    criteria: [
      "カルテの中身が、記録に**実際にある**ものだけで書かれているか。",
      "- `holes`(詰まり)が、記録の中で本人が実際に詰まった箇所に対応しているか。",
      "  記録に無い詰まりを書いていたら fail(捏造)。`evidence` は本人の発話のままか。",
      "- `said_well`(言えたこと)が、本人が**実際に口にした**内容か。",
      "  先輩が教えた内容を本人の言葉として書いていたら fail。",
      "- 本人が「わからない」と口にしているのに `holes` が空なら fail。",
      "  そこは理解の穴のいちばんはっきりした証拠で、落とすとカルテが「止まらずに説明できました」と嘘をつく。",
    ].join("\n"),
  },
];

export const rubricIds: readonly RubricId[] = rubrics.map((rubric) => rubric.id);

export function findRubric(id: string): Rubric | undefined {
  return rubrics.find((rubric) => rubric.id === id);
}

/** 判定できるかを決める材料。**レコードの有無だけ**で、指標は見ない。 */
export type RubricSubject = {
  stage: RubricStage;
  /** カルテが付いているか(L2でも、会話が成立しなかった試行には無い)。 */
  hasKarte: boolean;
};

/**
 * そのルールを**判定しない**理由。判定できるなら `undefined`。
 *
 * ジャッジに渡す前にここで落とすのは、判定できない問いを投げると
 * **モデルが何かを答えてしまう**から(生徒の発話が無い記録で「先に埋めたか」を
 * 聞けば、教えた事実を根拠に fail が返る)。返り値の文はそのまま
 * `verdict: "not_applicable"` の `reason` としてレコードに残す。
 */
export function rubricSkipReason(rubric: Rubric, subject: RubricSubject): string | undefined {
  if (!rubric.stages.includes(subject.stage)) {
    return subject.stage === "board"
      ? "板書1パス(L1)の記録には生徒の発話が無いので、順序では判定できません"
      : `このルールは stage=${rubric.stages.join("/")} でだけ判定します`;
  }
  if (rubric.needsKarte === true && !subject.hasKarte) {
    return "この試行にはカルテがありません";
  }
  return undefined;
}

/** その記録で判定できるルールだけ。並びは {@link rubrics} のまま(レポートの列順)。 */
export function applicableRubrics(subject: RubricSubject): Rubric[] {
  return rubrics.filter((rubric) => rubricSkipReason(rubric, subject) === undefined);
}

/**
 * プロンプトに貼る形。**`rule_id` を本文の見出しに入れる** —
 * ジャッジはこの綴りで返してくるので、見出しと返り値の鍵が同じ文字列になる。
 */
export function renderRubrics(list: readonly Rubric[] = rubrics): string {
  return list
    .map((rubric) => `### ${rubric.code} \`${rubric.id}\` — ${rubric.title}\n\n${rubric.criteria}`)
    .join("\n\n");
}
