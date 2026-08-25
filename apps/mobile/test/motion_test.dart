import 'package:ai_sensei/src/common_widgets/confetti.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_loop.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_motion.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_ready.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// **動かしたままでしか出ない壊れ方**を見るテスト。
///
/// ほかのテストは端末の「アニメーションを減らす」と同じ経路を通していて
/// (`reduceMotion`)、入場アニメーションが**終わった状態**しか描かない。
/// 撮る絵が安定するかわりに、途中のフレームがどのテストにも映らない。
/// 実際、次の2つは全テストが緑のまま実機にだけ出ていた:
///
///   - 年表([RevealTrail])の線が**まだ引かれていない一瞬**に行の高さが無限になり、
///     release では落ちずに**見出しと年表が同じ場所に重なって**描かれた
///   - 紙吹雪([ConfettiBurst])が降りきる前に時間切れになり、**紙が空中で止まった**
///
/// どちらも「終わった状態」だけを見ていると存在しない。だからここだけ
/// `wrapApp(motion: true)` で動かし、**1フレームずつ**進めて見る。
/// 呼吸のようなループがあるので `pumpAndSettle` は使えない。
void main() {
  /// 画面を組み立てて、[finder] が出た最初のフレームまで進める。
  ///
  /// ローカライズのデリゲートは非同期に読まれるので、1フレーム目には
  /// まだ本文が無い(`pumpApp` の説明と同じ理由)。
  Future<void> pumpLive(
    WidgetTester tester,
    Widget child, {
    required Finder until,
  }) async {
    await setSurface(tester);
    await tester.pumpWidget(wrapApp(Scaffold(body: child), motion: true));

    for (int i = 0; i < 30 && until.evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(until, findsOneWidget, reason: '画面が出ないままでは、動きを見られない');
  }

  group('年表', () {
    for (final (String name, Widget page) in <(String, Widget)>[
      ('やること', const OnboardingLoopPage()),
      ('これから', const OnboardingReadyPage()),
    ]) {
      // 線を「高さ」で伸ばすと、`IntrinsicHeight` が固有高さを聞きにきたときに
      // 割合で割り算をする。引き始めの割合は 0 なので、行の高さが無限になる
      // (`RevealTrail` の説明)。debug ではここが例外で落ち、release では
      // 落ちないまま文字が重なる。
      testWidgets('$name — 線を引き始めてから引き終わるまで、行の高さが動かない', (
        WidgetTester tester,
      ) async {
        await pumpLive(tester, page, until: find.byType(RevealTrail));

        final Set<double> heights = <double>{};
        for (int i = 0; i < 150; i++) {
          heights.add(tester.renderObject<RenderBox>(find.byType(RevealTrail)).size.height);
          await tester.pump(const Duration(milliseconds: 16));
        }

        expect(
          heights.every((double it) => it.isFinite && it > 0),
          isTrue,
          reason: '高さが無限だと、release では落ちずに文字が重なって描かれる',
        );
        expect(
          heights.length,
          1,
          reason: '線は塗りで伸びる。伸びるたびに行の高さが動くと、読んでいる文が揺れる',
        );
      });
    }
  });

  group('紙吹雪', () {
    testWidgets('降り終わったとき、紙は1枚も画面に残らない', (WidgetTester tester) async {
      await pumpLive(
        tester,
        const ConfettiBurst(),
        until: find.byType(ConfettiBurst),
      );

      // 途中では降っている。ここが 0 だと、下の検査は「何も描いていない」でも通る。
      await tester.pump(const Duration(milliseconds: 900));
      expect(_visiblePieces(tester), greaterThan(0), reason: '祝っている最中は紙が降っている');

      // 止まるところまで進める。`forward()` は 1 で値を保つので、
      // ここで空中に紙が残っていると、そのまま貼りついたままになる。
      await tester.pump(const Duration(milliseconds: 5000));
      expect(
        _visiblePieces(tester),
        0,
        reason: '空中で止まった紙は「固まった」に見える。全部を画面の下から出しきる',
      );
    });

    // 待たせている画面のための降り続け。こちらは止まらないのが正しい。
    testWidgets('降り続けるほうは、いつまでも紙が降っている', (WidgetTester tester) async {
      await pumpLive(
        tester,
        const ConfettiBurst(looping: true),
        until: find.byType(ConfettiBurst),
      );

      for (int i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 700));
        expect(_visiblePieces(tester), greaterThan(0), reason: '待たせているあいだは空にしない');
      }
    });
  });
}

/// いま描かれている紙の枚数。
int _visiblePieces(WidgetTester tester) {
  final CustomPaint paint = tester.widget<CustomPaint>(
    find.descendant(of: find.byType(ConfettiBurst), matching: find.byType(CustomPaint)),
  );
  final _PieceCounter counter = _PieceCounter();
  paint.painter!.paint(counter, phoneSurface);
  return counter.visible;
}

/// 紙を数えるだけのキャンバス。
///
/// 絵そのものは golden が見ている。ここで要るのは**見えている紙が何枚あるか**
/// だけなので、`drawRRect` 以外は受け取って捨てる。
class _PieceCounter implements Canvas {
  int visible = 0;

  @override
  void drawRRect(RRect rrect, Paint paint) {
    if (paint.color.a > 0) visible++;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}
