/**
 * いまのUIの一覧HTMLを組み立てる。
 *
 *   cd apps/mobile && fvm flutter test tool/generate_ui_overview.dart
 *   pnpm run ui:overview
 *
 * 材料は `docs/ui/screens/`(実画面から焼いたPNGと `manifest.json`)。
 * 出力は `docs/ui/index.html`。既定では PNG を**相対パスで参照する**
 * (リポジトリに置く版。焼き直すたびに数MBのHTMLをコミットしないため)。
 *
 *   --embed            PNGを全部base64で埋めた1枚を書き出す。HTMLだけを
 *                      誰かに渡すとき用。リポジトリにはコミットしない
 *   --out <path>       書き出し先を変える(既定は docs/ui/index.html)
 *   --fragment <path>  claude.ai の Artifact 用に、doctype/html/head/body の
 *                      外枠を外した中身を書き出す(公開側が包むので。常に埋め込み)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Shot = {
  slug: string;
  group: string;
  title: string;
  route: string | null;
  source: string;
  note: string;
  width: number;
  height: number;
};

/**
 * 線ごとの目印。色そのものはCSS側(`--group`)に持たせる。
 *
 * **地が2つある**(明るい地と、板書色の暗い地)ので、色を直書きすると
 * 授業の線(板の深緑)が暗いテーマで消える。キーだけを渡してテーマごとに
 * 引き当てる。値の出どころは `apps/mobile/lib/src/theme/tokens.dart` と
 * `board_style.dart` で、一覧のために新しい色は作らない。
 */
const GROUP_KEYS: Record<string, string> = {
  はじめて開いたとき: "intro",
  常設タブ: "tabs",
  授業の線: "lesson",
  戻ってくる線: "comeback",
  課金: "billing",
  板書パーツ: "board",
};

