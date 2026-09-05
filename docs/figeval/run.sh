#!/usr/bin/env bash
# 全問題 × 2モデル × 3回。一発で描けるかを見たいので、会話は1往復だけ。
#
# **ここで一度、測り方を間違えた。** 両モデルとも「8問まとめて答える」出力を出し、
# 採点用の id まで書いてきた。ファイルを読みに行ったのだと思ったが、ちがった。
#   `while read ... done < prompts.tsv` の中で `claude -p` を起動すると、
#   claude が **標準入力を引き継いで、残りの問題を全部読んでしまう**。
#   問題文に「他の7問」がくっついていただけで、モデルは指示どおりに動いていた。
# → `< /dev/null` で塞ぐ。ツール禁止と空ディレクトリは、念のためそのまま残す。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"; mkdir -p "$OUT"
SANDBOX="$HERE/.sandbox"; rm -rf "$SANDBOX"; mkdir -p "$SANDBOX"
SPEC="$(cat "$HERE/spec.md")"
TRIALS="${TRIALS:-3}"
MODELS="${MODELS:-sonnet haiku}"
NOTOOLS=(--disallowedTools Read Glob Grep Bash Edit Write WebFetch WebSearch Task TodoWrite NotebookEdit)
# GNU coreutils の無いmacOSでも走らせる。無ければCLI自身の終了を待つ。
# macOS同梱のbash 3.2は `set -u` と空配列の展開を組み合わせると落ちるため、文字列で持つ。
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="$(command -v timeout)"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="$(command -v gtimeout)"
fi

run_claude() {
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" 240 claude "$@"
  else claude "$@"
  fi
}

wait_for_slot() {
  # macOS同梱のbash 3.2には `wait -n` がないため、先頭の実行中PIDを待つ。
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge 8 ]; do
    first_pid="$(jobs -rp | sed -n '1p')"
    [ -n "$first_pid" ] || return
    wait "$first_pid"
  done
}

CA_BUNDLE="/root/.ccr/ca-bundle.crt"
if [ -f "$CA_BUNDLE" ]; then export NODE_EXTRA_CA_CERTS="$CA_BUNDLE"; fi

node -e '
import("'"$HERE"'/problems.mjs").then(m => {
  m.PROBLEMS.forEach(p => console.log(p.id + "\t" + p.prompt));
});' > "$HERE/prompts.tsv"

cd "$SANDBOX" || exit 1
while IFS=$'\t' read -r id prompt <&3; do
  for model in $MODELS; do
    for t in $(seq 1 "$TRIALS"); do
      f="$OUT/${model}__${id}__${t}.txt"
      [ -s "$f" ] && continue
      (
        # プロキシの TLS で弾かれることがある(self-signed certificate detected)。
        # CA束を渡し、落ちたら少し待って2回まで引き直す。**通信の失敗をモデルの失敗に混ぜない。**
        for attempt in 1 2 3; do
          run_claude -p "$prompt" --model "$model" \
            --system-prompt "$SPEC" "${NOTOOLS[@]}" \
            </dev/null > "$f.tmp" 2>"$f.err" && break
          grep -q . "$f.tmp" && break        # 中身があるなら通信は成功している
          sleep $((attempt * 4))
        done
        if grep -Eq '^(Not logged in|Authentication required)' "$f.tmp"; then
          echo "__CLI_FAILED__" >> "$f.tmp"
        else
          grep -q . "$f.tmp" || echo "__CLI_FAILED__" >> "$f.tmp"
        fi
        mv "$f.tmp" "$f"          # 書き終わってから見えるようにする
      ) &
      wait_for_slot
    done
  done
done 3< "$HERE/prompts.tsv"

wait
echo "done: $(ls "$OUT"/*.txt 2>/dev/null | wc -l) 件"
