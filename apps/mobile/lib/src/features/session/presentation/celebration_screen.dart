import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/confetti.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../karte/application/karte_controllers.dart';
import '../../karte/domain/karte.dart';
import '../../monetization/application/entitlement_controller.dart';
import '../../monetization/presentation/purchase_messages.dart';

/// Celebration screen, between the explanation and the karte.
///
/// The loud screen — but it still counts only streak days and filled gaps, never
/// scores, correctness or XP.
///
/// The noise comes from confetti and senpai's bounce alone. Animating big
/// numbers would make it look like a score screen even without scores.
class CelebrationScreen extends ConsumerStatefulWidget {
  const CelebrationScreen({super.key});

  @override
  ConsumerState<CelebrationScreen> createState() => _CelebrationScreenState();
}

class _CelebrationScreenState extends ConsumerState<CelebrationScreen> {
  /// Interval and attempt count for fetching the karte while the celebration
  /// plays.
  ///
  /// The conversation screen does not wait (waiting freezes it between the end
  /// and the next screen); the karte arrives while the confetti falls instead.
  /// Nothing is tapped, because fetching is not the user's job.
  ///
  /// The LLM writes the karte after the conversation, so longer conversations
  /// take longer. At a 40-second cap we gave up just before it finished and
  /// appeared stuck on "fetching…", so we now wait longer than generation
  /// normally takes.
  static const Duration _pollInterval = Duration(seconds: 2);
  static const int _pollAttempts = 45;

  Timer? _poll;
  int _attempts = 0;
  bool _retrieving = false;

  @override
  void initState() {
    super.initState();
    if (ref.read(sessionOutcomeControllerProvider).resultMissing) {
      _poll = Timer.periodic(_pollInterval, (_) => unawaited(_tick()));
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  void _stopPolling() {
    _poll?.cancel();
    _poll = null;
  }

  /// One automatic fetch. On arrival, build swaps the button. It never navigates
  /// — no jumping to the karte mid-confetti.
  Future<void> _tick() async {
    if (_retrieving) return;
    if (_attempts >= _pollAttempts) {
      setState(_stopPolling);
      return;
    }
    _attempts += 1;

    _retrieving = true;
    final bool found = await _fetchQuietly();
    if (!mounted) return;
    _retrieving = false;
    if (found) setState(_stopPolling);
  }

  /// Fetches. Both "still generating" (202) and network failures fold into the
  /// same "not yet": an error during an automatic poll would scold someone who
  /// pressed nothing.
  Future<bool> _fetchQuietly() async {
    try {
      return await ref.read(sessionOutcomeControllerProvider.notifier).retrieveKarte();
    } on Object catch (error) {
      debugPrint('カルテを受け取れませんでした(待ち続けます): $error');
      return false;
    }
  }

  /// Manual fetch for whatever the automatic polling did not get.
  Future<void> _retrieveKarte() async {
    setState(() => _retrieving = true);
    final bool found = await _fetchQuietly();
    if (!mounted) return;
    setState(() => _retrieving = false);
    if (found) {
      context.go(AppRoute.karte.path);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(AppStrings.of(context).karteStillCooking)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final Progress progress =
        (ref.watch(progressControllerProvider).value ?? ProgressSummary.empty).progress;
    final Karte? karte = ref.watch(latestKarteControllerProvider);
    final SessionOutcome outcome = ref.watch(sessionOutcomeControllerProvider);
    // The server decides where the paywall appears: once, just after a gap shows
    // in the first karte.
    final bool showPaywall = outcome.showPaywall;
    final int filledThisSession = karte == null
        ? 0
        : karte.holes.where((Hole it) => it.status == HoleStatus.filled).length;

    // No karte yet; the button stays disabled while a fetch is in flight.
    final bool waiting = karte == null && outcome.resultMissing;
    final bool fetching = _retrieving || _poll != null;

    return Scaffold(
      backgroundColor: AppColors.celebration,
      body: Stack(
        children: <Widget>[
          // Confetti sits behind the text; never drop paper in front of reading.
          //
          // It keeps falling while the karte is awaited. A one-shot burst ends
          // after two seconds, and the motionless screen that follows reads as
          // frozen rather than waiting.
          Positioned.fill(child: ConfettiBurst(looping: fetching)),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  const PopIn(child: SenpaiFace(mood: SenpaiMood.delighted, size: 160)),
                  const SizedBox(height: AppSpacing.xl),
                  FadeSlideIn.staggered(
                    index: 2,
                    child: Text(
                      filledThisSession > 0
                          ? strings.celebrationFilled(filledThisSession)
                          : strings.celebrationThanks,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.displaySmall,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  FadeSlideIn.staggered(
                    index: 4,
                    child: Text(
                      strings.streakDays(progress.streakDays),
                      textAlign: TextAlign.center,
                      style: Theme.of(context)
                          .textTheme
                          .bodyLarge
                          ?.copyWith(color: AppColors.streak),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xl),
                  // Tapping "today's karte" before it arrives bounces you home
                  // with nothing to show, so it becomes a fetch button instead.
                  FadeSlideIn.staggered(
                    index: 6,
                    child: waiting
                        ? Column(
                            children: <Widget>[
                              // Never just a disabled button: with unchanging
                              // wording there is no telling waiting from broken.
                              // Say what is being waited for.
                              Text(
                                fetching ? strings.karteWriting : strings.karteTakingLong,
                                textAlign: TextAlign.center,
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              const SizedBox(height: AppSpacing.sm),
                              ChunkyButton(
                                label: fetching ? strings.karteRetrieving : strings.karteRetrieve,
                                onPressed: fetching ? null : _retrieveKarte,
                              ),
                            ],
                          )
                        : ChunkyButton(
                            label: strings.karteTitle,
                            onPressed: () => context.go(AppRoute.karte.path),
                          ),
                  ),
                  if (showPaywall)
                    const Padding(
                      padding: EdgeInsets.only(top: AppSpacing.sm),
                      child: _PremiumLine(),
                    ),
                  // An exit while waiting. This screen has no back target, so
                  // without one it would be a dead end.
                  if (waiting)
                    GhostButton(
                      label: strings.sessionBackHome,
                      onPressed: () => context.go(AppRoute.home.path),
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

/// The Premium line shown to anyone heading for the paywall.
///
/// Price and trial both come from the Offering. Hard-coded numbers would
/// disagree with the store's checkout the moment the dashboard changed, leaving
/// people deciding whether to buy on mismatched information.
///
/// The Offering fetch may not have finished by the time this screen appears
/// (entering a session without passing home, or a slow network). While it has
/// not, no number is shown: swapping in the correct one later beats showing a
/// wrong one.
class _PremiumLine extends ConsumerWidget {
  const _PremiumLine();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final List<SubscriptionPlan> plans =
        ref.watch(entitlementControllerProvider).value?.plans ?? const <SubscriptionPlan>[];
    final SubscriptionPlan? plan = planForPeriod(plans, PlanPeriod.monthly);
    final TextStyle? style = Theme.of(context).textTheme.bodySmall;

    if (plan == null) {
      return Text(
        strings.paywallPricePending,
        textAlign: TextAlign.center,
        style: style,
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          strings.paywallPriceLine(plan.period.label(strings), plan.priceString),
          textAlign: TextAlign.center,
          style: style,
        ),
        if (plan.hasFreeTrial)
          Text(
            strings.planFreeTrial(plan.freeTrialDays),
            textAlign: TextAlign.center,
            style: style,
          ),
      ],
    );
  }
}
