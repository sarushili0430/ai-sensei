/**
 * apps/tuner の開発サーバ。**プロンプトチューニングのときだけ動かす。**
 *
 *   pnpm --filter @ai-sensei/tuner dev     # http://localhost:5273
 *
 * やることは3つだけで、依存は持たない(`node:http` のみ):
 *
 *   1. `public/` を配る(素のHTML/JS。ビルド手順を持たない)
 *   2. `/vendor/*` を `node_modules` の中身へ橋渡しする
 *      (livekit-client と KaTeX。CDNから引かないのは、
 *       **手元の版を lockfile で固定したまま**にするため)
 *   3. `/api/status` で「いま prompts/*.md が agent に反映されているか」を返す
 *
 * 3つ目がこのサーバを書いた理由。プロンプトを編集しても
 * `packages/prompts/src/generated.ts` を作り直して agent を再起動するまでは
 * **古い本文のまま授業が始まる**ので、画面から気づけないと、
 * 直したはずの挙動を延々と観察することになる。
 *
 * **配信物ではない。** Cloudflare にも載せない(apps/lp と違って wrangler の設定を
 * 持たないのは意図的)。ここが公開されると、リポジトリのファイルを配る口になる。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { buildGeneratedSource } from "../../packages/prompts/src/generate.ts";

const here = import.meta.dirname;
const repoRoot = resolve(here, "..", "..");

/** 画面のURL。8787(wrangler dev)とぶつからない番号にしてある。 */
const port = Number(process.env["TUNER_PORT"] ?? 5273);

/**
 * 画面が最初に入れておくAPIのURL。手元の `wrangler dev` が既定。
 * develop のワーカーに当てたいときだけ `API_BASE_URL` で上書きする。
 */
const apiBaseUrl = process.env["API_BASE_URL"] ?? "http://localhost:8787";

/** 配ってよいディレクトリ。**ここに書いたものだけが外から読める。** */
const roots: { prefix: string; dir: string }[] = [
  { prefix: "/vendor/livekit-client/", dir: join(here, "node_modules", "livekit-client", "dist") },
  { prefix: "/vendor/katex/", dir: join(here, "node_modules", "katex", "dist") },
  { prefix: "/", dir: join(here, "public") },
];

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * prompts/*.md が、agent が読む `generated.ts` に反映されているか。
 *
 * **mtime では見ない。** クローン直後は全ファイルが同じ秒に並ぶので、
 * 新旧の判定がミリ秒の運になり、**何も編集していないのに赤帯が出る**。
 * 一度でも空振りすると、この帯は次から読まれなくなる。
 *
 * 代わりに `buildGeneratedSource()` を呼んで、いまの `prompts/` から作った本文と
 * コミット済みの `generated.ts` を**そのまま比べる**(`packages/prompts` のテストと同じ判定)。
 * 食い違っていれば、その編集はまだ agent に届いていない。
 */
export async function promptStatus(): Promise<{
  generated_at: string | null;
  prompts: { file: string; modified_at: string }[];
  generated_matches_prompts: boolean;
}> {
  const promptsDir = join(repoRoot, "prompts");
  const generatedFile = join(repoRoot, "packages", "prompts", "src", "generated.ts");

  const names = (await readdir(promptsDir))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
  const prompts = await Promise.all(
    names.map(async (file) => ({
      file,
      modified_at: (await stat(join(promptsDir, file))).mtime.toISOString(),
    })),
  );

  const generated = existsSync(generatedFile) ? await readFile(generatedFile, "utf8") : null;
  return {
    generated_at: generated === null ? null : (await stat(generatedFile)).mtime.toISOString(),
    prompts,
    generated_matches_prompts: generated !== null && generated === buildGeneratedSource(),
  };
}

/**
 * URLのパスを、配ってよいファイルの実体に解決する。
 *
 * `..` で外へ出られないことを **resolve したあとの前方一致** で確かめる
 * (文字列のまま弾くと、エンコードされた `%2e%2e` を取りこぼす)。
 */
export function resolveFile(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded.endsWith("/") ? `${decoded}index.html` : decoded;

  for (const { prefix, dir } of roots) {
    if (!requested.startsWith(prefix)) continue;
    const candidate = resolve(dir, `.${requested.slice(prefix.length - 1)}`);
    if (candidate !== dir && !candidate.startsWith(dir + sep)) continue;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    return candidate;
  }
  return null;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (url.pathname === "/api/status") {
    sendJson(response, 200, { api_base_url: apiBaseUrl, ...(await promptStatus()) });
    return;
  }

  const file = resolveFile(url.pathname);
  if (!file) {
    sendJson(response, 404, { error: "not_found", path: url.pathname });
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
    // 開発専用。**キャッシュさせない** — 直したJSが反映されないのが
    // 「プロンプトを直したのに変わらない」と見分けがつかなくなる。
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(response);
}

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    sendJson(response, 500, { error: "internal_error", message: String(error) });
  });
}).listen(port, () => {
  console.log(`tuner: http://localhost:${port}  (API: ${apiBaseUrl})`);
});
