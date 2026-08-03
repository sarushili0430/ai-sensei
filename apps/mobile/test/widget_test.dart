import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/common_widgets/kohai_face.dart';
import 'package:ai_sensei/src/common_widgets/marker_text.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// golden test の追加はフォント配置後に行う(README参照)。
/// ここでは、設計上の約束が画面から消えていないかを構造で確かめる。
Widget wrap(Widget child) {
  return ProviderScope(
    child: MaterialApp(
      theme: AppTheme.light(),
      locale: const Locale('ja'),
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[AppStringsDelegate()],
      supportedLocales: AppStrings.supportedLocales,
      home: Scaffold(body: child),
    ),
  );
}

void main() {
  group('ChunkyButton', () {
    testWidgets('押すとコールバックが呼ばれる', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(
        wrap(ChunkyButton(label: 'はじめる', onPressed: () => taps++)),
      );

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
      await tester.pumpWidget(
        wrap(
          const Column(
            children: <Widget>[
              MarkerText('中心と直線の距離で判定した', marker: MarkerColor.said),
              MarkerText('判別式のなぜで説明が止まった', marker: MarkerColor.hole),
            ],
          ),
        ),
      );

      expect(find.byType(MarkerText), findsNWidgets(2));
      expect(find.text('中心と直線の距離で判定した'), findsOneWidget);
    });
  });

  group('KohaiFace', () {
    testWidgets('表情ごとに読み上げラベルを持つ', (WidgetTester tester) async {
      await tester.pumpWidget(wrap(const KohaiFace(mood: KohaiMood.delighted)));
      expect(find.bySemanticsLabel('後輩が納得しています'), findsOneWidget);
    });
  });

  group('ペイウォール', () {
    // HAMMは誠実さを見る。無料継続の導線と解約可能の明記を消させない。
    testWidgets('無料のまま続ける導線と、解約できる旨を同じ画面に置く', (WidgetTester tester) async {
      await tester.pumpWidget(wrap(const PaywallScreen()));
      await tester.pump();

      expect(find.text('無料のまま続ける'), findsOneWidget);
      expect(find.text('いつでも解約できます'), findsOneWidget);
    });
  });

  group('セッションの結果', () {
    // レビュー指摘: 会話画面はAutoDisposeなので、祝福・カルテに着いた時点で
    // 破棄されている。ペイウォールの判断(サーバ由来)はここに持ち回る。
    test('既定ではペイウォールを出さない', () {
      const SessionOutcome outcome = SessionOutcome();
      expect(outcome.showPaywall, isFalse);
      expect(outcome.resultMissing, isFalse);
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
