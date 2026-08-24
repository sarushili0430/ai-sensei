import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/common_widgets/senpai_face.dart';
import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// 設計上の約束が画面から消えていないかを構造で確かめる。
/// 見た目そのものは test/golden/ が見る。
Future<void> pump(WidgetTester tester, Widget child) =>
    pumpApp(tester, Scaffold(body: child));

void main() {
  group('ChunkyButton', () {
    testWidgets('押すとコールバックが呼ばれる', (WidgetTester tester) async {
      int taps = 0;
      await pump(tester, ChunkyButton(label: 'はじめる', onPressed: () => taps++));

      await tester.tap(find.text('はじめる'));
      expect(taps, 1);
    });

    test('onPressedがnullなら無効', () {
      const ChunkyButton button = ChunkyButton(label: 'x', onPressed: null);
      expect(button.onPressed, isNull);
    });
  });

  group('MarkerText', () {
    testWidgets('言えたことは黄、穴はピンクのマーカーで示す', (WidgetTester tester) async {
      await pump(
        tester,
        const Column(
          children: <Widget>[
            MarkerText('中心と直線の距離で判定した', marker: MarkerColor.said),
            MarkerText('判別式のなぜで説明が止まった', marker: MarkerColor.hole),
          ],
        ),
      );

      expect(find.byType(MarkerText), findsNWidgets(2));
      expect(find.text('中心と直線の距離で判定した'), findsOneWidget);
    });
  });

  group('SenpaiFace', () {
    testWidgets('表情ごとに読み上げラベルを持つ', (WidgetTester tester) async {
      await pump(tester, const SenpaiFace(mood: SenpaiMood.delighted));
      expect(find.bySemanticsLabel('先輩が納得しています'), findsOneWidget);
    });

    // 幅がぴったりで降りてくる並びの中でも、顔は size の正方形のまま。
    // ここが崩れると、目と口は幅の割合で置いているので画面の両端まで飛び、
    // iPad の会話画面で顔が横一杯の落書きになった。
    testWidgets('広い画面の stretch な列でも、size より大きくならない', (
      WidgetTester tester,
    ) async {
      await pumpApp(
        tester,
        const Scaffold(
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[SenpaiFace(mood: SenpaiMood.neutral, size: 160)],
          ),
        ),
        size: tabletSurface,
      );

      // 絵を描くのはこの箱。ここの寸法がそのまま目と口の位置になる。
      final Size painted = tester.getSize(
        find.descendant(
          of: find.byType(SenpaiFace),
          matching: find.byType(CustomPaint),
        ),
      );
      expect(painted, const Size(160, 160));
    });
  });

  group('ペイウォール', () {
    // HAMMは誠実さを見る。無料継続の導線と解約可能の明記を消させない。
    // 「自動更新される」は Guideline 3.1.2 の必須表記。解約できることだけを
    // 書いて更新に触れないのは、誠実さ(§6)の面でもリジェクトの面でもだめ。
    testWidgets('無料のまま続ける導線と、自動更新・解約の明示を同じ画面に置く', (WidgetTester tester) async {
      await pumpApp(tester, const PaywallScreen());

      expect(find.text('無料のまま続ける'), findsOneWidget);
      expect(find.text('登録は自動更新されます。いつでも解約できます'), findsOneWidget);
      expect(find.text('毎日1問'), findsOneWidget);
      expect(find.text('毎日、続けて何問も'), findsOneWidget);
      // 無制限を約束しない。フェアユース上限があるので、買ったあとにAPIが断る。
      expect(find.text('無制限'), findsNothing);
      expect(find.text('毎日、何問でも'), findsNothing);
    });
  });

  group('セッションの結果', () {
    // 会話画面はAutoDisposeなので、祝福に着いた時点で破棄されている。
    // ペイウォールの判断と降り方は、画面の寿命を越えるこの値に持ち回る。
    test('既定ではペイウォールを出さない', () {
      const SessionOutcome outcome = SessionOutcome();
      expect(outcome.showPaywall, isFalse);
      expect(outcome.ending, SessionEnding.understood);
    });

    test('サーバがtrueを返したときだけ出す', () {
      const SessionOutcome outcome = SessionOutcome(showPaywall: true);
      expect(outcome.showPaywall, isTrue);
    });
  });

  group('カルテのモデル', () {
    test('穴が空でも成立する(止まらずに説明できた日)', () {
      final Karte karte = Karte.fromJson(<String, dynamic>{
        'id': 'kar_1',
        'session_id': 'ses_1',
        'created_at': '2026-08-03T13:24:07.000Z',
        'topic_ids': <String>['M2-ZUKEI-ENCHOKU'],
        'said_well': <String>['方針を理由つきで説明できた'],
        'holes': <dynamic>[],
        'term_notes': <dynamic>[],
        'followup_question': null,
      });

      expect(karte.holes, isEmpty);
      expect(karte.saidWell, hasLength(1));
    });
  });
}
