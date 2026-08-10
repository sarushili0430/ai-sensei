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

/// お礼の言い方。**「ご購入ありがとうございます」と書けない場合がある。**
enum ThanksKind {
  /// 買った。素直にお礼を言っていい唯一のケース。
  purchased,

  /// 無料トライアルが始まった。まだ1円も払っていないので、
  /// お礼を言うと事実として嘘になる(handoff §6)。
  trial,

  /// 機種変更などで復元した。買い直していないので、お礼を言うと
  /// 二重に払ったのかと思わせる。
  restored,
}

/// 購入のお礼(ペイウォールの直後)。
///
/// ここが無いあいだ、購入が通ると**画面が閉じるだけ**だった。お金を払った
/// 瞬間にアプリが何も言わないのは、いちばん安く直せる不親切なので埋める。
///
/// 祝福画面と同じ文法(紙吹雪 + 先輩のはずみ)で作る。にぎやかにするのは
/// **ここ1回だけ**で、カルテと復習には祝いの色を持ち込まない(handoff §7)。
///
/// 決済は通ったが entitlement が付いていない場合は、そもそもここへ来ない
/// (ルータが弾く)。祝ってから使えないのが、いちばん落差が大きい。
class ThanksScreen extends ConsumerWidget {
  const ThanksScreen({this.restored = false, super.key});

  /// 復元で来たか。**購入かトライアルかは渡さない** — それは entitlement が
  /// 知っているので、画面とSDKで別々の事実を持たないようにする。
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

    // 期限が読めないと、更新日も無料期間の残りも言えない。
    // 数を騙るくらいなら黙るので、ここから下はすべて null を許す。
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

    // 自動更新であることは、祝っている画面でも省かない(Guideline 3.1.2)。
    // トライアルは本文で課金開始日を言い切っているので、ここでは繰り返さない。
    final String note = kind == ThanksKind.purchased && date != null
        ? strings.thanksRenewsOn(date)
        : strings.thanksCancelAnytime;

    return Scaffold(
      backgroundColor: AppColors.celebration,
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

/// 解放されたもの。
///
/// 「Premiumになりました」だけだと、何が変わったのか分からないまま
/// ホームへ戻ることになる。ペイウォールの比較表と**同じ3つを同じ順で**出して、
/// 売り文句と受け取ったものを突き合わせられるようにする。
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
