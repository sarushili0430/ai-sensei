/**
 * 画面の配線。**アプリの勉強画面(撮影 → 授業 → カルテ)を1枚に畳んだもの。**
 *
 * ここが持つのは順番と表示だけで、契約に関わる判断は他のモジュールにある:
 * API の形は `api.js`、LiveKit は `room.js`、板書の検査は `board.js`、
 * 描画は `board-view.js`。**プロンプトを直したときに読む場所を1つにする**ため、
 * このファイルには「何を出すか」しか書かない。
 */
import { ApiClient, ApiError, decodeTokenMetadata } from "./api.js";
import { renderStep } from "./board-view.js";
import { BoardInbox } from "./board.js";
import { connectRoom } from "./room.js";

const $ = (id) => document.getElementById(id);

/** 手元の設定は localStorage に残す。試行のたびに入れ直さないため。 */
const SETTINGS_KEY = "ai-sensei.tuner.settings";

const state = {
  status: null,
  session: null,
  analysis: null,
  start: null,
  metadata: null,
  connection: null,
  inbox: null,
  envelopes: [],
  transcript: [],
  events: [],
  timings: {},
  karte: null,
  startedAt: null,
  photos: { problem: null, notes: null },
};

/* -------------------------------------------------------------------------- */
/* 設定                                                                       */
/* -------------------------------------------------------------------------- */

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  $("api-base").value = saved.apiBaseUrl ?? "";
  $("device-id").value = saved.deviceId ?? crypto.randomUUID();
  $("locale").value = saved.locale ?? "ja";
  $("school-stage").value = saved.schoolStage ?? "high_school";
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      apiBaseUrl: $("api-base").value,
      deviceId: $("device-id").value,
      locale: $("locale").value,
      schoolStage: $("school-stage").value,
    }),
  );
}

const client = () => new ApiClient($("api-base").value, $("device-id").value);
const locale = () => $("locale").value;

/* -------------------------------------------------------------------------- */
/* 観測(イベント・時間)                                                     */
/* -------------------------------------------------------------------------- */

/** 会話開始からの経過秒。**プロンプトを比べるとき、絶対時刻より役に立つ。** */
function elapsed() {
  return state.startedAt === null ? null : (performance.now() - state.startedAt) / 1000;
}

function log(event, fields = {}) {
  const entry = { at: new Date().toISOString(), elapsed_s: elapsed(), event, ...fields };
  state.events.push(entry);

  const item = document.createElement("li");
  const time = document.createElement("span");
  time.className = "mono";
  time.textContent = entry.elapsed_s === null ? "--.-" : `${entry.elapsed_s.toFixed(1)}s`;
  const name = document.createElement("strong");
  name.textContent = ` ${event} `;
  item.append(time, name);
  if (Object.keys(fields).length > 0) {
    const detail = document.createElement("span");
    detail.className = "note";
    detail.textContent = JSON.stringify(fields);
    item.append(detail);
  }
  $("events").prepend(item);
}

/** 名前つきの計測値。同じ名前は上書きしない(最初の1回が見たい値なので)。 */
function mark(name, seconds) {
  if (seconds === null || state.timings[name] !== undefined) return;
  state.timings[name] = Number(seconds.toFixed(2));
  renderTimings();
}

function renderTimings() {
  const list = $("timings");
  list.replaceChildren();
  for (const [name, value] of Object.entries(state.timings)) {
    const term = document.createElement("dt");
    term.textContent = name;
    const detail = document.createElement("dd");
    detail.className = "mono";
    detail.textContent = `${value.toFixed(2)}s`;
    list.append(term, detail);
  }
}

function showJson(id, value) {
  $(id).textContent = value === null ? "" : JSON.stringify(value, null, 2);
}

function fail(message) {
  const node = $("setup-error");
  node.textContent = message;
  node.classList.remove("hidden");
}

function clearFailure() {
  $("setup-error").classList.add("hidden");
}

/* -------------------------------------------------------------------------- */
/* 状態の取得(APIの死活・プロンプトの新しさ)                                */
/* -------------------------------------------------------------------------- */

