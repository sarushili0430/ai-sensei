import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/paywall_screen.dart';
import 'package:ai_sensei/src/features/monetization/presentation/thanks_screen.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/features/study_room/presentation/study_room_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// **狭い端末で、画面から中身がこぼれていないか。**
///
/// 同じ壊れ方を3回やった: `Column` を `Spacer` で下端に押し付ける形は、
/// 文言が伸びた瞬間に**中身が切り落とされ、操作が押せなくなる**。
/// しかも `RenderFlex overflowed` は**縞模様が出るだけで、テストは緑のまま**
/// (寸法を固定していなければ、そもそも再現しない)。
///
///   - オンボーディング1・2枚目 … 英語の見出しが伸びて 375×667 で 145px 溢れた
///   - リハーサル … 板書を積んで操作が折り返しの下へ
///   - 撮影の確認画面 … 契約上限(問題文600字)で 557px 溢れた
///
/// 起きる条件は決まっている: **いちばん狭い実機 × いちばん長い文言**。
/// だから全画面をその条件で1回ずつ描いて、例外が出ないことだけを見る。
/// 見た目は golden の仕事で、ここは**切り落とされていないこと**だけを見る。
void main() {
  /// [screen] を狭い端末で描いて、こぼれていないことを確かめる。
  ///
  /// `RenderFlex overflowed` は `FlutterError` として上がるので、
  /// `takeException()` で拾える。
  Future<void> expectNoOverflow(
    WidgetTester tester,
    Widget screen, {
    required Locale locale,
    List<Object?> overrides = const <Object?>[],
  }) async {
    await pumpApp(
      tester,
      screen,
      overrides: overrides,
      locale: locale,
      size: smallPhoneSurface,
    );
    expect(
      tester.takeException(),
      isNull,
      reason: '${screen.runtimeType} が ${locale.languageCode} で '
          '${smallPhoneSurface.width.toInt()}x${smallPhoneSurface.height.toInt()} から溢れています',
    );
  }

  // 英語は日本語の1.5〜2倍の長さになる。日本語で組んだ余白は英語で必ず破れるので、
  // 両方通す(審査員が見るのは英語版・handoff §3-7)。
  for (final Locale locale in <Locale>[const Locale('ja'), const Locale('en')]) {
    final String lang = locale.languageCode;

    testWidgets('オンボーディング4枚 ($lang)', (WidgetTester tester) async {
      final AppStrings strings = AppStrings(locale);
      await pumpApp(
        tester,
        const OnboardingScreen(),
        locale: locale,
        size: smallPhoneSurface,
      );
      expect(tester.takeException(), isNull, reason: '1枚目');

      for (final String page in <String>['2枚目', '3枚目']) {
        await tester.tap(find.text(strings.onboardingNext));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: page);
      }

      // 4枚目は3枚目を通らないと出ない。パスでも通れる(約束3)。
      await tester.tap(find.text(strings.sessionPass));
      await tester.pumpAndSettle();
      await tester.tap(find.text(strings.onboardingNext));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: '4枚目');
    });

    testWidgets('ホーム ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const HomeScreen(),
        locale: locale,
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
        ],
      );
    });

    // 上限に当たった日のホーム。**先輩の判断**の文が長いので、ここが伸びやすい。
    testWidgets('ホーム(今日はここまで) ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const HomeScreen(),
        locale: locale,
        overrides: <Object?>[
          progressControllerProvider.overrideWith(
            () => FakeProgressController(exhaustedSummary),
          ),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
        ],
      );
    });

    testWidgets('自習室 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(tester, const StudyRoomScreen(), locale: locale);
    });

    testWidgets('祝福 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const CelebrationScreen(),
        locale: locale,
        overrides: <Object?>[
          progressControllerProvider.overrideWith(FakeProgressController.new),
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome()),
          ),
        ],
      );
    });

    testWidgets('カルテ ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const KarteScreen(),
        locale: locale,
        overrides: <Object?>[
          latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
          sessionOutcomeControllerProvider.overrideWith(
            () => FakeSessionOutcomeController(const SessionOutcome(showPaywall: true)),
          ),
        ],
      );
    });

    testWidgets('復習 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const ReviewScreen(),
        locale: locale,
        overrides: <Object?>[
          reviewControllerProvider.overrideWith(
            () => FakeReviewController(
              ReviewQueue(
                requiresPremium: false,
                items: <ReviewQueueItem>[
                  ReviewQueueItem(
                    hole: sampleKarte.holes.first,
                    daysSince: 3,
                    prompt: '3日前の「判別式のなぜ」、いまなら説明できますか?',
                  ),
                ],
                filled: <FilledHole>[sampleFilledHole],
              ),
            ),
          ),
        ],
      );
    });

    testWidgets('ペイウォール ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(tester, const PaywallScreen(), locale: locale);
    });

    testWidgets('購入のお礼 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const ThanksScreen(),
        locale: locale,
        overrides: premiumOverrides(),
      );
    });

    testWidgets('設定 ($lang)', (WidgetTester tester) async {
      await expectNoOverflow(
        tester,
        const SettingsScreen(),
        locale: locale,
        overrides: <Object?>[
          deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
        ],
      );
    });
  }
}
