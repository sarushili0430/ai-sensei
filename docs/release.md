# リリース手順書 — 一般公開までにやること(2026-09-05 時点)

[`deploy.md`](deploy.md)(API)・[`deploy-agent.md`](deploy-agent.md)(agent)・
[`ci/store-setup.md`](ci/store-setup.md)(ストア)・[`ci/codemagic.md`](ci/codemagic.md)(配布)は
**それぞれの部品の手順書**。この文書はそれらを**公開日に向けて順番どおりに並べたもの**で、
「いま何が済んでいて、何が残っているか」を1か所で持つ。済んだら `[x]` にしていく。

料金は [`business/pricing_v1.md`](business/pricing_v1.md)、ストアに貼る文面は
[`store/app_store_listing.md`](store/app_store_listing.md)(日英)。

---

## 0. 現在地(2026-09-05 に確認した事実)

| 部品 | 状態 |
| --- | --- |
| `backend/api` develop | 稼働中。`https://ai-sensei-api-develop.kouyuu6.workers.dev`(RevenueCat の webhook がここを向いている) |
| `backend/api` production | Cloudflare のリソース(D1 / KV / R2)は作成済みで `wrangler.toml` に ID が入っている(`pnpm run verify:bindings production` ✔)。**ワーカー本体はまだ一度も出ていない**(`main` が空のため。下記) |
| `main` ブランチ | **`develop` と共通の祖先を持たない孤児ブランチ**(2026-08-03 の3コミット、中身は設計資料2ファイル)。`deploy.yml` / `deploy-agent.yml` は `main` への push で production を出す設計なので、**`main` を `develop` で置き換える**のが最初の一手(§2) |
| `.github/workflows/` | `ci.yml` / `golden.yml` / `deploy.yml` は置いてある。**`deploy-agent.yml` は未設置**(テンプレートは `docs/ci/`。GitHub App からは置けないので手元でコピー) |
| `backend/agent` production | LiveKit の本番プロジェクト・`lk agent create` とも未実施(`deploy-agent.md` の「まだやっていないこと」のまま) |
| RevenueCat | App Store の3商品 `jp.co.aisensei.premium.{weekly,monthly,yearly}` は登録済み。**Offering `default` の3パッケージへの紐づけは 2026-09-05 に済ませた**。**Entitlement `premium` への紐づけは未了**(API キーに `entitlements:read_write` が無く弾かれた。ダッシュボードで要作業 §5)。webhook は develop 向けの1本だけ。Play Store のアプリは登録済みだが商品ゼロ |
| App Store Connect | アプリレコード・3商品(READY_TO_SUBMIT)。**2026-09-05 に RevenueCat 経由で反映済み**: 価格(日本 週¥980 / 月¥2,980 / 年¥29,800、米国 $6.99 / $19.99 / $199.99)と、3商品の審査メモ(新しい導線・料金・日英)。**API が拒否して未反映**: 商品の表示名・説明の差し替え(旧説明は「セッション無制限」のまま)、英語(en-US)ロケールの追加、サブスクリプショングループ名の `かたるて` → `カタルテ`(§5 で手作業)。掲載文(説明・キーワード等)は未入力 |
| Codemagic | `ios-testflight`(develop への push で TestFlight)と `android-internal`(`v*` タグ)が組んである。`submit_to_app_store: false`。変数グループ `mobile-dart-defines` の `API_BASE_URL` が **どちらを向いているかは要確認**(§6) |
| LP(`https://ubiqy.jp/`) | `apps/lp` をそのまま配信したもの。規約・ポリシー・サポートは日英そろったが、**運営者名・所在地・管轄裁判所・制定日・返信の目安が `fill` のまま**で `noindex` |
| アプリ | `pubspec.yaml` を `1.0.0+1` に上げた。ビルド番号は Codemagic の連番 |
| β開放 | `wrangler.toml` の **production から `BETA_OPEN_ACCESS_UNTIL` / `BETA_SECONDS_PER_DAY` を外した**(develop には残る)。production を出した瞬間から課金導線が生きる |

---

## 1. コード側(このブランチで済ませたもの)

- [x] `backend/api/wrangler.toml`: production から β開放の2変数を削除(develop は 2026-12-01 まで残す)
- [x] `apps/mobile/pubspec.yaml`: `1.0.0+1`
- [x] iPad 13インチのストアスクショ(`docs/store/screenshots/{ja,en}/ipad-13/` 2064×2752)。
      あわせて全スクショを現行UIで焼き直し、ADR 0009 で消えたカルテ画面(`03-karte.png`)を
      復習問題の画面(`03-practice.png`)に差し替えた
