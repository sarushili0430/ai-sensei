# dart_defines/

`--dart-define` に渡す値をまとめた **JSON** を置く場所。
Flutter の `--dart-define-from-file` はこのディレクトリの `*.json` をそのまま食べます。

```bash
cp dart_defines/local.example.json dart_defines/local.json
tool/run.sh --debug --dart_define=local
```

`tool/run.sh` を通さず素の Flutter で叩くなら同じことです:

```bash
fvm flutter run --debug --dart-define-from-file=dart_defines/local.json
```

`*.example.json` 以外の `.json` は **コミットされません**(ルートの `.gitignore`)。
環境を増やしたいときは `staging.json` / `prod.json` のように足してください。
`tool/run.sh --dart_define=staging` で拾えます。

## ここに入れてよいもの

**公開値だけです。** `--dart-define` の値はビルド成果物に埋め込まれ、
逆アセンブルで読めます。秘密鍵は1つも置かないでください
(サーバ側 = `backend/` に置くこと)。

JSON なのでコメントが書けません。各キーの意味は以下。

| キー | 意味 |
| --- | --- |
| `API_BASE_URL` | `backend/api` のURL。ローカルは `http://localhost:8787`。実機から母艦を見るなら母艦のLAN IP(例 `http://192.168.1.10:8787`)。空なら `http://localhost:8787` に落ちる |
| `REVENUECAT_IOS_PUBLIC_SDK_KEY` | RevenueCat のiOS用公開鍵(`appl_` で始まる)。ストアに商品を作ったあとの本番用 |
| `REVENUECAT_ANDROID_PUBLIC_SDK_KEY` | 同 Android用(`goog_` で始まる) |
| `REVENUECAT_SDK_KEY` | Test Store の鍵(`test_` で始まる)。App Store Connect / Play Console に商品を作る前でも購入フローを最後まで通せる、RevenueCat側の疑似ストア。**iOS/Androidで同じ値**を使う。上の2つが空のときだけ使われる |
| `REVENUECAT_ENTITLEMENT_ID` | ダッシュボードの Entitlement identifier(表示名ではないほう)。空なら `premium`。ここがずれると、課金は成立するのに何も解放されない |
| `REVENUECAT_OFFERING_ID` | 既定以外の Offering を出したいときだけ(価格の実験用)。空なら current |
| `ONESIGNAL_APP_ID` | プッシュ受信。App IDは公開値。`backend/api` の `ONESIGNAL_APP_ID` と**同じ値**にすること。アプリ側(`push_repository.dart` の `PushConfig`)は既定値を持たないので、**空のビルドでは通知機能ごと無効**(初期化も端末登録もしない)。REST API Key はサーバ側にあり、ここには置かない |
| `SENTRY_DSN` | クラッシュ監視。DSNは公開前提の値。初期化はまだ未実装(`README.md` の「未実装」) |
| `PRIVACY_POLICY_URL` | 設定画面から出るリンク。**ストア提出前に埋めること。** 空のあいだは設定画面に行ごと出ない(押しても開かない行を出さないため)。サブスクを載せる以上、審査で必ず見られる |
| `TERMS_URL` | 同上。自前のものが無ければ Apple の標準EULA (`https://www.apple.com/legal/internet-services/itunes/dev/stdeula/`) で構わない |
| `SUPPORT_EMAIL` | 後輩の質問がおかしかったときの報告先。AI生成コンテンツを含むアプリの導線として要る(handoff §5) |

値は文字列・数値・真偽値だけです(入れ子のオブジェクト/配列は Flutter が受け付けません。
`tool/run.sh` は渡す前にそこを見て落とします)。

## CI との関係

Codemagic はこのファイルを読みません。ビルドマシンの環境変数
(変数グループ `mobile-dart-defines`)を `codemagic.yaml` が `--dart-define=` に
展開しています。**キーを足したらそちらにも足すこと** —— 足し忘れると、
手元では動くのに配布ビルドだけ空、という差になります。
