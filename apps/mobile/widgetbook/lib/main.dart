import 'dart:convert';

import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:widgetbook/widgetbook.dart';
import 'package:widgetbook_annotation/widgetbook_annotation.dart' as widgetbook;

import 'addons/reduce_motion_addon.dart';
import 'addons/semantics_debugger_addon.dart';
import 'home.dart';
// build_runner が作る。`dart run build_runner build` を先に走らせること
// (本体の .freezed.dart / .g.dart と同じで、コミットしない)。
import 'main.directories.g.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await _registerAppFonts();
  runApp(const AiSenseiWidgetbook());
}

/// 本体の丸ゴシックを、**プレフィックス無しの名前でもう一度登録する。**
///
/// 依存パッケージが宣言したフォントは `packages/ai_sensei/ZenMaruGothic` と
/// いう名前で載る。一方 `AppTheme.light()` が引いているのは
/// `AppTheme.fontFamily`(= `ZenMaruGothic`。プレフィックス無し)なので、
/// このままだとカタログだけが素の書体で描かれる。**アプリに存在しない
/// 見え方**を見ながら部品を直すことになるので、ここで名前を足す。
///
/// テーマ側を書き換えて合わせることもできるが、そうするとカタログのテーマが
/// 本体から少しずつずれていく。`AppTheme.light()` をそのまま使いたいので、
/// 直すのは名前のほうにする。
///
/// ウェイトを増やしても、ここは変わらない(`FontManifest.json` から拾うため)。
/// 逆に**フォントの宣言ごと消えたら、ここは静かに何もしない** —— そのときは
/// 書体が変わったことが画面に出るので、気づける。
Future<void> _registerAppFonts() async {
  final List<dynamic> manifest =
      jsonDecode(await rootBundle.loadString('FontManifest.json')) as List<dynamic>;

  for (final dynamic entry in manifest) {
    final Map<String, dynamic> family = entry as Map<String, dynamic>;
    if (family['family'] != 'packages/ai_sensei/${AppTheme.fontFamily}') continue;

    // ウェイトは渡さない。同じ family に複数の実体を足すと、
    // どれを使うかはフォント自身が持つ太さから決まる
    // (`test/support/harness.dart` の `loadAppFonts` と同じやり方)。
    final FontLoader loader = FontLoader(AppTheme.fontFamily);
    for (final dynamic font in family['fonts'] as List<dynamic>) {
      loader.addFont(rootBundle.load((font as Map<String, dynamic>)['asset'] as String));
    }
    await loader.load();
    return;
  }
}

/// 見た目の部品カタログ。
///
/// **画面ではなく部品を並べる場所。** 画面まるごとの回帰は golden test が
/// 見ている(`test/golden/`)ので、ここが受け持つのは
/// 「部品ひとつを、いろんな状態・寸法・文字サイズで**手で**いじる」ほう。
/// 押した/押していない、日本語/英語、動く/動かない —— テストに書きにくく、
/// でも目で見れば一瞬で分かることが対象。
///
/// 木の並びは `@UseCase(type:)` に渡した部品の置き場所から自動で決まるので、
/// `lib/src/common_widgets/chunky_button.dart` の部品は `common_widgets` の
/// 下に出る。**カタログの並び順は本体の構造そのもの**で、手で並べ替えない。
@widgetbook.App()
class AiSenseiWidgetbook extends StatelessWidget {
  const AiSenseiWidgetbook({this.initialRoute = '/', super.key});

  /// 最初に開くユースケース。既定は入口(何も選んでいない状態)。
  /// スモークテストが1件ずつ名指しで開くために受けている。
  final String initialRoute;

  @override
  Widget build(BuildContext context) {
    return Widgetbook.material(
      directories: directories,
      initialRoute: initialRoute,
      appBuilder: _appBuilder,
      home: const CatalogHome(),
      addons: <WidgetbookAddon<dynamic>>[
        // 順番 = 入れ子の順番(先頭が外側)。寸法を決めてから、
        // その MediaQuery に対して文字サイズと動きを足す。
        //
        // **先頭が既定値。** 電話のアプリなので、既定は電話の幅にする。
        // 素の広さ(`none`)を既定にすると、幅いっぱいに広がる部品が
        // 実機ではありえない横幅で描かれる。
        ViewportAddon(<ViewportData>[
          _phoneViewport,
          _smallPhoneViewport,
          Viewports.none,
        ]),
        // 日本語 / 英語。**片方だけ見て終わらせない。**
        // 板書の `sentence` と `compare` は英語の授業でしか出ない枝で、
        // ラベルの長さも日英でまるで違う。
        LocalizationAddon(
          locales: AppStrings.supportedLocales,
          localizationsDelegates: _delegates,
        ),
        // 端末の文字サイズ。**このアプリで最初に壊れるのはここ。**
        // 先輩のせりふも板書も可変長なので、大きくすると折り返しが増えて
        // ボタンが折り返しの下に落ちる(`test/layout_overflow_test.dart` が
        // 追いかけているのと同じ壊れ方)。
        TextScaleAddon(min: 0.85, max: 2, divisions: 5),
        ReduceMotionAddon(),
        // 読み上げが1行ずつになっているか。板書は `ExcludeSemantics` で
        // 断片を消して1文にまとめてあるので、崩れるとここで見える。
        SemanticsDebuggerAddon(),
        AlignmentAddon(),
        InspectorAddon(),
      ],
    );
  }
}

/// 本番の `AiSenseiApp`(`lib/main.dart`)と同じ足場を組む。
///
/// **デリゲートを削らないこと。** 落とすと「MaterialLocalizations が ja に
/// 対応していない」で全ユースケースが落ちる。テストの `wrapApp`
/// (`test/support/harness.dart`)が同じ理由で同じものを渡している。
///
/// ここで `locale` を固定していないのは、[LocalizationAddon] に任せているから。
/// アドオンは appBuilder の**内側**で組み立てられる(widgetbook の `Workbench`)
/// ので、アドオンが挿し直す `Localizations` がこの `MaterialApp` のものより
/// 内側に来る。つまり切り替えはアドオン側が勝つ。
Widget _appBuilder(BuildContext context, Widget child) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light(),
    supportedLocales: AppStrings.supportedLocales,
    localizationsDelegates: _delegates,
    home: Scaffold(
      // 部品は「地の色の上」に置かれる前提で作ってある(白地ではない)。
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: child,
    ),
  );
}

const List<LocalizationsDelegate<dynamic>> _delegates =
    <LocalizationsDelegate<dynamic>>[
      AppStringsDelegate(),
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ];

/// 既定の寸法。`test/support/harness.dart` の `phoneSurface` と同じ値。
///
/// golden と同じ寸法で見られないと、「カタログでは収まっていたのに
/// golden では溢れた」が起きる。数字は必ず片方に合わせる。
const ViewportData _phoneViewport = ViewportData(
  name: 'iPhone 15 (393x852)',
  width: 393,
  height: 852,
  pixelRatio: 3,
  platform: TargetPlatform.iOS,
);

/// いちばん狭い実機。`smallPhoneSurface` と同じ値。
/// 折り返しの下に操作が落ちていないかは、この寸法で見る。
const ViewportData _smallPhoneViewport = ViewportData(
  name: 'iPhone SE (375x667)',
  width: 375,
  height: 667,
  pixelRatio: 2,
  platform: TargetPlatform.iOS,
);