/** 見出しの下に何を並べているかを1行で言う。 */
const GROUP_NOTES: Record<string, string> = {
  はじめて開いたとき: "初回起動。機能より先に約束を伝える3枚。",
  常設タブ: "いつでも戻れる場所。ホーム・計画・設定の3枝(ADR 0006)。",
  授業の線: "撮影 → 会話 → 祝福 → カルテ。タブから抜けられない1本道。",
  戻ってくる線: "翌日以降。穴を埋めにくる導線と、親に見せる1枚。",
  課金: "買うかどうかを決めている画面。常設ナビは重ねない。",
  板書パーツ: "板書に出る要素の実物。画面ではないので板の上だけを切り出している。",
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export function groupsOf(shots: Shot[]): string[] {
  const seen: string[] = [];
  for (const shot of shots) if (!seen.includes(shot.group)) seen.push(shot.group);
  return seen;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHubの実装ファイルへ飛べるようにする。既定はdevelop。 */
const sourceUrl = (path: string, ref: string): string =>
  `https://github.com/sarushili0430/ai-sensei/blob/${ref}/apps/mobile/${path}`;

/** 画像の参照先。埋め込むか、隣のPNGを指すか。 */
const imageSrc = (dir: string, slug: string, embed: boolean): string =>
  embed
    ? `data:image/png;base64,${readFileSync(join(dir, `${slug}.png`)).toString("base64")}`
    : `screens/${slug}.png`;

/** 画面(縦長)と板書パーツ(横長)で並べ方が違うので、束ねる単位で見分ける。 */
const BOARD_GROUP = "板書パーツ";
const isBoardTile = (shot: Shot): boolean => shot.group === BOARD_GROUP;

function cardHtml(shot: Shot, screensDir: string, ref: string, embed: boolean): string {
  const src = imageSrc(screensDir, shot.slug, embed);
  const place = shot.route
    ? `<code class="chip chip--route">${escapeHtml(shot.route)}</code>`
    : `<span class="chip chip--outside">${isBoardTile(shot) ? "板書の部品" : "タブの外"}</span>`;

  // idは数字始まりにしない。HTMLとしては通るが、CSSやquerySelectorの
  // セレクタとしては不正になり、1枚だけを指す手段が消える。
  return `<article class="card" id="s-${escapeHtml(shot.slug)}">
  <button class="shot" type="button" data-title="${escapeHtml(shot.title)}" aria-label="${escapeHtml(shot.title)}を大きく見る">
    <img src="${src}" width="${shot.width}" height="${shot.height}" alt="${escapeHtml(shot.title)}の画面" loading="lazy" />
  </button>
  <div class="card__body">
    <h3>${escapeHtml(shot.title)}</h3>
    <div class="card__meta">${place}</div>
    <p class="card__note">${escapeHtml(shot.note)}</p>
    <a class="card__source" href="${sourceUrl(shot.source, ref)}" target="_blank" rel="noreferrer">${escapeHtml(shot.source.replace(/^lib\/src\//, ""))}</a>
  </div>
</article>`;
}

function sectionHtml(
  group: string,
  shots: Shot[],
  screensDir: string,
  ref: string,
  embed: boolean,
): string {
  const id = `g${groupsOf(shots).indexOf(group) + 1}`;
  const mine = shots.filter((shot) => shot.group === group);
  const gridClass = group === BOARD_GROUP ? "grid grid--tiles" : "grid";

  return `<section class="section is-${GROUP_KEYS[group] ?? "intro"}" id="${id}">
  <header class="section__head">
    <h2><span class="dot"></span>${escapeHtml(group)}</h2>
    <p>${escapeHtml(GROUP_NOTES[group] ?? "")}</p>
    <span class="count">${mine.length}</span>
  </header>
  <div class="${gridClass}">
${mine.map((shot) => cardHtml(shot, screensDir, ref, embed)).join("\n")}
  </div>
</section>`;
}

const STYLE = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" />
<style>
  /* 地・文字・線はアプリのトークンそのまま。暗いほうは板書の色を地にする
     (board_style.dart)。一覧のために新しい色を作らない。 */
  :root {
    --ground: #fbfaf7;
    --surface: #ffffff;
    --surface-sunken: #f3f1ea;
    --ink: #33323d;
    --ink-muted: #7a7887;
    --border: #e6e3dc;
    --accent: #0ea5e9;
    --said: #ffd93b;
    --hole: #ff7aa8;
    --shadow: 0 12px 28px rgba(51, 50, 61, 0.10);
    --shadow-hover: 0 18px 40px rgba(51, 50, 61, 0.16);
    /* 線ごとの目印。明るい地の上で読める側の値。 */
    --g-intro: #0ea5e9;
    --g-tabs: #7a7887;
    --g-lesson: #2f3a35;
    --g-comeback: #ff7aa8;
    --g-billing: #ff9f1c;
    --g-board: #c08a12;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #232b27;
      --surface: #2f3a35;
      --surface-sunken: #28312c;
      --ink: #edeae0;
      --ink-muted: #9fa8a2;
      --border: #3d4a43;
      --accent: #56c9f5;
      --said: #f2d675;
      --hole: #ff9dbe;
      --shadow: 0 12px 28px rgba(0, 0, 0, 0.34);
      --shadow-hover: 0 18px 40px rgba(0, 0, 0, 0.46);
      /* 板の色を地にした側。深緑(授業の線)はチョーク寄りに置き換える。 */
      --g-intro: #56c9f5;
      --g-tabs: #9fa8a2;
      --g-lesson: #a9c6b5;
      --g-comeback: #ff9dbe;
      --g-billing: #ffb74d;
      --g-board: #f2d675;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --ground: #232b27;
    --surface: #2f3a35;
    --surface-sunken: #28312c;
    --ink: #edeae0;
    --ink-muted: #9fa8a2;
    --border: #3d4a43;
    --accent: #56c9f5;
    --said: #f2d675;
    --hole: #ff9dbe;
    --shadow: 0 12px 28px rgba(0, 0, 0, 0.34);
    --shadow-hover: 0 18px 40px rgba(0, 0, 0, 0.46);
    --g-intro: #56c9f5;
    --g-tabs: #9fa8a2;
    --g-lesson: #a9c6b5;
    --g-comeback: #ff9dbe;
    --g-billing: #ffb74d;
    --g-board: #f2d675;
    color-scheme: dark;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: "Zen Kaku Gothic New", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }

  .wrap {
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 24px 96px;
  }

  h1, h2, h3 {
    font-family: "Zen Maru Gothic", "Zen Kaku Gothic New", "Hiragino Sans", sans-serif;
    font-weight: 700;
    text-wrap: balance;
    margin: 0;
  }

  code, .mono {
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
    font-variant-numeric: tabular-nums;
  }

  /* --- 見出し --- */
  .hero {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 72px 0 40px;
  }
  .eyebrow {
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--ink-muted);
    margin: 0;
  }
  .hero h1 {
    font-size: clamp(30px, 5vw, 46px);
    line-height: 1.3;
  }
  /* 強調はboldではなく蛍光マーカー。アプリの署名をそのまま使う。 */
  .marker {
    background-image: linear-gradient(transparent 58%, var(--said) 58%, var(--said) 94%, transparent 94%);
  }
  .hero p {
    margin: 0;
    max-width: 62ch;
    color: var(--ink-muted);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 28px;
    padding: 18px 22px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface);
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fact dt {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--ink-muted);
    margin: 0;
  }
  .fact dd {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }

  /* --- 索引 --- */
  .index {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 0;
    margin-bottom: 12px;
    background: color-mix(in srgb, var(--ground) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .index a {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink);
    text-decoration: none;
    font-size: 13px;
  }
  .index a:hover { border-color: var(--accent); }
  .index a .dot { width: 8px; height: 8px; }
  .index a .n {
    color: var(--ink-muted);
    font-size: 12px;
  }

  /* --- 束ね --- */
  .section {
    padding: 44px 0 8px;
    scroll-margin-top: 72px;
  }
  .section__head {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 16px;
    align-items: baseline;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 26px;
  }
  .section__head h2 {
    font-size: 22px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section__head p {
    grid-column: 1 / 2;
    margin: 0;
    color: var(--ink-muted);
    font-size: 13.5px;
  }
  .section__head .count {
    grid-row: 1 / 3;
    grid-column: 2 / 3;
    align-self: center;
    font-family: "Zen Maru Gothic", sans-serif;
    font-size: 26px;
    color: var(--group);
  }
  .is-intro { --group: var(--g-intro); }
  .is-tabs { --group: var(--g-tabs); }
  .is-lesson { --group: var(--g-lesson); }
  .is-comeback { --group: var(--g-comeback); }
  .is-billing { --group: var(--g-billing); }
  .is-board { --group: var(--g-board); }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--group);
    flex: none;
  }

  /* --- 1枚 --- */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
    gap: 28px 22px;
  }
  .grid--tiles {
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-margin-top: 84px;
  }
  .shot {
    display: block;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    background: var(--surface-sunken);
    box-shadow: var(--shadow);
    cursor: zoom-in;
    transition: transform 180ms ease, box-shadow 180ms ease;
  }
  .shot:hover, .shot:focus-visible {
    transform: translateY(-3px);
    box-shadow: var(--shadow-hover);
  }
  .shot:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
  }
  .card__body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .card__body h3 { font-size: 15px; }
  .card__meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-size: 11.5px;
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--ink-muted);
    background: var(--surface);
  }
  .chip--route {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .card__note {
    margin: 0;
    font-size: 13px;
    color: var(--ink-muted);
    line-height: 1.7;
  }
  .card__source {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px;
    color: var(--ink-muted);
    text-decoration: none;
    word-break: break-all;
    opacity: 0.85;
  }
  .card__source:hover { color: var(--accent); text-decoration: underline; }

  /* --- 拡大 --- */
  dialog {
    border: none;
    padding: 0;
    background: transparent;
    max-width: min(96vw, 520px);
    max-height: 94vh;
    overflow: visible;
  }
  dialog::backdrop { background: rgba(20, 24, 22, 0.72); }
  dialog img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 88vh;
    object-fit: contain;
    border-radius: 22px;
    border: 1px solid var(--border);
    background: var(--surface);
  }
  dialog p {
    margin: 10px 0 0;
    text-align: center;
    color: #edeae0;
    font-size: 13px;
  }

  footer {
    margin-top: 64px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    color: var(--ink-muted);
    font-size: 13px;
  }
  footer code {
    font-size: 12px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1px 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    .shot { transition: none; }
    .shot:hover, .shot:focus-visible { transform: none; }
  }