- [x] LP の規約・ポリシー・サポートを実装に合わせて修正し、英語版(`/en/terms/` `/en/privacy/` `/en/support/`)を追加
- [x] 料金メモ(`business/pricing_v1.md`)と、ストア掲載文の正本(`store/app_store_listing.md`)
- [ ] **`PREMIUM_SESSION_MAX_SECONDS`**: 1回の授業は20分で締まる(`FREE/PREMIUM_SESSION_MAX_SECONDS = 1200`)。
      「1回の授業に上限は無い」つもりなら、production/develop の両方で `3600` にする(1行)。
      2026-09-05 の判断は据え置き

---

## 2. `main` を `develop` から切る(production の API が出る)

`main` の中身は古い設計資料2ファイルだけで、`develop` と歴史がつながっていない。
**マージではなく置き換える**(リポジトリのオーナーが手元で):

```bash
git fetch origin develop main
git checkout develop && git pull --ff-only
git log --oneline -1 origin/main          # 2e51af5 initial commit のはず
# main を develop の先端で置き換える。--force-with-lease は「main が 2e51af5 のときだけ」の安全弁
git push origin develop:main --force-with-lease=main:2e51af5
```

push した瞬間に `deploy.yml` が production を出しにいく。**その前に §3 の secret を入れておくこと**
(入れずに出すと、ワーカーは起動するが `session_created` の手前で `LIVEKIT_URL` 不在で落ちる)。
先に secret だけ入れたければ、ワーカーの箱は `wrangler secret put` の初回に作られる(`deploy.md` §2)。

- [ ] GitHub > Settings > Environments に `production` を作り、`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を置く
      (リポジトリ共通の Secrets に既にあるなら不要)。**Required reviewers に自分を入れる**と、`main` への push で
      デプロイが一旦止まって承認制になる(`deploy.md` §4-3)
- [ ] `main` にブランチ保護(force push 禁止・PR 必須)を入れる。上の置き換えは保護を入れる**前**にやる
- [ ] 以後の流れ: 機能は `develop` に集めて、リリースのたびに `develop` → `main` の PR を出す(通常のマージでよい。孤児なのは今回だけ)

---

## 3. production の secret(`backend/api`)

```bash
cd backend/api
for name in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET \
            ANTHROPIC_API_KEY ONESIGNAL_APP_ID ONESIGNAL_REST_API_KEY \
            REVENUECAT_WEBHOOK_AUTH INTERNAL_API_TOKEN SENTRY_DSN; do
  pnpm exec wrangler secret put "$name" --env production
done
```

- [ ] `LIVEKIT_*` は **本番用の LiveKit プロジェクト**のもの(develop と共有しない。`deploy.md` §6)
- [ ] `INTERNAL_API_TOKEN` は develop と**別の値**。agent 側(§4)と同じ値
- [ ] `REVENUECAT_WEBHOOK_AUTH` は develop と別の値。RevenueCat の production webhook(§5)の Authorization ヘッダに同じ値
- [ ] `ONESIGNAL_APP_ID` はアプリの `--dart-define` と同じ値(`47044c5e-15eb-49ec-bdd4-e0ed2219a799`)
- [ ] `LIVEKIT_AGENT_NAME`: LiveKit Cloud のホスティングに載せると名前つきになるので、§4 で名前が判ってから入れる
      (入れないと「部屋はできるのに先輩が来ない」)

デプロイ後の確認:

```bash
curl https://ai-sensei-api-production.kouyuu6.workers.dev/health
# {"ok":true,"environment":"production"}
pnpm --filter @ai-sensei/api tail:production
```

---

## 4. agent を production に出す(`backend/agent`)

`deploy-agent.md` §2 のとおり。**初回は手元の `lk` から**。

- [ ] LiveKit Cloud に本番プロジェクトを作る(develop とは別)
- [ ] secrets ファイル(リポジトリの外)を production の値で用意: `API_BASE_URL=https://ai-sensei-api-production.kouyuu6.workers.dev`、
      `INTERNAL_API_TOKEN`(§3 と同じ)、`ANTHROPIC_API_KEY`、`DEEPGRAM_API_KEY`、`GOOGLE_API_KEY`、
      `GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview`(確定構成。既定は 2.5 なので**明示する**)、
      `SENTRY_DSN`、`ENVIRONMENT=production`。`LIVEKIT_*` はホスティングが注入するので入れない
- [ ] リポジトリのルートで `lk agent create --secrets-file <file> --skip-sdk-check`(手元の `docker build .` が通ることを先に確認)
- [ ] `lk agent status --id <id>` で名前とレプリカを確認 → その名前を §3 の `LIVEKIT_AGENT_NAME` に入れて API を再デプロイ
      (Actions > Deploy (backend/api) > Run workflow > production)
