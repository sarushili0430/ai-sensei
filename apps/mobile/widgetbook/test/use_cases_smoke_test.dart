import 'package:ai_sensei_widgetbook/home.dart';
import 'package:ai_sensei_widgetbook/main.dart';
import 'package:ai_sensei_widgetbook/main.directories.g.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:widgetbook/widgetbook.dart';

/// カタログのユースケースを、1件ずつ開いて描く。
///
/// **これが無いと、CIが確かめているのは「コンパイルが通ること」だけになる。**
/// 引数が変わった・部品が消えた、はコンパイルで捕まる。一方で
/// 「開くと例外で落ちる」たぐい —— `Localizations` が足りない、
/// `ensureValid*` の検査に引っかかる、`focus` が本文の部分文字列でない ——
/// は描いてみないと分からない。カタログは普段CIで開かれないので、
/// 誰も起動しないまま何か月も壊れていられる。
///
/// 見た目そのものは見ていない(それは golden の担当)。ここは
/// **開けること**だけを見る。
void main() {
  final WidgetbookRoot root = WidgetbookRoot(children: directories);
  final List<WidgetbookUseCase> useCases = root.leaves
      .whereType<WidgetbookUseCase>()
      .toList();

  test('ユースケースが1件も生成されていない、という状態で通さない', () {
    // `dart run build_runner build` を忘れて `directories` が空のままだと、
    // 下のループが0周してテストが全部緑になる。
    expect(useCases, isNotEmpty);
  });

  for (final WidgetbookUseCase useCase in useCases) {
    testWidgets('開ける: ${useCase.path}', (WidgetTester tester) async {
      // カタログのUI(左のツリー・右の設定パネル)ごと描くので、
      // 電話の寸法だと入らずに溢れる。デスクトップ相当にしておく。
      await tester.binding.setSurfaceSize(const Size(1400, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      // **`'/?path=${useCase.path}'` と手で組まないこと。**
      // ユースケース名は日本語なので、素のまま渡すとクエリとして解けず、
      // 表(`WidgetbookRoot.table`)を引けずに入口([CatalogHome])が
      // 出たままになる。**例外は出ないのでテストは緑のまま通る** ——
      // 検知能力のないテストができあがる。
      await tester.pumpWidget(
        AiSenseiWidgetbook(
          initialRoute: Uri(
            path: '/',
            queryParameters: <String, String>{'path': useCase.path},
          ).toString(),
        ),
      );

      // `pumpAndSettle` は使えない。先輩の呼吸や波形は**終わらない**
      // アニメーションなので、返ってこなくなる。
      // ルータが経路を解くのに数フレームかかるので、少しだけ進める。
      for (int i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(tester.takeException(), isNull);
      // 入口が出たまま = 経路が解けていない。上の理由でここが要る。
      expect(find.byType(CatalogHome), findsNothing);

      // 開いたまま終えると、走っているタイマーが「保留中」で落ちる。
      // 木を外して dispose を通す(各ウィジェットがそこで止める)。
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
