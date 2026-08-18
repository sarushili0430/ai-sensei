# UI一覧

いま動いているUIを1枚ずつ並べたHTML(`index.html`)と、その材料(`screens/`)。

- **`index.html`** … 一覧。隣の `screens/` を参照するので、この2つを一緒に開く
- **`screens/*.png`** … 実画面から焼いたスクリーンショット(論理 393×852 を×2)
- **`screens/manifest.json`** … 並び順・ルート・実装ファイル・その状態を撮った理由

## 焼き直す

```bash
cd apps/mobile
fvm flutter test tool/generate_ui_overview.dart   # PNGとmanifestを撮り直す
cd ../..
pnpm run ui:overview                              # index.html を組み立て直す
```

HTMLだけを誰かに渡したいときは、画像を埋め込んだ1枚を別に書き出します
(**コミットはしない。**焼き直すたびに数MBの差分が積み上がるため)。

```bash
node --experimental-strip-types scripts/build-ui-overview.ts --embed --out /tmp/ui.html
```

撮る状態(どの画面を、どんなデータで撮るか)は
[`apps/mobile/tool/generate_ui_overview.dart`](../../apps/mobile/tool/generate_ui_overview.dart)
に並んでいます。画面や状態を足したら、まずここに1つ足してください。

## 3つのスクリーンショットの使い分け

同じ「実画面を焼く」仕組みが3つあります。混ぜないでください。

| どこ | 何のため | サイズ |
| --- | --- | --- |
| `docs/ui/`(ここ) | **人が眺めて、いまのUIを把握する** | 1サイズだけ |
| `docs/store/` (`tool/generate_store_screenshots.dart`) | ストア掲載素材 | 端末ごとに複数 + 見出し付き |
| `apps/mobile/test/golden/` | 崩れ・約束の消失をCIで検知 | 1サイズ・差分比較 |

ここのPNGは**検知に使いません**(差分でCIを落とさない)。逆に golden は
人が眺める用途を持たないので、失敗・空・上限といった状態はここにだけ並べます。

## 撮影日について

一覧の「撮影」はPNGの更新時刻から取ります。HTMLを組み立て直しただけでは
日付は動きません(焼き直していないのに新しく見えると、いつ時点のUIかが嘘になるため)。
