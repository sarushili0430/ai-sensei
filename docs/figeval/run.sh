#!/usr/bin/env bash
# 8問 × 2モデル × 3回。一発で描けるかを見たいので、会話は1往復だけ。
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
        timeout 240 claude -p "$prompt" --model "$model" \
          --system-prompt "$SPEC" "${NOTOOLS[@]}" \
          </dev/null > "$f.tmp" 2>"$f.err" \
          || echo "__CLI_FAILED__" >> "$f.tmp"
        mv "$f.tmp" "$f"          # 書き終わってから見えるようにする
      ) &
      while [ "$(jobs -rp | wc -l)" -ge 8 ]; do wait -n; done
    done
  done
done 3< "$HERE/prompts.tsv"

wait
echo "done: $(ls "$OUT"/*.txt 2>/dev/null | wc -l) 件"