</style>`;

const SCRIPT = `<script>
  // 一覧では小さいので、押したら等倍で見られるようにするだけ。
  const dialog = document.querySelector("dialog");
  const image = dialog.querySelector("img");
  const label = dialog.querySelector("p");
  for (const button of document.querySelectorAll(".shot")) {
    button.addEventListener("click", () => {
      // 拡大用のsrcは、カードの画像から借りる。data属性に同じbase64を持たせると
      // HTMLの重さが**そのまま倍**になる(1枚あたり数百KBのPNGを抱いているため)。
      image.src = button.querySelector("img").src;
      image.alt = button.dataset.title;
      label.textContent = button.dataset.title;
      dialog.showModal();
    });
  }
  dialog.addEventListener("click", () => dialog.close());
</script>`;

export function buildBody(
  shots: Shot[],
  screensDir: string,
  ref: string,
  stampedOn: string,
  embed: boolean,
): string {
  const groups = groupsOf(shots);
  const phoneCount = shots.filter((shot) => !isBoardTile(shot)).length;
  const tileCount = shots.length - phoneCount;

  const index = groups
    .map((group, i) => {
      const n = shots.filter((shot) => shot.group === group).length;
      return `<a class="is-${GROUP_KEYS[group] ?? "intro"}" href="#g${i + 1}"><span class="dot"></span>${escapeHtml(group)}<span class="n">${n}</span></a>`;
    })
    .join("\n      ");

  return `<div class="wrap">
    <header class="hero">
      <p class="eyebrow">ai-sensei / apps/mobile</p>
      <h1>いま動いているUIを、<span class="marker">1枚ずつ</span>並べたもの</h1>
      <p>モックでも図でもなく、実際のWidgetツリーを描いて焼いたスクリーンショットです。撮っているのはiPhone 15相当の1サイズだけ。押すと等倍で開きます。</p>
      <dl class="facts">
        <div class="fact"><dt>画面</dt><dd>${phoneCount} 枚</dd></div>
        <div class="fact"><dt>板書パーツ</dt><dd>${tileCount} 枚</dd></div>
        <div class="fact"><dt>寸法</dt><dd class="mono">393 × 852 pt @2x</dd></div>
        <div class="fact"><dt>言語</dt><dd>日本語(ja)</dd></div>
        <div class="fact"><dt>撮影</dt><dd class="mono">${escapeHtml(stampedOn)}</dd></div>
      </dl>
    </header>

    <nav class="index" aria-label="線ごとの索引">
      ${index}
    </nav>

