# golden test

主要画面のスクリーンショット比較。**見た目の崩れ**よりも、
設計上の約束が画面から消えていないかを見るために置いています。

## 生成

```bash
cd apps/mobile
fvm flutter test --update-goldens
```

**生成はCI(Linux)を正とします。** フォントのラスタライズはOSで変わるので、
macOSで生成したものをコミットすると、CIとの差分が永久に消えません。
手元で差分が出たときは、まず自分の変更が意図したものかを見て、
問題なければCIで生成し直してください。

## 落ちたとき

`test/golden/failures/` に差分画像が出ます(`*_masterImage.png` /
`*_testImage.png` / `*_isolatedDiff.png`)。CIでは失敗時にartifactとして
上がるので、そこから落とせます。

## フォント

`assets/fonts/ZenMaruGothic-*.ttf`(SIL OFL 1.1)を `loadAppFonts()` で
読み込んでから描画します。読み込まないとAhem(四角)で描画され、
字形の崩れに気づけません。
