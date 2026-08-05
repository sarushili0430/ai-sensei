# =============================================================================
# ローカル開発用のNodeイメージ(backend/api と backend/agent で共用)
# =============================================================================
# **本番では使いません。** api は Cloudflare Workers に直接デプロイし、
# agent の稼働先は ADR 0002 のとおり保留です。このイメージの目的はひとつだけ:
#
#   母艦にNodeとpnpmを入れなくても、Linux版のnative依存で backend が動く状態を作る。
#
# ソースも node_modules も COPY しません。ソースは bind mount、node_modules は
# named volume です(docker-compose.yml)。母艦(macOS)の node_modules を
# そのまま持ち込むと、darwin版のnative依存(onnxruntime / sharp)を
# Linuxのコンテナが読もうとして落ちるためです。
#
# ビルドコンテキストがこのディレクトリ(docker/)なのも同じ理由で、
# リポジトリ全体をデーモンに送らないためです(apps/mobile/build が数GBある)。
# =============================================================================

# バージョンの下限は package.json の engines(>=22.6)と揃えてある。
# --experimental-strip-types(agent)と node --env-file がこの系列で要る。
FROM node:22-bookworm-slim

# libgomp1: Silero VAD が使う onnxruntime-node が要求するOpenMPランタイム。
#           入れないとVADのロードで .so が見つからず、会話が始まった瞬間に落ちる。
# ca-certificates: LiveKit / Anthropic / Deepgram / ElevenLabs へのTLS接続に要る。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

# pnpmのバージョンは固定しない。ルートの package.json の packageManager を
# corepack が読むので、母艦とコンテナで自動的に同じになる。
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 は、初回起動が「入れて良いか」の確認で
# 止まらないようにするため(コンテナには誰も答えられない)。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/pnpm-store
RUN corepack enable

WORKDIR /workspace
