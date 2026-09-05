#!/bin/bash
# Claude Code on the web(Environments)のセッション開始時に走る。
#
# 目的はひとつ: **セッションが始まった時点で lint とテストが通る状態にしておく**。
# ここが欠けると、エージェントが最初にやることが「依存を入れる」になり、
# 毎回同じ数分を溶かすことになる。
#
# 手元では走らせない(CLAUDE_CODE_REMOTE でリモートだけに限定)。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

echo "==> pnpm workspace (backend/* + packages/*)"
corepack enable >/dev/null 2>&1 || true
# --frozen-lockfile は付けない。lockfileがずれていても止めず、
# エージェントが直せる状態にしておきたい。
pnpm install

# ---------------------------------------------------------------------------
# Flutter SDK
#
# バージョンは apps/mobile/.fvmrc(fvmと同じファイル)を正とする。
# fvm 自体は入れない: リモート環境ではSDKが1つあれば足り、
# fvm経由にすると download 先が二重管理になるため。
# ---------------------------------------------------------------------------
# .fvmrc は拡張子が .json ではないので require では読めない(JSとして解釈される)
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

# コンテナはrootで動くので、SDKのgitリポジトリを安全なディレクトリとして登録する。
# これが無いと flutter コマンドが "dubious ownership" で全部落ちる。
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
# 生成物(*.freezed.dart / *.g.dart)はコミットしていないので、ここで作る。
# これが無いと flutter analyze も flutter test も通らない。
dart run build_runner build

echo "==> 準備完了"