async function refreshStatus() {
  const status = await (await fetch("/api/status")).json();
  state.status = status;
  if (!$("api-base").value) $("api-base").value = status.api_base_url;

  const banner = $("prompt-staleness");
  banner.classList.toggle("hidden", status.generated_matches_prompts);
  banner.textContent =
    "prompts/*.md と packages/prompts/src/generated.ts が食い違っている。pnpm --filter @ai-sensei/prompts generate を走らせて agent を再起動するまで、この編集は授業に反映されない。";

  const pill = $("health");
  try {
    const { body } = await client().health();
    pill.textContent = `API ${body.environment}`;
    pill.className = "pill pill-ok";
  } catch (error) {
    pill.textContent = `API 応答なし(${String(error)})`;
    pill.className = "pill pill-bad";
  }
}

/* -------------------------------------------------------------------------- */
/* ① 写真                                                                     */
/* -------------------------------------------------------------------------- */

function bindDropZone(id, slot) {
  const zone = $(id);
  const input = zone.querySelector("input");
  const preview = zone.querySelector("img");

  const take = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    state.photos[slot] = file;
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
    zone.classList.add("filled");
  };

  input.addEventListener("change", () => take(input.files[0]));
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("over");
    take(event.dataTransfer?.files?.[0]);
  });
  return take;
}

function renderAnalysis(analysis) {
  state.analysis = analysis;
  $("analysis").classList.remove("hidden");
  $("problem-text").textContent = analysis.problem
    ? `${analysis.problem.text}(${analysis.problem.source})`
    : "問題文は読み取れませんでした(null)";

  const chips = $("topics");
  chips.replaceChildren();
  for (const topic of analysis.detected_topics) {
    const chip = document.createElement("label");
    chip.className = "chip";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.value = topic.topic_id;
    const text = document.createElement("span");
    text.textContent = `${topic.label} ${topic.topic}`;
    const confidence = document.createElement("small");
    confidence.className = "mono";
    confidence.textContent = topic.confidence.toFixed(2);
    chip.append(box, text, confidence);
    chips.append(chip);
  }
  $("start").disabled = false;
}

function selectedTopicIds() {
  return [...$("topics").querySelectorAll("input:checked")].map((box) => box.value);
}

async function analyze() {
  clearFailure();
  saveSettings();
  const began = performance.now();
  try {
    const { body, traceId } = await client().createSession({
      notesPhoto: state.photos.notes,
      problemPhoto: state.photos.problem,
      locale: locale(),
      schoolStage: $("school-stage").value,
    });
    state.session = body.session_id;
    state.timings["写真の解析"] = Number(((performance.now() - began) / 1000).toFixed(2));
    renderTimings();
    log("session_created", { session_id: body.session_id, trace_id: traceId });
    renderAnalysis(body);
  } catch (error) {
    reportApiFailure("解析に失敗しました", error);
  }
}

async function applyTopics() {
  clearFailure();
  try {
    const { body } = await client().updateTopics(state.session, selectedTopicIds(), locale());
    log("topics_updated", { topic_ids: selectedTopicIds() });
    renderAnalysis(body);
  } catch (error) {
    reportApiFailure("単元の反映に失敗しました", error);
  }
}

function reportApiFailure(what, error) {
  if (error instanceof ApiError) {
    fail(`${what}: ${error.code} — ${error.body?.error?.message ?? ""}(trace ${error.traceId})`);
    log("api_error", { code: error.code, status: error.status, trace_id: error.traceId });
    return;
  }
  fail(`${what}: ${String(error)}`);
  log("request_failed", { message: String(error) });
}

/* -------------------------------------------------------------------------- */
/* ② 授業(音声と板書)                                                       */
/* -------------------------------------------------------------------------- */

const PHASE_LABELS = {
  connecting: ["接続中", "pill-idle"],
  listening: ["聞いています", "pill-ok"],
  thinking: ["考えています", "pill-ok"],
  speaking: ["先輩が説明中", "pill-live"],
  finished: ["終了", "pill-idle"],
  failed: ["失敗", "pill-bad"],
};