- [ ] `docs/ci/deploy-agent.yml` を `.github/workflows/` にコピーして commit(オーナーの手元から)。
      Environments の `production` に `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`(Secret)と `LIVEKIT_AGENT_ID`(Variable)
- [ ] `livekit.toml` は commit しない(develop 用の ID が `main` に乗ると本番を上書きする)

順番の約束: **今後 metadata の契約を変えるリリースは agent が先、API があと**(`deploy.md` §3)。
初回は両方とも新規なのでどちらが先でもよいが、**API の `LIVEKIT_AGENT_NAME` が agent の名前と一致してから**が公開。

---

## 5. RevenueCat と App Store Connect の課金まわり

- [ ] **Entitlement `premium` に App Store の3商品を紐づける**(ダッシュボード > Entitlements > premium > Attach)。
      `jp.co.aisensei.premium.weekly` / `.monthly` / `.yearly`。**これが無いと「課金は成立するのに何も解放されない」**。
      いまは Test Store の3商品しか付いていない(API 権限の都合で 2026-09-05 にはできなかった)
- [ ] Entitlement の表示名を `かたるて Pro` → `カタルテ Premium` に(表示だけ。任意)
- [ ] production の webhook を足す: 名前 `cloudflare-production`、URL `https://ai-sensei-api-production.kouyuu6.workers.dev/v1/webhooks/revenuecat`、
      Authorization ヘッダ = §3 の `REVENUECAT_WEBHOOK_AUTH`。develop の `cloudflare-dev` は残してよい(sandbox のイベントは develop の D1 へ)
- [ ] Restore Behavior が「Transfer to new App User ID」か確認(`revenuecat.md` §5)
- [ ] App Store Connect > 収益化 > サブスクリプション > 各商品で**手で直すもの**(API では Apple が
      「NAME / LOCALE_CODE は変更不可」と返して通らなかった): ① 日本語の説明を
      「セッション無制限と穴の復習。…」から `app_store_listing.md` §7 の文へ差し替え(**無制限は嘘になる**)、
      ② 英語(en-US)のローカリゼーションを追加(表示名・説明は同 §7)、
      ③ サブスクリプショングループの表示名 `かたるて Premium` → `カタルテ Premium`(英語 `Katarute Premium`)。
      価格と審査メモは反映済みなので触らない。④ 審査用スクリーンショットを
      `docs/store/iap-review/paywall-ja.png`(現行UI・確定価格)に差し替える(古い1枚を消してから上げる。
      API では既存の1枚がある商品に新しい枠を取れなかった)
- [ ] 3商品の**「販売準備完了」までの残り**は、アプリの最初のバージョンと一緒に審査へ出すこと
      (状態 READY_TO_SUBMIT = 提出待ち)。
      **販売地域が日本と米国だけ**(`available_in_new_territories: false`)。アプリ本体を全地域で出すなら、
      IAP も全地域にする(収益化 > サブスクリプション > 販売地域)。日本以外の価格は Apple の自動換算のまま
      (いまは旧価格からの換算値が残っているので、地域を広げるなら日本を基準に「価格を均等化」し直す)
- [ ] **Small Business Program** に申し込む(手数料 30% → 15%。`pricing_v1.md` の手取りはこれ前提)
- [ ] Codemagic の `mobile-dart-defines` に `REVENUECAT_IOS_PUBLIC_SDK_KEY`(`appl_...`)。無いと Test Store の鍵に落ちて**実売にならない**
- [ ] Test Store の3商品にも日本円の参考価格を入れた(2026-09-05。鍵の無いビルドの表示用)
- [ ] Google Play: 定期購入3プランを同額で作り、RevenueCat の Play アプリに商品登録 → `premium` に紐づけ → `REVENUECAT_ANDROID_PUBLIC_SDK_KEY`(Android は後追い)

---

## 6. Codemagic と TestFlight

- [ ] 変数グループ `mobile-dart-defines`: `API_BASE_URL` = **production のワーカーURL**、
      `REVENUECAT_IOS_PUBLIC_SDK_KEY`、`ONESIGNAL_APP_ID`、`SENTRY_DSN`、
      `PRIVACY_POLICY_URL=https://ubiqy.jp/privacy/`、`TERMS_URL=https://ubiqy.jp/terms/`、
      `SUPPORT_EMAIL=kfukejob@gmail.com`(空だと「設定 > 気になった内容を報告する」の行ごと消える)
- [ ] `develop` へ push → TestFlight に 1.0.0 (build N) が上がる → **production の API に対して**1周(撮影 → 授業 → わかった → 3日後の通知 → 回答)
      と、Sandbox での購入・復元・解約を通す
