import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/confetti.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../karte/application/karte_controllers.dart';
import '../../karte/domain/karte.dart';

/// 祝福画面(説明中とカルテの間)。
///
/// **にぎやかな画面**。ただし数えるのは連続日数と「埋めた穴」だけで、
/// 点数・正誤・XPは出さない(handoff §7)。
///
/// にぎやかさの出しかたは、紙吹雪と後輩のはずみだけ。
/// 数字を大きく動かして盛り上げると、点数を出していないのに
/// 点数の画面に見えてしまう。
class CelebrationScreen extends ConsumerStatefulWidget {
  const CelebrationScreen({super.key});

  @override
  ConsumerState<CelebrationScreen> createState() => _CelebrationScreenState();
}

class _CelebrationScreenState extends ConsumerState<CelebrationScreen> {
  bool _retrieving = false;

  /// 会話直後に間に合わなかったカルテを、もう一度だけ取りに行く。
  Future<void> _retrieveKarte() async {
    setState(() => _retrieving = true);
    final bool found =
        await ref.read(sessionOutcomeControllerProvider.notifier).retrieveKarte();
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
    // ペイウォールを出す位置はサーバが決める(初回カルテで穴が見えた直後の1回だけ)
    final bool showPaywall = outcome.showPaywall;
    final int filledThisSession = karte == null
        ? 0
        : karte.holes.where((Hole it) => it.status == HoleStatus.filled).length;

    return Scaffold(
      backgroundColor: AppColors.streak.withValues(alpha: 0.08),
      body: Stack(
        children: <Widget>[
          // 紙吹雪は本文の下に敷く。読むものの前に紙を落とさない。
          const Positioned.fill(child: ConfettiBurst()),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  const _PopIn(child: KohaiFace(mood: KohaiMood.delighted, size: 160)),
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
                  // カルテがまだ来ていないときに「今日のカルテ」を押させると、
                  // 出すものが無くてホームへ弾かれる。取りに行くボタンに変える。
                  FadeSlideIn.staggered(
                    index: 6,
                    child: karte == null && outcome.resultMissing
                        ? ChunkyButton(
                            label: _retrieving ? strings.karteRetrieving : strings.karteRetrieve,
                            onPressed: _retrieving ? null : _retrieveKarte,
                          )
                        : ChunkyButton(
                            label: strings.karteTitle,
                            onPressed: () => context.go(AppRoute.karte.path),
                          ),
                  ),
                  if (showPaywall)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.sm),
                      child: Text(
                        strings.paywallPrice,
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

/// 少し小さいところから、跳ねて出てくる。
///
/// 行き過ぎて戻る動き([AppCurves.pop])を使うのはここだけ。
/// 内省する画面(カルテ・復習)に持ち込むと、記録が軽く見える。
class _PopIn extends StatelessWidget {
  const _PopIn({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0.7, end: 1),
      duration: AppMotion.decorative(context, AppDurations.celebrate),
      curve: AppCurves.pop,
      builder: (BuildContext context, double scale, Widget? child) =>
          Transform.scale(scale: scale, child: child),
      child: child,
    );
  }
}
