# golden test

主要画面のスクリーンショット比較。**見た目の崩れ**よりも、
設計上の約束が画面から消えていないかを見るために置いています。

## 生成は CI(Linux)を正とします

フォントのラスタライズはOSで変わるので、**macOSで生成したものをコミットすると
CIとの差分が永久に消えません。** 手元で焼いたPNGはコミットしないでください。

手元で走らせてよいのは、**差分を見るため**だけです:

```bash
cd apps/mobile
fvm flutter test --tags golden          # 落ちた差分は failures/ に出る
fvm flutter test --update-goldens --tags golden   # 手元で見るだけ。コミットしない
```

## CIで焼き直す手順

1. GitHub の **Actions → Update goldens → Run workflow** で、対象のブランチを選んで起動
2. 実行ログの **Show which goldens changed** で、どのPNGが書き換わったかを見る
3. artifact **`goldens`** を落とす
4. 中身を `apps/mobile/test/golden/goldens/` に**そのまま置く**
5. **1枚ずつ目で見る**(下記)
6. テストファイルと**同じコミット**に入れる(下記)

ワークフローの実体は [`docs/ci/golden.yml`](../../../../docs/ci/golden.yml) です
(`.github/workflows/` へのコピー手順は [`docs/ci/README.md`](../../../../docs/ci/README.md))。

### 焼き直すと「全部」書き換わります

`--update-goldens` は golden タグの付いたテストを**すべて**焼き直すので、
板書だけを直したつもりでも、画面側のPNGが一緒に更新されることがあります。
それ自体は正しい(基準が1つに揃う)のですが、**artifact に入ってくる枚数は
自分がいじった数より多い**前提で受け取ってください。

### 目で見る工程は飛ばせません

**`--update-goldens` は「いま描けたもの」を無条件に正として書き込みます。**
壊れた画面を焼けば、壊れた画面が「正」になり、以降その壊れは検知されません。
golden test が守れるのは**人が一度目で見て承認したもの**だけです。

置いたあとに `fvm flutter test --tags golden` を走らせても、
それは「さっき焼いたものと同じか」を見ているだけで、**正しさの確認にはなりません。**

### PNGとテストファイルは同じコミットに入れる

`matchesGoldenFile` は比較対象のPNGが**無いとき**、pixel diff ではなく
「ファイルが見つからない」で落ちます。テストファイルだけ先にコミットすると、
**PNGが入るまでCIが赤いまま**になります(ピボット計画 v1 §10-8)。

golden の実効ゲートは GitHub Actions だけです。Codemagic は macOS なので
`--exclude-tags golden` で外しています(`codemagic.yaml`)。
つまりここが赤いと、**気づく場所が他にありません。**

## 落ちたとき

`test/golden/failures/` に差分画像が出ます(`*_masterImage.png` /
`*_testImage.png` / `*_isolatedDiff.png`)。CIでは失敗時にartifactとして
上がるので、そこから落とせます。

まず**自分の変更が意図したものか**を見てください。意図したものなら、上の手順で焼き直します。
意図しない差分なら、焼き直すのではなくコードを直します。

## フォント

`assets/fonts/ZenMaruGothic-*.ttf`(SIL OFL 1.1)を `loadAppFonts()` で
読み込んでから描画します。読み込まないとAhem(四角)で描画され、
字形の崩れに気づけません。

### 板書(数式)を焼くときの注意

`loadAppFonts()` は `FontManifest.json` の family 名から `packages/xxx/` プレフィックスを
**剥がして**登録します(アプリ自身の `ZenMaruGothic` はプレフィックス無しなのでこれで正しい)。
一方 `flutter_math_fork` は自分のフォントを `'packages/flutter_math_fork/KaTeX_Main'` という
**プレフィックス込みの名前**で参照します。

そのまま流用すると、数式が**黒塗りの四角(tofu)で描画**されます。気づかずにこれを
golden として焼くと、**テストは通るのに実際は文字化けしている**という、
検知能力のない golden ができあがります(ピボット計画 v1 §3-6c)。

板書の golden を焼く前に、`loadAppFonts()` がプレフィックスを保持する形になっているか、
または板書専用のフォントローダーを使っているかを確かめてください。