function setPhase(phase, detail) {
  const [text, className] = PHASE_LABELS[phase] ?? [phase, "pill-idle"];
  $("phase").textContent = detail ? `${text}(${detail})` : text;
  $("phase").className = `pill ${className}`;
}

async function start() {
  clearFailure();
  saveSettings();
  const began = performance.now();
  try {
    const { body } = await client().startSession(state.session, locale());
    state.start = body;
    state.startedAt = performance.now();
    mark("start の応答", (performance.now() - began) / 1000);

    const decoded = decodeTokenMetadata(body.livekit.token);
    state.metadata = decoded?.metadata ?? null;
    showJson("metadata", decoded);
    log("session_started", { room: body.livekit.room, max_seconds: body.limits.max_seconds });

    await connect(body);
  } catch (error) {
    setPhase("failed");
    reportApiFailure("授業を始められませんでした", error);
  }
}

async function connect(session) {
  setPhase("connecting");
  state.inbox = new BoardInbox(session.session_id);
  state.envelopes = [];

  state.connection = await connectRoom({
    url: session.livekit.url,
    token: session.livekit.token,
    audioElement: $("senpai-audio"),
    handlers: {
      onBoardPayload: onBoardPayload,
      onTranscript: onTranscript,
      onAgentState: (agentState) => {
        mark(`先輩が${agentState}になるまで`, elapsed());
        setPhase(agentState);
      },
      onAgentJoined: (identity) => {
        mark("先輩の入室", elapsed());
        log("senpai_joined", { identity });
        setPhase("listening");
      },
      onAgentMissing: () => {
        setPhase("failed", "先輩が来ない");
        log("senpai_missing", {});
        fail(
          "25秒待っても先輩が来ませんでした。agent が動いているか、" +
            "LIVEKIT_AGENT_NAME が API 側と揃っているかを確認してください。",
        );
      },
      onClosed: (reason) => {
        log("room_closed", { reason });
        void finish();
      },
      onLog: log,
    },
  });

  $("mic").disabled = false;
  $("finish").disabled = false;
  startCountdown(session.limits.max_seconds);
}

function onBoardPayload(payload) {
  let envelope = null;
  try {
    envelope = JSON.parse(payload);
  } catch {
    // 読めない封筒も観測の対象。inbox 側が欠落として扱う。
  }
  state.envelopes.push({ elapsed_s: elapsed(), payload: envelope ?? payload });
  showJson("envelopes", state.envelopes);

  if (envelope?.type === "board_open") mark("最初の板書(board_open)", elapsed());
  if (envelope?.type === "board_step") mark("最初の手順(board_step)", elapsed());

  const changed = state.inbox.acceptPayload(payload);
  if (changed) renderBoard();
}

function renderBoard() {
  const inbox = state.inbox;
  $("board-title").textContent = inbox.title ?? "(見出しなし)";
  $("board-meta").textContent = `${inbox.steps.length} 手順${
    inbox.closedReason ? ` / close: ${inbox.closedReason}` : ""
  }`;

  const gap = $("board-gap");
  if (inbox.gapReason) {
    gap.textContent = `板書がとぎれました: ${inbox.gapReason}`;
    gap.classList.remove("hidden");
  } else {
    gap.classList.add("hidden");
  }

  const list = $("steps");
  // 積み直しではなく差分で足す。**前の行は消さない**(消えるのは board_open のとき)。
  while (list.children.length > inbox.steps.length) list.lastElementChild.remove();
  for (let index = list.children.length; index < inbox.steps.length; index += 1) {
    list.append(renderStep(inbox.steps[index]));
  }
  list.lastElementChild?.scrollIntoView({ block: "nearest" });
}

function onTranscript({ id, speaker, text, final }) {
  const existing = state.transcript.find((line) => line.id === id);
  if (existing) {
    existing.text = text;
    existing.final = final;
  } else {
    state.transcript.push({ id, speaker, text, final, elapsed_s: elapsed() });
    if (speaker === "senpai") mark("先輩の最初の発話", elapsed());
  }
  renderTranscript();
}

