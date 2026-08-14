/**
 * A secret-leak guard, on the assumption of a public repository.
 *
 * The Next Gen Award requires this repo to be public from day one, so committing a
 * key even once means cleaning git history. The scanning logic (a pure function) and
 * the CLI are split so both CI and pre-commit can call it.
 *
 *   pnpm run verify:secrets
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export type Leak = {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
};

type Rule = {
  name: string;
  pattern: RegExp;
};

/**
 * The detection rules. A false positive that stops CI means nobody fixes it, so only
 * patterns that are almost certainly the real thing belong here.
 */
export const RULES: Rule[] = [
  { name: "anthropic-api-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-like-api-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/ },
  { name: "openrouter-api-key", pattern: /sk-or-v1-[A-Za-z0-9]{32,}/ },
  { name: "elevenlabs-api-key", pattern: /\bsk_[a-f0-9]{40,}\b/ },
  // A Deepgram key is 40 hex digits, indistinguishable on its own from a commit SHA.
  // The giveaway word can appear on either side of the value, so both directions are
  // checked, as with LiveKit.
  { name: "deepgram-api-key", pattern: /deepgram[^\n]*?\b[a-f0-9]{40}\b/i },
  { name: "deepgram-api-key", pattern: /\b[a-f0-9]{40}\b[^\n]*?deepgram/i },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // LiveKit keys are written as `LIVEKIT_API_KEY=API...`, so the giveaway word comes
  // *before* the value as well as after. Both directions are checked.
  { name: "livekit-api-key", pattern: /livekit[^\n]*?\bAPI[A-Za-z0-9]{10,}\b/i },
  { name: "livekit-api-key", pattern: /\bAPI[A-Za-z0-9]{10,}\b[^\n]*?livekit/i },
  { name: "revenuecat-secret-key", pattern: /\bsk_[A-Za-z0-9]{24,}\b/ },
  {
    name: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Paths excluded from scanning (this file and its test contain the pattern strings). */
export const DEFAULT_IGNORE = ["scripts/verify-no-secrets.ts", "scripts/verify-no-secrets.test.ts"];

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp3|mp4|wav|ttf|otf|woff2?|riv|keystore|jks)$/i;

const MAX_BYTES = 1_000_000;

export function scanContent(file: string, content: string): Leak[] {
  const leaks: Leak[] = [];
  const lines = content.split("\n");
  lines.forEach((text, index) => {
    // Lines explicitly marked as examples (.env.example placeholders and the like) are ignored
    if (/(?:pragma:\s*allowlist secret|EXAMPLE_ONLY)/i.test(text)) return;
    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      leaks.push({
        file,
        line: index + 1,
        rule: rule.name,
        excerpt: redact(match[0]),
      });
    }
  });
  return leaks;
}

/** Logging the detected value itself would make the CI log a second leak, so it is masked. */
export function redact(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}

export function scanFiles(
  repoRoot: string,
  files: string[],
  ignore: string[] = DEFAULT_IGNORE,
): Leak[] {
  const leaks: Leak[] = [];
  for (const file of files) {
    if (ignore.includes(file)) continue;
    if (BINARY_EXTENSIONS.test(file)) continue;
    const absolute = resolve(repoRoot, file);
    let content: string;
    try {
      if (statSync(absolute).size > MAX_BYTES) continue;
      content = readFileSync(absolute, "utf8");
    } catch {
      continue; // deleted files and the like are out of scope
    }
    leaks.push(...scanContent(file, content));
  }
  return leaks;
}

export function trackedFiles(repoRoot: string): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const files = trackedFiles(repoRoot);
  const leaks = scanFiles(repoRoot, files);

  if (leaks.length === 0) {
    console.log(`✔ シークレットの混入なし (${files.length} files scanned)`);
    return;
  }

  console.error("✘ シークレットらしき文字列を検出しました:");
  for (const leak of leaks) {
    console.error(`  ${leak.file}:${leak.line}  [${leak.rule}]  ${leak.excerpt}`);
  }
  console.error(
    "\n本物なら鍵をローテートし、履歴から除去してください。" +
      "誤検知なら該当行に `pragma: allowlist secret` を付けてください。",
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(resolve(process.argv[1]), resolve(import.meta.dirname, "verify-no-secrets.ts")) === "";

if (invokedDirectly) main();
