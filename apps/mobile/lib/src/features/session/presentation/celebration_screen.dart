import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../karte/application/karte_controllers.dart';
import '../../karte/domain/karte.dart';
import '../../monetization/application/entitlement_controller.dart';
import '../../monetization/presentation/purchase_messages.dart';

/// 授業の降り方を受け取る画面。
///
/// 「わかった」だけを祝福し、残り時間による終了は通常の地とふつうの顔にする。
/// 文字を読まなくても両者を取り違えないことが、途中終了を成果判定に見せない境界。
///
/// **無料で今日の1回を使い切った回は、ここからペイウォールを開く。**
/// 判断はサーバが持つ(`show_paywall`)。祝福を出したあとに `/complete` が届いて
/// 立つので、開くのは画面が組み上がってから([_presentPaywall])。
class CelebrationScreen extends ConsumerStatefulWidget {
  const CelebrationScreen({super.key});

  @override
  ConsumerState<CelebrationScreen> createState() => _CelebrationScreenState();
}

class _CelebrationScreenState extends ConsumerState<CelebrationScreen> {
  /// 一度開いたら、この画面にいるあいだは開き直さない。
  ///
  /// 閉じて戻ってきた生徒に同じ画面をもう一度出すのは、断った相手に
  /// 同じことをもう一度聞くのと同じ(§6 煽らない)。
  bool _paywallOpened = false;

  @override
  void initState() {
    super.initState();
    // `/complete` が祝福へ来るより先に返っていれば、この時点でもう立っている。
    _presentPaywall(ref.read(sessionOutcomeControllerProvider));
  }

