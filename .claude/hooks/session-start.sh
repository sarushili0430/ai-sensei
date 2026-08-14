#!/bin/bash
# Runs when a Claude Code on the web (Environments) session starts.
#
# It has one purpose: leave lint and tests passing by the time the session begins.
# Without it, the first thing the agent does is install dependencies, burning the
# same few minutes every time.
#
# It does not run locally (CLAUDE_CODE_REMOTE limits it to remote).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

echo "==> pnpm workspace (backend/* + packages/*)"
corepack enable >/dev/null 2>&1 || true
# --frozen-lockfile is deliberately absent. A drifted lockfile should not stop the
# run; the agent should be able to fix it.
pnpm install

# ---------------------------------------------------------------------------
# Flutter SDK
#
# apps/mobile/.fvmrc (the same file fvm uses) is authoritative for the version.
# fvm itself is not installed: one SDK is enough in the remote environment, and
# going through fvm would duplicate where downloads live.
# ---------------------------------------------------------------------------
# .fvmrc does not end in .json, so require cannot read it (it would be parsed as JS)
FLUTTER_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('apps/mobile/.fvmrc','utf8')).flutter)")"
FLUTTER_DIR="$HOME/flutter"

if [ ! -x "$FLUTTER_DIR/bin/flutter" ]; then
  echo "==> Flutter ${FLUTTER_VERSION} を取得"
  curl -fsSL -o /tmp/flutter.tar.xz \
    "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"
  tar xf /tmp/flutter.tar.xz -C "$HOME"
  rm -f /tmp/flutter.tar.xz
else
  echo "==> Flutter は取得済み ($FLUTTER_DIR)"
fi

# The container runs as root, so register the SDK's git repository as a safe
# directory. Without it every flutter command fails with "dubious ownership".
git config --global --add safe.directory "$FLUTTER_DIR" || true

export PATH="$FLUTTER_DIR/bin:$PATH"
echo "export PATH=\"$FLUTTER_DIR/bin:\$PATH\"" >> "${CLAUDE_ENV_FILE:-/dev/null}"

INSTALLED="$(flutter --version --machine 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).frameworkVersion" 2>/dev/null || echo unknown)"
if [ "$INSTALLED" != "$FLUTTER_VERSION" ]; then
  echo "!! .fvmrc は ${FLUTTER_VERSION} ですが、入っているのは ${INSTALLED} です"
fi

echo "==> apps/mobile の依存とコード生成"
cd apps/mobile
flutter pub get
# Generated files (*.freezed.dart / *.g.dart) are not committed, so build them here.
# Without them neither flutter analyze nor flutter test passes.
dart run build_runner build

echo "==> 準備完了"
