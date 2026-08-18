# apps/mobile/widgetbook

部品カタログ([Widgetbook](https://widgetbook.io/))。
`apps/mobile` の見た目の部品を1つずつ取り出して、**手でいじりながら**見る場所です。

```bash
cd apps/mobile/widgetbook
fvm flutter pub get
fvm dart run build_runner build      # main.directories.g.dart を作る
fvm flutter run -d chrome            # Chrome で開く
```

`build_runner` を忘れると `main.directories.g.dart` が無く、
「Target of URI doesn't exist」で起動できません(本体の `*.freezed.dart` と同じで、
**生成物はコミットしません**)。

## 何を受け持って、何を受け持たないか

| | 見る場所 | 見るもの |
| --- | --- | --- |
| 部品ひとつ | **ここ** | 押した/押していない、日本語/英語、文字サイズ、動く/動かない |
| 画面まるごと | `apps/mobile/test/golden/` | 設計上の約束が画面から消えていないか(PNG比較) |
| 画面の導線 | `apps/mobile/test/` | 戻れるか、値がAPIまで届いているか |

**ここに画面を並べないでください。** 画面は Riverpod のプロバイダを差し替えないと
組めないので、足場(`test/support/harness.dart` 相当)をこちら側にも作ることになり、
**同じ足場が2つ**できます。ずれたときに、どちらが正なのか誰にも分からなくなります。

## アプリ本体とは別パッケージにしている理由

widgetbook は `device_frame_plus` を連れてきます。これは端末の枠を**画像アセット**で
持っていて、**アセットはツリーシェイクされません**。本体の `pubspec.yaml` に入れると、
`lib/` から一度も参照していなくても、配る `.ipa` / `.apk` に端末フレームの画像が
まるごと載ります。カタログのために配布物を太らせない、が理由です。

副作用として、本体の `dart run build_runner build` に `widgetbook_generator` が
混ざらないので、CIのコード生成も重くなりません。

## 右のパネル(アドオン)

| アドオン | 見るもの |
| --- | --- |
| Viewport | `393x852`(golden と同じ)/ `375x667`(いちばん狭い実機)。数字は `test/support/harness.dart` と揃えてあります |
| Locale | 日本語 / 英語。板書の `sentence` と `compare` は**英語の授業でしか出ない枝**です |
| Text scale | 端末の文字サイズ。**このアプリで最初に壊れるのはここ**(折り返しが増えてボタンが下に落ちる) |
| Reduce motion | 端末の「アニメーションを減らす」。入れると**終わった状態**で描かれます(`AppMotion`) |
| Semantics | 読み上げの当たり判定。板書は断片を消して1文にまとめてあり、崩れても**見た目は変わりません** |
| Alignment / Inspector | 置き位置と、寸法の実測 |

## 気をつけること

### フォントは起動時に名前を足している

依存パッケージが宣言したフォントは `packages/ai_sensei/ZenMaruGothic` という名前で
載ります。一方 `AppTheme.light()` が引くのはプレフィックス無しの `ZenMaruGothic` なので、
そのままだとカタログだけ素の書体で描かれます。`main.dart` の `registerAppFonts()` が
`FontManifest.json` を読んで、プレフィックス無しの名前でもう一度登録しています
(テーマ側を書き換えると、カタログのテーマが本体からずれていくため)。

### 左のツリーの日本語が出ないとき

カタログ自身のUI(左のツリー・右のパネル)は Poppins で描かれていて、**日本語の
グリフを持っていません。** Flutter Web は足りない字を見つけると Google の Noto を
`fonts.gstatic.com` から落として補うので、**外に出られない環境では、ユースケース名だけが
空白**になります(部品側は同梱の丸ゴシックで描くので、そちらは出ます)。
つないだ状態で開けば直ります。カタログの組み方の問題ではありません。

### 本体の `flutter analyze` はここを見ていない

`apps/mobile/analysis_options.yaml` が `widgetbook/**` を除外しています。除外しないと、
こちらの `pub get` がまだな人の `flutter analyze`(= **pre-commit**)が
100件以上のエラーで落ちるためです。
かわりに CI(`.github/workflows/ci.yml` の Flutter ジョブ)が、このパッケージだけを
`pub get` → `build_runner` → `analyze` → `test` の順で見ています。

### `implementation_imports` だけ外している

`ai_sensei` は `publish_to: none` の同じリポジトリのアプリで、部品も画面も
`lib/src/` の下にあります(外向けの公開APIの層を持たない)。カタログから部品を
指せなくなると成立しないので、このパッケージでだけ外しています。
**外部に配るパッケージをこのリポジトリに足すときは、この判断を持ち出さないこと。**

### 使用統計は止めてある

`widgetbook_generator` は生成のたびに `git config user.email` のハッシュと
`remote.origin.url` を Mixpanel へ送ります。`build.yaml` で無効にしています。

## ユースケースを足す

`lib/use_cases/` に `@widgetbook.UseCase` を付けた関数を書き、`build_runner` を回します。

```dart
@widgetbook.UseCase(name: '押せない', type: ChunkyButton)
Widget buildChunkyButtonDisabledUseCase(BuildContext context) {
  return stage(const ChunkyButton(label: '授業をはじめる', onPressed: null));
}
```

**木の並びは手で決めません。** `type:` に渡した部品が本体のどこにあるかで決まるので、
`lib/src/common_widgets/chunky_button.dart` の部品は `common_widgets` の下に出ます。
カタログの並び = 本体の構造です。

足したら `fvm flutter test` を通してください。`test/use_cases_smoke_test.dart` が
**ユースケースを1件ずつ開いて**、例外なく描けることを見ています。
