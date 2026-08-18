# backend/agent(LiveKit Agents)を常駐させるためのイメージ。
#
#   docker build -t ai-sensei-agent:local .
#   pnpm --filter @ai-sensei/agent run docker:build     # 同じことをする
#
# **中身は backend/agent なのに、なぜルートに置いてあるのか。** 理由は2つあって、
# どちらも動かせない:
#
# 1. agentは packages/* を `workspace:*` で参照している。ビルドコンテキストが
#    リポジトリのルートでないと、そもそもインストールが解けない。
# 2. `lk agent create/deploy` は**作業ディレクトリをそのままビルドコンテキストにし、
#    その直下の `Dockerfile` を読む**。パスを指定するフラグは無い。つまり
#    LiveKit Cloud に載せるには、ここに `Dockerfile` が要る。
#
# 焼いたイメージを渡す道(`--image`)は Enterprise プラン限定なので使えない。
# 手順と稼働先は docs/deploy-agent.md。
#
# `# syntax=` は**あえて付けていない**。付けると外部のフロントエンドイメージを
# 取りに行くので、LiveKit のビルドサービスのように手元でないところで焼くときに
# 余計な依存になる。ここで使っている命令は素のビルダーで足りる。

# Node 22 は package.json の engines(>=22.6)と CI に合わせている。
# **slimを使う(alpineにしない)。** onnxruntime-node と @livekit/local-inference は
# glibc向けのネイティブバイナリしか配っていないので、muslのalpineでは起動時に落ちる。
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base

# LiveKitのネイティブコア(Rust)は**システムのCA束を実行時に読む**。slimには入って
# いないので、入れないとLiveKitへのTLS接続がその場で失敗する(ローカルでは
# ホストの証明書で通っていたぶん、コンテナにして初めて出る壊れ方)。
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpmのバージョンは package.json の packageManager が正。corepackに解決させる。
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    HOME="/app"
RUN corepack enable

WORKDIR /app


# --- 依存を解決する ----------------------------------------------------------
FROM base AS deps

# 先にマニフェストとロックだけ置く(ソースを1行直しただけで再インストールしない)。
# **ワークスペースの全マニフェストが要る。** イメージに入らない backend/api も置くのは
# そのため。
#
# **欠けても、ここでは落ちない。それがいちばん危ないところ。**
# マニフェストの無いパッケージは pnpm から見て「ワークスペースに存在しない」ので、
# `--frozen-lockfile` はロックのずれとして検知しない。依存側には
# `workspace:*` のシンボリックリンクだけが張られ、**そのパッケージ自身の依存
# (`packages/figure` なら zod)は1つも入らない**。あとから `COPY packages/` で
# ソースだけが入るので、イメージは焼けるし LiveKit への登録も通る。
# 壊れるのはジョブの子プロセスを起こす瞬間で、
# `Cannot find package 'zod' imported from /app/packages/figure/src/schema.ts` を
# 出して即死し、**アプリからは「先輩が来ない」としか見えない**
# (実際に2026-08-12〜08-14のdevelopがこの形で止まっていた)。
# packages/ を1つ足したら、**この一覧にも足すこと**。忘れても下の
# 「起動できるかを焼き込み時に確かめる」でビルドが落ちる。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/agent/package.json       backend/agent/
COPY backend/api/package.json         backend/api/
COPY packages/contract/package.json   packages/contract/
COPY packages/curriculum/package.json packages/curriculum/
COPY packages/figure/package.json     packages/figure/
COPY packages/guardrail/package.json  packages/guardrail/
COPY packages/prompts/package.json    packages/prompts/

# onnxruntime-node の postinstall は、既定で**CUDA/TensorRTのEPを302MB取りに行く**。
# Silero VADはCPUで回すので1バイトも使わない。CPU実行に要る libonnxruntime.so と
# onnxruntime_binding.node はnpmパッケージに同梱されているため、skipして問題ない。
# GPUで回したくなったらこの行を外す(イメージが+300MBになる)。
ENV ONNXRUNTIME_NODE_INSTALL=skip

# `@ai-sensei/agent...` は「agentとその依存」。ルートのdevDependencies
# (biome / vitest / typescript / lefthook)も backend/api もここには入らない。
RUN pnpm install --frozen-lockfile --prod --filter @ai-sensei/agent...

# プラグインが要るモデルファイルを**イメージに焼く**。実行時に取りに行かせると、
# 最初のジョブが遅れるうえ、外へ出られない環境では起動しない。
# いまは Silero VAD の .onnx がパッケージに同梱されているので実質no-opだが、
# ターンディテクタなど後から足すプラグインはここで落ちてくる。
RUN pnpm --filter @ai-sensei/agent run download-files


# --- 実行イメージ ------------------------------------------------------------
FROM base AS runtime

ARG UID=10001
RUN adduser --disabled-password --gecos "" --home /app --shell /sbin/nologin --uid ${UID} agent \
  && chown agent:agent /app

COPY --from=deps --chown=agent:agent /app /app

# ソースは最後に置く。ここだけ変わったときは上のインストール層を使い回せる。
# prompts/*.md は packages/prompts/src/generated.ts に取り込み済みなので要らない。
COPY --chown=agent:agent packages/      packages/
COPY --chown=agent:agent backend/agent/ backend/agent/

USER agent
ENV NODE_ENV=production

# **ジョブの入口を、焼き込み時に一度 import してみる。**
#
# LiveKit Agents は `agent.ts` を**別プロセス**で読む。そこで解決に失敗しても
# 親ワーカーは生き続け、LiveKitへの登録も 200 のままなので、
# ヘルスチェックも `lk agent status` も緑を返す。壊れたことが分かるのは
# 生徒がアプリで「先輩が来ない」に当たったときで、ログを見るまで
# 依存の取りこぼしだと気づけない(上の COPY の一覧がまさにそれで抜けた)。
#
# ここで落としておけば、同じ抜けは**デプロイ前にビルド失敗として**出る。
# 走るのは import までで、設定の読み込み(`loadConfig`)も接続も起きない。
RUN node --experimental-strip-types --input-type=module \
  -e "await import('/app/backend/agent/src/agent.ts')"

# productionモードのワーカーは 0.0.0.0:8081 にヘルスチェックを出す。
#   GET /       LiveKitに登録できていれば 200、できていなければ 503
#   GET /worker 稼働中のジョブ数などのJSON
# **503は「立ち上がっていない」ではなく「まだLiveKitに繋がっていない」。**
# ディスパッチが来ない調査のとき、ここが200かどうかが最初の分かれ道になる。
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/backend/agent

# **pnpm を挟まない。** SIGTERMが来るとワーカーはdrain(進行中の会話を終わらせてから
# 終了)する。間にプロセスを挟むとシグナルが素通りせず、話している最中に切れる。
# nodeをPID 1にして直接受ける。中身は package.json の "start" と同じ。
CMD ["node", "--experimental-strip-types", "src/index.ts", "start"]