function renderTranscript() {
  const list = $("transcript");
  list.replaceChildren();
  for (const line of state.transcript) {
    const item = document.createElement("li");
    item.className = `line line-${line.speaker}`;
    const who = document.createElement("strong");
    who.textContent = line.speaker === "senpai" ? "先輩" : "生徒";
    const body = document.createElement("span");
    body.textContent = ` ${line.text}`;
    item.append(who, body);
    if (!line.final) item.classList.add("partial");
    list.append(item);
  }
  list.lastElementChild?.scrollIntoView({ block: "nearest" });
}

let countdown = null;

function startCountdown(maxSeconds) {
  let remaining = maxSeconds;
  const tick = () => {
    $("remaining").textContent =
      `のこり ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining <= 0) {
      clearInterval(countdown);
      void finish();
    }
    remaining -= 1;
  };
  tick();
  countdown = setInterval(tick, 1000);
}

/** 会話を終える。**カルテはここから数秒〜十数秒かかる**ので、待って取りに行く。 */
async function finish() {
  if (countdown) clearInterval(countdown);
  countdown = null;
  $("finish").disabled = true;
  $("mic").disabled = true;

  if (state.connection) {
    await state.connection.disconnect().catch(() => undefined);
    state.connection = null;
  }
  setPhase("finished");
  mark("会話の終了", elapsed() ?? 0);
  await pollKarte();
}

async function pollKarte() {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    try {
      const result = await client().fetchResult(state.session);
      if (result) {
        state.karte = result.body;
        showJson("karte", result.body);
        mark("カルテの到着", elapsed());
        log("karte_ready", { holes: result.body.karte.holes.length });
        return;
      }
    } catch (error) {
      reportApiFailure("カルテを取得できませんでした", error);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log("karte_timeout", {});
}

/* -------------------------------------------------------------------------- */
/* 試行の保存                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 1回ぶんをJSONで落とす。**プロンプトの前後を比べるための唯一の材料**なので、
 * 画面に出しているものは全部入れる(文脈・板書・字幕・カルテ・時間)。
 */
function download() {
  const run = {
    saved_at: new Date().toISOString(),
    settings: {
      api_base_url: $("api-base").value,
      locale: locale(),
      school_stage: $("school-stage").value,
    },
    prompts: state.status?.prompts ?? [],
    session_id: state.session,
    analysis: state.analysis,
    session_metadata: state.metadata,
    timings: state.timings,
    board: state.envelopes,
    transcript: state.transcript,
    karte: state.karte,
    events: state.events,
  };
  const blob = new Blob([JSON.stringify(run, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `tuner-${state.session ?? "run"}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* -------------------------------------------------------------------------- */
/* 配線                                                                       */
/* -------------------------------------------------------------------------- */

loadSettings();
const takeProblem = bindDropZone("drop-problem", "problem");
const takeNotes = bindDropZone("drop-notes", "notes");

// クリップボードからの貼り付けは、**問題の枠**に入れる。
// 教科書の紙面をノート枠に入れる動機を作らないため(`sessionPhotoParts` の破棄の約束)。
document.addEventListener("paste", (event) => {
  const file = [...(event.clipboardData?.files ?? [])][0];
  if (file) takeProblem(file);
});

$("new-device").addEventListener("click", () => {
  $("device-id").value = crypto.randomUUID();
  saveSettings();
  void refreshStatus();
});
$("reload-status").addEventListener("click", () => void refreshStatus());
$("analyze").addEventListener("click", () => void analyze());
$("apply-topics").addEventListener("click", () => void applyTopics());
$("start").addEventListener("click", () => void start());
$("finish").addEventListener("click", () => void finish());
$("download").addEventListener("click", download);
$("mic").addEventListener("change", (event) => {
  void state.connection?.setMicrophoneEnabled(event.target.checked);
  log("microphone", { enabled: event.target.checked });
});
for (const id of ["api-base", "device-id", "locale", "school-stage"]) {
  $(id).addEventListener("change", saveSettings);
}

void refreshStatus();
// takeNotes は drop/クリック経由でしか使わないが、束縛を残しておくと
// コンソールから手で流し込める(fixtureの画像を試すときに便利)。
window.tuner = { state, takeNotes, takeProblem };
