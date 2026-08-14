import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/confetti.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/entitlement_controller.dart';

/// How to say thanks. "Thank you for your purchase" is not always truthful.
enum ThanksKind {
  /// Bought. The one case where a plain thank-you is honest.
  purchased,

  /// A free trial started. Nothing has been paid, so thanking them would be
  /// factually false.
  trial,

  /// Restored after a device change. Nothing was re-bought, so a thank-you
  /// would suggest they paid twice.
  restored,
}

/// Thank-you screen, straight after the paywall.
///
/// Without it, a successful purchase merely closed the screen — saying nothing
/// at the moment someone pays was the cheapest unkindness to fix.
///
/// Built in the celebration screen's grammar (confetti plus senpai's bounce).
/// This is the only place that gets loud; karte and review keep no party colors.
///
/// A payment that succeeded without an entitlement never reaches here (the
/// router blocks it): celebrating and then locking out is the worst drop.
class ThanksScreen extends ConsumerWidget {
  const ThanksScreen({this.restored = false, super.key});

  /// Whether we arrived via restore. Purchase vs trial is not passed in — the
  /// entitlement knows that, and screen and SDK must not hold separate truths.
  final bool restored;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Entitlement entitlement =
        ref.watch(entitlementControllerProvider).value ?? Entitlement.free;

    final ThanksKind kind = restored
        ? ThanksKind.restored
        : entitlement.isTrial
        ? ThanksKind.trial
        : ThanksKind.purchased;

    // Without an expiry we can state neither the renewal date nor the days
    // left. Silence beats inventing numbers, so everything below allows null.
    final DateTime? expiresAt = entitlement.expiresAt;
    final String? date = expiresAt == null ? null : strings.date(expiresAt);
    final int daysLeft = entitlement.daysLeft(DateTime.now());

    final String title = switch (kind) {
      ThanksKind.restored => strings.thanksRestoredTitle,
      ThanksKind.trial when daysLeft > 0 => strings.thanksTrialTitle(daysLeft),
      ThanksKind.trial => strings.thanksTrialTitlePlain,
      ThanksKind.purchased => strings.thanksTitle,
    };

    final String body = switch (kind) {
      ThanksKind.restored when date != null => strings.thanksRestoredBody(date),
      ThanksKind.trial when date != null => strings.thanksTrialBody(date),
      _ => strings.thanksBody,
    };

    // Auto-renewal is stated even on a celebratory screen (guideline 3.1.2).
    // Trials already state the billing start date in the body, so no repeat.
    final String note = kind == ThanksKind.purchased && date != null
        ? strings.thanksRenewsOn(date)
        : strings.thanksCancelAnytime;

    return Scaffold(
      backgroundColor: AppColors.celebration,
      body: Stack(
        children: <Widget>[
          // Confetti sits behind the text; never drop paper in front of reading.
          const Positioned.fill(child: ConfettiBurst()),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  const PopIn(child: SenpaiFace(mood: SenpaiMood.delighted, size: 140)),
                  const SizedBox(height: AppSpacing.lg),
                  FadeSlideIn.staggered(
                    index: 2,
                    child: Text(
                      title,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.displaySmall,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  FadeSlideIn.staggered(
                    index: 3,
                    child: Text(
                      body,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  const FadeSlideIn.staggered(index: 4, child: _UnlockedCard()),
                  const SizedBox(height: AppSpacing.xl),
                  FadeSlideIn.staggered(
                    index: 6,
                    child: ChunkyButton(
                      label: strings.thanksStart,
                      onPressed: context.closeOrGoHome,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  FadeSlideIn.staggered(
                    index: 7,
                    child: Text(
                      note,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// What was unlocked.
///
/// "You're Premium now" alone sends people home without knowing what changed.
/// This lists the same three items in the same order as the paywall's
/// comparison, so the pitch and what arrived can be checked against each other.
class _UnlockedCard extends StatelessWidget {
  const _UnlockedCard();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final List<String> lines = <String>[
      strings.thanksUnlockedSessions,
      strings.thanksUnlockedHistory,
      strings.thanksUnlockedFollowup,
    ];

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          for (int i = 0; i < lines.length; i++)
            Padding(
              padding: EdgeInsets.only(bottom: i == lines.length - 1 ? 0 : AppSpacing.sm),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Icon(Icons.check_circle, size: 18, color: AppColors.blue),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(lines[i], style: Theme.of(context).textTheme.bodyMedium),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
