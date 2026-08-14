#!/usr/bin/env bash
# 8 problems x 2 models x 3 runs. One exchange only, since we want to see whether it
# draws first time.
#
# The measurement method was got wrong once here. Both models emitted "answer all 8 at
# once" output, including the scoring ids. It looked like they had read the file, but no:
#   starting `claude -p` inside `while read ... done < prompts.tsv` makes claude inherit
#   stdin and consume the remaining problems.
#   The other seven problems were simply attached to the prompt, and the models did
#   exactly as instructed.
# -> Closed with `< /dev/null`. The tool ban and the empty directory stay as a precaution.
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
        # The proxy's TLS sometimes rejects it (self-signed certificate detected).
        # Pass the CA bundle and, on failure, wait briefly and retry up to twice.
        # Do not mix transport failures into model failures.
        for attempt in 1 2 3; do
          NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
          timeout 240 claude -p "$prompt" --model "$model" \
            --system-prompt "$SPEC" "${NOTOOLS[@]}" \
            </dev/null > "$f.tmp" 2>"$f.err" && break
          grep -q . "$f.tmp" && break        # content means the request succeeded
          sleep $((attempt * 4))
        done
        grep -q . "$f.tmp" || echo "__CLI_FAILED__" >> "$f.tmp"
        mv "$f.tmp" "$f"          # make it visible only once fully written
      ) &
      while [ "$(jobs -rp | wc -l)" -ge 8 ]; do wait -n; done
    done
  done
done 3< "$HERE/prompts.tsv"

wait
echo "done: $(ls "$OUT"/*.txt 2>/dev/null | wc -l) 件"