- [ ] 審査に出すビルドは、App Store Connect > アプリ > 1.0 の「ビルド」でそのビルドを選ぶ(`submit_to_app_store` は false のまま。提出は手で)

---

## 7. App Store Connect の掲載情報

すべて [`store/app_store_listing.md`](store/app_store_listing.md) からコピペ(日本語・英語)。

- [ ] 名前・サブタイトル・カテゴリ・年齢・著作権(**権利者名が未決**)
- [ ] プロモーションテキスト / 説明 / キーワード / 新機能(日英)
- [ ] スクリーンショット: 6.9インチ = `screenshots/{ja,en}/captioned/`、6.5インチ = `screenshots/{ja,en}/captioned-65/`、
      iPad 13インチ = `screenshots/{ja,en}/ipad-13/`(各5枚)。**タブと寸法を取り違えると "Screenshots dimensions should be ..." で弾かれる**
- [ ] サポートURL: 日本語 `https://ubiqy.jp/support/`、英語 `https://ubiqy.jp/en/support/`。
      マーケティングURL: `https://ubiqy.jp/`(英語 `https://ubiqy.jp/en/`)。プライバシーポリシーURL: `https://ubiqy.jp/privacy/`(英語 `https://ubiqy.jp/en/privacy/`)
- [ ] App のプライバシー: `store-setup.md` 1-7 の表 + **写真と文字起こしの用途に「分析」を足す**
      (ポリシー第4条に改善のための利用を書いたため)
- [ ] 審査メモ: **審査用サンプルノート画像のURL**(未決。`docs/store/` に置いて raw URL でも、LP の `public/` に置いてもよい)と、
      Sandbox での購入手順。AI生成の安全策(許可リスト・報告導線)
- [ ] 年齢制限のアンケート(4+ で申告。押し戻されたら 12+)

---

## 8. LP(`apps/lp`)

- [ ] 規約・ポリシー・サポート(日英6ページ)の `fill` を埋める: **運営者名・所在地・管轄裁判所・制定日・返信の目安**。
      埋めたら各ページ冒頭の `.legal-draft` ブロックと `<meta name="robots" content="noindex">` を消す
- [ ] `hreflang` と `og:url` を絶対URL(`https://ubiqy.jp/...`)に
- [ ] `pnpm --filter @ai-sensei/lp build:check` でアップロード対象の枚数を見てから `deploy:production`
- [ ] `https://ubiqy.jp/en/terms/` `https://ubiqy.jp/en/privacy/` `https://ubiqy.jp/en/support/` が開くことを確認
      (App Store Connect の英語ロケールに入れるURL)
- [ ] 配信開始後: ヒーローと締めの CTA をストアバッジに(`apps/lp/README.md`「公開前に埋めるもの」)

---

## 9. 公開当日のチェック

- [ ] `GET /health` が `production` を名乗る
- [ ] agent: `lk agent status` が Running、`GET :8081/` 相当のヘルスが 200
- [ ] RevenueCat > Webhooks > `cloudflare-production` にテストイベントを送って 200
- [ ] TestFlight ビルド(production 向け)で: 撮影 → 授業 → 「わかった」→ 祝福 → ペイウォール → Sandbox 購入 → `PremiumChip` が出る → 復元 → 解約
- [ ] 通知: 3日後を待たずに確認するなら OneSignal のダッシュボードから手動送信で端末に届くこと
- [ ] Sentry に production の環境名でイベントが入ること(`ENVIRONMENT=production`)
- [ ] 審査通過 → 「手動でリリース」を押す → LP の CTA を差し替え → `docs/store/play_listing.md` の Play 側へ

---

## 10. 決まっていないこと(誰かが決めないと進まない)

| 項目 | 選択肢 | 書く場所 |
| --- | --- | --- |
| 運営者名・所在地・管轄裁判所 | 個人名か法人か。所在地は私書箱でも可だが空欄は不可 | LP 6ページの `fill`、App Store の著作権表記 |
| 審査用サンプルノート画像 | 実物のノート写真を2〜3枚(数学I の判別式・英語の文法で1枚ずつ) | 審査メモの `<SAMPLE_NOTES_URL>` |
| IAP の販売地域 | 日本+米国のまま / 全地域 | App Store Connect |
| 1回の授業の上限 | 20分のまま / 日次残高いっぱい(`PREMIUM_SESSION_MAX_SECONDS=3600`) | `wrangler.toml` |
| 無料の1日の持ち時間 | 20分のまま / 15分 / 10分(`pricing_v1.md` §3) | `wrangler.toml` の `FREE_SECONDS_PER_DAY` |