  /// ペイウォールを**重ねて**開く。
  ///
  /// `push` なので、閉じれば祝福画面に戻る。「無料のまま続ける」を押した人が
  /// ホームへ飛ばされると、いま終えた授業の締めを読み終える前に画面が変わる。
  void _presentPaywall(SessionOutcome outcome) {
    if (_paywallOpened || !outcome.showPaywall) return;
    // すでに契約している人には開かない。復元でPremiumになった直後や、
    // 買ったあとにこの画面へ戻ってきた回がここに来る。
    if (ref.read(isPremiumProvider)) return;
    _paywallOpened = true;
    // 組み上がる前に押し込むと、祝福を1フレームも見せずに上へ乗ってしまう。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // ルータの無いところ(画面単体のテスト)では何もしない。
      GoRouter.maybeOf(context)?.push(AppRoute.paywall.path);
    });
  }

  @override
  Widget build(BuildContext context) {
    // 祝福が出たあとに `/complete` が届いた回は、ここで立つ。
    ref.listen(sessionOutcomeControllerProvider, (_, SessionOutcome next) {
      _presentPaywall(next);
    });
    final SessionOutcome outcome = ref.watch(sessionOutcomeControllerProvider);
    final bool understood = outcome.ending == SessionEnding.understood;
    /// この画面で Premium を勧めてよいか。
    ///
    /// **`show_paywall` だけでは足りない。** ペイウォールから買うと
    /// [ThanksScreen] に差し替わり、その「はじめる」は
    /// [AppNavigation.closeOrGoHome] なので**この祝福画面へ pop して戻る**。
    /// `SessionOutcome` はサーバが「今日の枠を使い切った」と言った事実なので
    /// 消さずに残すが、そこへ**いま契約しているか**を重ねて見ないと、
    /// 買ったばかりの人に「Premiumをみる」をもう一度出し、
    /// 枠が戻っているのに「もう1問」を隠したままにしてしまう。
    final bool offerPremium = outcome.showPaywall && !ref.watch(isPremiumProvider);
    final Progress progress =
        (ref.watch(progressControllerProvider).value ?? ProgressSummary.empty)
            .progress;
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      key: const Key('session-ending-screen'),
      backgroundColor:
          understood ? AppColors.celebration : AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Expanded(
                child: CenteredScroll(
                  padding: EdgeInsets.zero,
                  children: <Widget>[
                    PopIn(
                      child: understood
                          ? const _CelebrationFace()
                          : const SenpaiFace(
                              key: Key('ending-face-neutral'),
                              mood: SenpaiMood.neutral,
                              size: 160,
                            ),
                    ),
                    const SizedBox(height: AppSpacing.xl),
                    FadeSlideIn.staggered(
                      index: 2,
                      child: Text(
                        understood
                            ? strings.celebrationTitle
                            : strings.timeLimitTitle,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.displaySmall,
                      ),
                    ),
                    if (!understood) ...<Widget>[
                      const SizedBox(height: AppSpacing.sm),
                      FadeSlideIn.staggered(
                        index: 3,
                        child: Text(
                          strings.timeLimitBody,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                    ],
                    if (understood) ...<Widget>[
                      const SizedBox(height: AppSpacing.md),
                      FadeSlideIn.staggered(
                        index: 4,
                        child: Text(
                          strings.streakDays(progress.streakDays),
                          key: const Key('celebration-streak'),
                          textAlign: TextAlign.center,
                          style: Theme.of(context)
                              .textTheme
                              .titleLarge
                              ?.copyWith(color: AppColors.streak),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              // **カードは中央に浮かせず、操作のすぐ上に置く**(キャンバスの
              // ④/④'。顔と見出しだけが余白を取り合う側)。中に混ぜていたころは、
              // 顔から続けて読み下せる位置に無く、「次に何が起きるか」の一行が
              // 祝福の余韻の中に埋もれていた。
              const SizedBox(height: AppSpacing.lg),
              FadeSlideIn.staggered(
                index: 5,
                child: _EndingCard(understood: understood),
              ),
              // 無料で今日の1回を使い切った回だけ、サーバが「ここで出す」と
              // 判断する(`show_paywall`)。**画面遷移キャンバスには無い**が、
              // あれは枠が残っている普通の祝福で、この行はその回のためにある。
              // 生成を待たない(ADR 0009)ので、`/complete` が届いた時点で
              // 立って、この画面のまま差し替わる。
              if (offerPremium) ...<Widget>[
                const SizedBox(height: AppSpacing.md),
                const _PremiumLine(),
              ],
              const SizedBox(height: AppSpacing.lg),
              // **今日の枠が無い人に「もう1問」を出さない。**押した先の撮影で
              // 写真を撮らせてから、サーバが「今日はここまで」と断ることになる。
              // 開いたペイウォールを閉じた人がここへ戻るので、
              // 同じ場所に道の続き(Premiumをみる)を置く。
              if (offerPremium) ...<Widget>[
                ChunkyButton(
                  key: const Key('celebration-see-premium'),
                  label: strings.paywallCta,
                  onPressed: () => context.push(AppRoute.paywall.path),
                ),
                GhostButton(
                  key: const Key('celebration-done'),
                  label: strings.celebrationDone,
                  onPressed: () => context.go(AppRoute.home.path),
                ),
              ] else if (understood) ...<Widget>[
                ChunkyButton(
                  key: const Key('celebration-another-lesson'),
                  label: strings.celebrationAnotherLesson,
                  onPressed: () => context.go(AppRoute.capture.path),
                ),
                GhostButton(
                  key: const Key('celebration-done'),
                  label: strings.celebrationDone,
                  onPressed: () => context.go(AppRoute.home.path),
                ),
              ] else
                ChunkyButton(
                  key: const Key('time-limit-home'),
                  label: strings.reviewBackHome,
                  onPressed: () => context.go(AppRoute.home.path),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 顔の中の装飾とは別に、連続日数と同じ橙のキラキラを2つだけ置く。
class _CelebrationFace extends StatelessWidget {
  const _CelebrationFace();

  @override
  Widget build(BuildContext context) {
    return const SizedBox(
      width: 210,
      height: 170,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          SenpaiFace(
            key: Key('ending-face-delighted'),
            mood: SenpaiMood.delighted,
            size: 160,
          ),
          Positioned(
            left: 4,
            top: 22,
            child: Icon(
              Icons.auto_awesome,
              key: Key('celebration-sparkle-left'),
              color: AppColors.streak,
              size: 26,
            ),
          ),
          Positioned(
            right: 4,
            bottom: 18,
            child: Icon(
              Icons.auto_awesome,
              key: Key('celebration-sparkle-right'),
              color: AppColors.streak,
              size: 22,
            ),
          ),
        ],
      ),
    );
  }
}

class _EndingCard extends StatelessWidget {
  const _EndingCard({required this.understood});

  final bool understood;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Container(
      key: Key(understood ? 'celebration-practice-card' : 'time-limit-card'),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // 印で2枚を撃ち分ける。**同じ白いカードが2つの意味を持つ**ので、
          // 文を読み終える前に「問題が来る日」なのか「今日は来ない」なのかが
          // 分かるようにする(キャンバスの鈴と丸い i)。
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(
              understood
                  ? Icons.notifications_none_rounded
                  : Icons.info_outline_rounded,
              size: 24,
              color: understood ? AppColors.blue : AppColors.inkMuted,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  understood
                      ? strings.celebrationPracticeTitle
                      : strings.timeLimitCardTitle,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  understood
                      ? strings.celebrationPracticeBody
                      : strings.timeLimitCardBody,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// ペイウォールに進む人へ出す、Premium の一行。
///
/// **価格もトライアルも Offering から引く。** 据え置きの数字を書くと、
/// ダッシュボードで値段やトライアルを変えた瞬間に、この行と次に出るストアの
/// 決済画面が食い違う。ユーザーは食い違ったまま買うかどうかを決めることになる。
///
/// この画面に来た時点で Offering の取得が終わっていないことがある
/// (ホームを踏まずにセッションへ入った場合や、通信が遅い場合)。
/// **間に合っていないあいだは数字を出さない。** あとから正しい数字に
/// 差し替わるほうが、間違った数字を見せるよりよい。
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