${groups.map((group) => sectionHtml(group, shots, screensDir, ref, embed)).join("\n\n")}

    <footer>
      <p>焼き直しは <code>cd apps/mobile &amp;&amp; fvm flutter test tool/generate_ui_overview.dart</code> → <code>pnpm run ui:overview</code>。撮る状態は <code>tool/generate_ui_overview.dart</code> に並んでいます。</p>
      <p>ストア掲載用のスクリーンショット(サイズ違い・見出しつき)は <code>tool/generate_store_screenshots.dart</code>、崩れの検知は <code>test/golden/</code> の担当です。</p>
    </footer>
  </div>

  <dialog>
    <img src="" alt="" />
    <p></p>
  </dialog>`;
}

function main(): void {
  const args = process.argv.slice(2);
  const fragmentAt = args.indexOf("--fragment");
  const refAt = args.indexOf("--ref");
  const ref = (refAt >= 0 ? args[refAt + 1] : undefined) ?? "develop";

  const screensDir = join(repoRoot, "docs/ui/screens");
  const shots = JSON.parse(readFileSync(join(screensDir, "manifest.json"), "utf8")) as Shot[];

  const present = new Set(readdirSync(screensDir));
  const missing = shots.filter((shot) => !present.has(`${shot.slug}.png`));
  if (missing.length > 0) {
    throw new Error(`PNGが見つかりません: ${missing.map((shot) => shot.slug).join(", ")}`);
  }

  // 撮影日は**PNGの更新時刻**から取る。組み立てた日にすると、焼き直していない
  // のにHTMLだけ新しくなり、「いつ時点のUIか」が嘘になる。
  const bakedAt = Math.max(
    ...shots.map((shot) => statSync(join(screensDir, `${shot.slug}.png`)).mtimeMs),
  );
  const stampedOn = new Date(bakedAt).toISOString().slice(0, 10);

  const embed = args.includes("--embed");
  const title = "AI Sensei 画面カタログ";

  const standalone = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
${STYLE}
</head>
<body>
${buildBody(shots, screensDir, ref, stampedOn, embed)}
${SCRIPT}
</body>
</html>
`;
  const outAt = args.indexOf("--out");
  const out = (outAt >= 0 ? args[outAt + 1] : undefined) ?? join(repoRoot, "docs/ui/index.html");
  writeFileSync(out, standalone);
  console.log(
    `書き出しました: ${out} (${(standalone.length / 1024).toFixed(0)} KB${embed ? " / 画像込み" : ""})`,
  );

  const fragmentPath = fragmentAt >= 0 ? args[fragmentAt + 1] : undefined;
  if (fragmentPath) {
    const path = fragmentPath;
    // Artifactは1ファイルしか持てないので、こちらは必ず画像を埋め込む。
    const embedded = buildBody(shots, screensDir, ref, stampedOn, true);
    writeFileSync(path, `<title>${title}</title>\n${STYLE}\n${embedded}\n${SCRIPT}\n`);
    console.log(`Artifact用: ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
