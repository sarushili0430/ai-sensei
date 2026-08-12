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

/// 祝福画面(説明中とカルテの間)。
///
/// **にぎやかな画面**。ただし数えるのは連続日数と「埋めた穴」だけで、
/// 点数・正誤・XPは出さない。
///
/// にぎやかさの出しかたは、紙吹雪と先輩のはずみだけ。
/// 数字を大きく動かして盛り上げると、点数を出していないのに
/// 点数の画面に見えてしまう。
class CelebrationScreen extends ConsumerStatefulWidget {
  const CelebrationScreen({super.key});

  @override
  ConsumerState<CelebrationScreen> createState() => _CelebrationScreenState();
}

class _CelebrationScreenState extends ConsumerState<CelebrationScreen> {
  /// 祝福を見ているあいだ、カルテを受け取りに行く間隔と回数。
  ///
  /// 会話画面では待たない(待つと、終わってから画面が変わるまで固まる)。
  /// 代わりに**紙吹雪を見ているあいだ**に届く。押させないのは、
  /// 押すのがユーザーの仕事ではないから。
  ///
  /// カルテは会話が終わってからLLMが書くので、長い会話ほど遅い。40秒で
  /// 諦めていたころは、**書き上がる直前で待つのをやめて**「取りに行って
  /// います…」のまま止まったように見えていた。生成が普通に終わるより長く待つ。
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

  /// 自動で取りに行く1回ぶん。届けば build がボタンを差し替える。
  /// **ここでは画面を動かさない** — 紙吹雪の途中でカルテへ飛ばさない。
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

  /// 取りに行く。生成中(202)も通信の失敗も、ここでは同じ「まだ」に畳む。
  /// 自動で回している最中にエラーを出すと、押していないのに叱られる。
  Future<bool> _fetchQuietly() async {
    try {
      return await ref.read(sessionOutcomeControllerProvider.notifier).retrieveKarte();
    } on Object catch (error) {
      debugPrint('カルテを受け取れませんでした(待ち続けます): $error');
      return false;
    }
  }

  /// 自動で届かなかったぶんを、手で取りに行く。
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
    // ペイウォールを出す位置はサーバが決める(初回カルテで穴が見えた直後の1回だけ)
    final bool showPaywall = outcome.showPaywall;
    final int filledThisSession = karte == null
        ? 0
        : karte.holes.where((Hole it) => it.status == HoleStatus.filled).length;

    // まだカルテが手元に無い。自分で取りに行っている最中は押させない。
    final bool waiting = karte == null && outcome.resultMissing;
    final bool fetching = _retrieving || _poll != null;

    return Scaffold(
      backgroundColor: AppColors.celebration,
      body: Stack(
        children: <Widget>[
          // 紙吹雪は本文の下に敷く。読むものの前に紙を落とさない。
          //
          // カルテを待たせているあいだは降り続ける。一度きりだと2秒で止まり、
          // そのあと**画面から動きが消える**。待っているだけなのに、
          // 止まってしまったように見えてしまう。
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
                  // カルテがまだ来ていないときに「今日のカルテ」を押させると、
                  // 出すものが無くてホームへ弾かれる。取りに行くボタンに変える。
                  FadeSlideIn.staggered(
                    index: 6,
                    child: waiting
                        ? Column(
                            children: <Widget>[
                              // 押せないボタンだけを置かない。文言の変わらない
                              // 無効なボタンが出ていると、待っているのか
                              // 壊れたのかが読めない。何を待っているのかを言う。
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
                  // カルテを待っているあいだの逃げ道。この画面は戻る先を持たない
                  // ので、待つ以外にできることが無いと行き止まりになる。
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
