import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:ai_sensei_widgetbook/main.dart';
import 'package:ai_sensei_widgetbook/main.directories.g.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:widgetbook/widgetbook.dart';

/// カタログの足場が、本番の `AiSenseiApp` と同じものを渡しているか。
///
/// **ここがずれても画面は出る。** 部品はちゃんと描かれるので、目で見て
/// 気づけるとは限らない。地の色が少し違うだけ、日本語が英語になるだけ、
/// といった「動くけれど正しくない」状態を、値で押さえておく。
void main() {
  final WidgetbookUseCase anyUseCase = WidgetbookRoot(children: directories).leaves
      .whereType<WidgetbookUseCase>()
      .first;

  Future<void> openAnyUseCase(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      AiSenseiWidgetbook(
        initialRoute: Uri(
          path: '/',
          queryParameters: <String, String>{'path': anyUseCase.path},
        ).toString(),
      ),
    );
    for (int i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    addTearDown(() => tester.pumpWidget(const SizedBox.shrink()));
  }

  /// 部品を包んでいるほう(= カタログのUIではないほう)の `MaterialApp`。
  Finder innerApp() => find.byType(MaterialApp).last;

  testWidgets('部品が乗る地は、本体の地の色', (WidgetTester tester) async {
    await openAnyUseCase(tester);

    // **widgetbook 自身のテーマを拾わないこと。** `appBuilder` が受け取る
    // `context` は widgetbook の木のものなので、そこから
    // `Theme.of(context).scaffoldBackgroundColor` を読むと、本体の地ではなく
    // widgetbook の地(明るいときは 0xFFFDFCFF、**暗いときは暗色**)が入る。
    // 部品は「地の上に置かれる前提」で作ってあるので、これは
    // アプリに存在しない見え方になる。
    final Material surface = tester.widget<Material>(
      find
          .descendant(of: innerApp(), matching: find.byType(Material))
          .first,
    );
    expect(surface.color, AppColors.background);
  });

  testWidgets('部品を包むテーマは AppTheme.light()', (WidgetTester tester) async {
    await openAnyUseCase(tester);

    final BuildContext context = tester.element(
      find.descendant(of: innerApp(), matching: find.byType(Scaffold)).first,
    );
    final ThemeData theme = Theme.of(context);
    expect(theme.scaffoldBackgroundColor, AppColors.background);
    expect(theme.textTheme.bodyLarge?.fontFamily, AppTheme.fontFamily);
  });
}
