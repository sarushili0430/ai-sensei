#!/usr/bin/env bash
# =============================================================================
# Run apps/mobile with --dart-define
# =============================================================================
#   tool/run.sh                                        debug + dart_defines/local.json
#   tool/run.sh --debug --dart_define=local            the same, stated explicitly
#   tool/run.sh --release --dart_define=prod
#   tool/run.sh --debug --dart_define=dart_defines/staging.json
#   tool/run.sh --debug --dart_define=API_BASE_URL=http://192.168.1.10:8787
#   tool/run.sh --debug --dart_define=local -d "iPhone 15"
#
# --dart_define / --dart-define / --dart-define-from-file all mean the same
# thing (so any habit works). The value's shape decides the behaviour:
#
#   KEY=VALUE      -> passed straight through as --dart-define=KEY=VALUE
#   anything else  -> resolved as a file and passed to --dart-define-from-file
#                     (local -> dart_defines/local.json)
#
# It can be repeated. Flutter prefers the last one, so
#   --dart_define=local --dart_define=API_BASE_URL=http://192.168.1.10:8787
# reads the file and then overrides only API_BASE_URL.
#
# Unknown options are passed straight to flutter run (-d, --flavor, and so on).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

mode="debug"
use_fvm="auto"
defines=()      # --dart-define flags passed to flutter
explicit=0      # whether any --dart_define was given
passthrough=()  # the rest, passed straight to flutter run

die() {
  echo "$@" >&2
  exit 1
}

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# List the available define files (for error messages).
list_define_files() {
  # shellcheck disable=SC2012
  ls dart_defines/*.json dart_defines/*.env dart_defines.json dart_defines.env 2>/dev/null |
    grep -v '\.example\.' |
    sed 's/^/  /'
}

# Resolve the given string to a file path; returns 1 if not found.
resolve_define_file() {
  raw="$1"
  for candidate in \
    "$raw" \
    "$raw.json" \
    "dart_defines/$raw" \
    "dart_defines/$raw.json" \
    "dart_defines/$raw.env"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Flutter fails unhelpfully on malformed JSON, so check it here first. Nested
# objects and arrays cannot be expressed by --dart-define, so reject those too.
validate_define_file() {
  file="$1"
  case "$file" in
    *.json) ;;
    *) return 0 ;;
  esac
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$file" <<'PY'
import json, sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError as e:
    sys.exit("%s が JSON として読めない: %s (%d行目)" % (path, e.msg, e.lineno))
except OSError as e:
    sys.exit("%s が読めない: %s" % (path, e))

if not isinstance(data, dict):
    sys.exit("%s: トップレベルは {\"KEY\": \"VALUE\"} のオブジェクトでないといけない" % path)

nested = [k for k, v in data.items() if isinstance(v, (dict, list))]
if nested:
    sys.exit(
        "%s: --dart-define に渡せるのは文字列・数値・真偽値だけ。"
        "入れ子になっているキー: %s" % (path, ", ".join(sorted(nested)))
    )

if not data:
    print("警告: %s は空。--dart-define は1つも渡らない。" % path, file=sys.stderr)
PY
}

add_define() {
  value="$1"
  explicit=1
  case "$value" in
    "")
      die "--dart_define= の値が空。ファイル名(例 local)か KEY=VALUE を渡すこと。"
      ;;
    *=*)
      # KEY=VALUE: pass it straight through.
      defines+=("--dart-define=$value")
      ;;
    *)
      if ! file="$(resolve_define_file "$value")"; then
        {
          echo "--dart_define=$value を解決できない。"
          echo "次のどれかを渡すこと:"
          echo "  - dart_defines/ 配下の名前 (例: --dart_define=local)"
          echo "  - ファイルパス            (例: --dart_define=dart_defines/prod.json)"
          echo "  - 単発の値                (例: --dart_define=API_BASE_URL=http://localhost:8787)"
          echo
          echo "いま置いてある定義ファイル:"
          found="$(list_define_files || true)"
          if [ -n "$found" ]; then
            echo "$found"
          else
            echo "  (なし) — cp dart_defines/local.example.json dart_defines/local.json"
          fi
        } >&2
        exit 1
      fi
      validate_define_file "$file"
      defines+=("--dart-define-from-file=$file")
      ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --debug | --profile | --release)
      mode="${1#--}"
      ;;
    --dart_define=* | --dart-define=* | --dart-define-from-file=* | --dart_define_from_file=*)
      add_define "${1#*=}"
      ;;
    --dart_define | --dart-define | --dart-define-from-file | --dart_define_from_file)
      [ $# -ge 2 ] || die "$1 に値がない。"
      add_define "$2"
      shift
      ;;
    --no-fvm)
      use_fvm="no"
      ;;
    -h | --help)
      usage
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        passthrough+=("$1")
        shift
      done
      break
      ;;
    *)
      passthrough+=("$1")
      ;;
  esac
  shift
done

# Default when no --dart_define was given. Launching with nothing passed would
# silently run with API_BASE_URL at localhost and an empty ONESIGNAL_APP_ID (so
# notifications are disabled). Fail up front rather than debugging it later.
if [ "$explicit" -eq 0 ]; then
  if default_file="$(resolve_define_file local)"; then
    validate_define_file "$default_file"
    defines+=("--dart-define-from-file=$default_file")
  else
    {
      echo "dart-define の定義ファイルが無い。まずこれ:"
      echo "  cp dart_defines/local.example.json dart_defines/local.json"
      echo
      echo "意図して何も渡さずに起動するなら --dart_define=API_BASE_URL=... を明示すること。"
      echo "各キーの意味は dart_defines/README.md。"
    } >&2
    exit 1
  fi
fi

# Use fvm's SDK when it is present and pinned (.fvmrc is authoritative).
if [ "$use_fvm" = "auto" ]; then
  if command -v fvm >/dev/null 2>&1 && [ -f .fvmrc ]; then
    use_fvm="yes"
  else
    use_fvm="no"
  fi
fi

cmd=(flutter)
[ "$use_fvm" = "yes" ] && cmd=(fvm flutter)

cmd+=(run "--$mode")
cmd+=(${defines[@]+"${defines[@]}"})
cmd+=(${passthrough[@]+"${passthrough[@]}"})

# Without knowing what was launched, a wrong value cannot be traced.
printf '==> %s\n' "${cmd[*]}"
exec "${cmd[@]}"
