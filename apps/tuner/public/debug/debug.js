/**
 * `/debug` — **授業を1本回さずに中身をいじる場所。**
 *
 * 授業の画面(`/`)は「実際に走らせて見る」ためのもので、走らせるには
 * 写真・鍵・LiveKit・今日の枠が要る。ここはそのどれも要らない側で、
 *
 *   ① 板書のJSONを手で貼って描く(先輩の出力が**描けるか**だけを見る)
 *   ② 保存した試行を読み込んで、封筒を**アプリと同じ受信箱**に流し直す
 *   ③ プロンプトの本文と、宣言されている差し込み変数を読む
 *   ④ いまの環境(APIのURL・generated.ts の同期)を見る
 *
 * を扱う。②が要るのは、プロンプトの前後比較は**同じ板書をもう一度見る**
 * ことでしか成立しないから — 会話は毎回違うが、保存した封筒は同じものを何度でも再生できる。
 */
import { renderStep } from "../board-view.js";
import { BoardInbox } from "../board.js";

const $ = (id) => document.getElementById(id);

/** 貼り付けの見本。**契約(`packages/contract/src/board.ts`)の8種を1つずつ。** */
const SAMPLES = {
  latex: { kind: "latex", tex: "D = b^2 - 4ac = 9 - 8 = 1 > 0" },
  text: { kind: "text", body: "a = 1, b = -3, c = 2" },
  plot: {
    kind: "plot",
    fn: "x^2 - 3*x + 2",
    domain: { min: -1, max: 4 },
    marks: [
      { at: { x: 1, y: 0 }, label: "x=1" },
      { at: { x: 2, y: 0 }, label: "x=2" },
    ],
  },
  triangle: {
    kind: "triangle",
    vertices: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 3 },
    ],
    labels: ["A", "B", "C"],
    marks: [{ vertex: 0, kind: "right_angle" }],
  },
  circle: { kind: "circle", center: { x: 0, y: 0 }, r: 2, labels: ["O", "r = 2"] },
  sentence: {
    kind: "sentence",
    text: "I have lived here for ten years.",
    gloss: "10年ここに住んでいる",
    focus: "have lived",
  },
  compare: {
    kind: "compare",
    title: "現在完了 と 過去形",
    columns: ["現在完了", "過去形"],
    rows: [
      ["いまも続いている", "終わった話"],
      ["for / since", "yesterday"],
    ],
  },
  授業1回ぶん: {
    title: "2次方程式の判別式",
    topic_ids: ["jp.math.hs.i.quadratic_discriminant"],
    steps: [
      {
        index: 0,
        speech: "まず、係数を確かめよう。",
        board: { kind: "text", body: "a=1, b=-3, c=2" },
      },
      { index: 1, speech: "判別式はどれだった?", awaits_student: true, board: null },
      { index: 2, speech: "そう、これ。", board: { kind: "latex", tex: "D = b^2 - 4ac" } },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* 板書の描画                                                                 */
/* -------------------------------------------------------------------------- */

function showBoard({ title, steps, gapReason, meta }) {
  $("board-title").textContent = title ?? "(見出しなし)";
  $("board-meta").textContent = meta ?? `${steps.length} 手順`;

  const gap = $("board-gap");
  gap.textContent = gapReason ? `板書がとぎれました: ${gapReason}` : "";
  gap.classList.toggle("hidden", !gapReason);

  const list = $("steps");
  list.replaceChildren();
  for (const step of steps) list.append(renderStep(step));
}

/** 貼られたJSONを、描ける手順の列に均す。**どの粒度で貼られても受ける。** */
export function toSteps(value) {
  if (Array.isArray(value)) return value.flatMap(toSteps);

  if (value && typeof value === "object") {
    // 1回の説明(LLMが出す形)
    if (Array.isArray(value.steps)) return value.steps.flatMap(toSteps);
    // 封筒(data channel を流れる形)
    if (typeof value.type === "string") {
      return value.type === "board_step" ? toSteps(value.step) : [];
    }
    // 手順
    if (typeof value.speech === "string") return [value];
    // 要素だけ。**speech は必須**なので、手貼りだと分かる文言を置く。
    if (typeof value.kind === "string") {
      return [{ index: 0, speech: "(手で貼った要素)", board: value }];
    }
  }
  throw new Error("板書として読めません(1回の説明・封筒・手順・要素のどれかを貼ってください)");
}

function draw() {
  const error = $("paste-error");
  try {
    const value = JSON.parse($("paste").value);
    const steps = toSteps(value);
    if (steps.length === 0) throw new Error("描く手順がありません(board_open / board_close だけ?)");
    showBoard({
      title: value?.title ?? "手貼り",
      steps: steps.map((step, index) => ({ ...step, index: step.index ?? index })),
    });
    error.classList.add("hidden");
  } catch (thrown) {
    error.textContent = String(thrown);
    error.classList.remove("hidden");
  }
}

/* -------------------------------------------------------------------------- */
/* ② 保存した試行のリプレイ                                                   */
/* -------------------------------------------------------------------------- */

const replay = { envelopes: [], position: 0, inbox: null };

function loadRun(run) {
  replay.envelopes = (run.board ?? [])
    .map((entry) => entry.payload)
    .filter((payload) => payload && typeof payload === "object");
  replay.inbox = new BoardInbox(run.session_id ?? "");
  replay.position = 0;

  const summary = $("run-summary");
  summary.replaceChildren();
  const rows = {
    session_id: run.session_id ?? "(なし)",
    保存: run.saved_at ?? "(なし)",
    封筒: `${replay.envelopes.length} 通`,
    ...Object.fromEntries(
      Object.entries(run.timings ?? {}).map(([name, value]) => [name, `${value}s`]),
    ),
  };
  for (const [name, value] of Object.entries(rows)) {
    const term = document.createElement("dt");
    term.textContent = name;
    const detail = document.createElement("dd");
    detail.className = "mono";
    detail.textContent = String(value);
    summary.append(term, detail);
  }

  const transcript = $("transcript");
  transcript.replaceChildren();
  for (const line of run.transcript ?? []) {
    const item = document.createElement("li");
    item.className = `line line-${line.speaker}`;
    const who = document.createElement("strong");
    who.textContent = line.speaker === "senpai" ? "先輩" : "生徒";
    item.append(who, ` ${line.text}`);
    transcript.append(item);
  }

  $("metadata").textContent = JSON.stringify(run.session_metadata ?? null, null, 2);
  $("karte").textContent = JSON.stringify(run.karte ?? null, null, 2);

  for (const id of ["replay-reset", "replay-step", "replay-all"]) $(id).disabled = false;
  renderReplay();
}

function advance(count) {
  for (let index = 0; index < count && replay.position < replay.envelopes.length; index += 1) {
    replay.inbox.accept(replay.envelopes[replay.position]);
    replay.position += 1;
  }
  renderReplay();
}

function renderReplay() {
  const inbox = replay.inbox;
  if (!inbox) return;
  $("replay-position").textContent = `${replay.position} / ${replay.envelopes.length} 通`;
  showBoard({
    title: inbox.title,
    steps: inbox.steps,
    gapReason: inbox.gapReason,
    meta: `${inbox.steps.length} 手順${inbox.closedReason ? ` / close: ${inbox.closedReason}` : ""}`,
  });
}

/* -------------------------------------------------------------------------- */
/* ③④ プロンプトと環境                                                        */
/* -------------------------------------------------------------------------- */

async function loadEnvironment() {
  const status = await (await fetch("/api/status")).json();
  $("environment").textContent = JSON.stringify(status, null, 2);
  $("prompt-state").textContent = status.generated_matches_prompts
    ? "generated.ts は prompts/*.md と一致している(agent の再起動は別途)"
    : "prompts/*.md と generated.ts が食い違っている。pnpm --filter @ai-sensei/prompts generate";

  const select = $("prompt-file");
  select.replaceChildren();
  for (const prompt of status.prompts) {
    const option = document.createElement("option");
    option.value = prompt.file;
    option.textContent = prompt.file;
    select.append(option);
  }
  await loadPrompt();
}

async function loadPrompt() {
  const file = $("prompt-file").value;
  if (!file) return;
  const prompt = await (await fetch(`/api/prompt?file=${encodeURIComponent(file)}`)).json();

  const meta = $("prompt-meta");
  meta.replaceChildren();
  for (const [name, value] of Object.entries(prompt.meta ?? {})) {
    const term = document.createElement("dt");
    term.textContent = name;
    const detail = document.createElement("dd");
    detail.className = "mono";
    detail.textContent = Array.isArray(value) ? value.join(", ") : String(value);
    meta.append(term, detail);
  }
  $("prompt-body").textContent = prompt.body ?? "";
}

/* -------------------------------------------------------------------------- */
/* 配線                                                                       */
/* -------------------------------------------------------------------------- */

for (const [name, sample] of Object.entries(SAMPLES)) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = name;
  button.addEventListener("click", () => {
    $("paste").value = JSON.stringify(sample, null, 2);
    draw();
  });
  $("samples").append(button);
}

$("draw").addEventListener("click", draw);
$("clear").addEventListener("click", () => {
  $("paste").value = "";
  showBoard({ title: null, steps: [] });
});
$("replay-reset").addEventListener("click", () => {
  replay.inbox = new BoardInbox(replay.inbox?.sessionId ?? "");
  replay.position = 0;
  renderReplay();
});
$("replay-step").addEventListener("click", () => advance(1));
$("replay-all").addEventListener("click", () => advance(replay.envelopes.length));
$("prompt-file").addEventListener("change", () => void loadPrompt());

const runZone = $("drop-run");
const runInput = runZone.querySelector("input");
const takeRun = async (file) => {
  if (!file) return;
  loadRun(JSON.parse(await file.text()));
  runZone.classList.add("filled");
};
runInput.addEventListener("change", () => void takeRun(runInput.files[0]));
runZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  runZone.classList.add("over");
});
runZone.addEventListener("dragleave", () => runZone.classList.remove("over"));
runZone.addEventListener("drop", (event) => {
  event.preventDefault();
  runZone.classList.remove("over");
  void takeRun(event.dataTransfer?.files?.[0]);
});

void loadEnvironment();
