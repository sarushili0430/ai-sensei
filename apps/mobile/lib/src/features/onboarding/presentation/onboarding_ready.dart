import 'package:flutter/material.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import 'onboarding_motion.dart';

/// 最後の枚 — これから起きること。
///
/// **間隔反復そのものが製品機能**(デッキ §9 の OneSignal 賞の根拠)なので、
/// 文字で説明せず、**線と点で「また来る」ことを見せる**。Mobbin の
/// 「トライアルの流れ(今日 / 5日目 / 7日目)」と同じ縦の年表で、
/// やることの枚([OnboardingLoopPage])と**同じ絵**にしてある —
/// 途中で図法が変わると、後半が別の話に見える。
///
/// 段は ADR 0009 のとおり:
///   - **作った直後は 3・7日**(= 正解と同じ扱い)。「わかった」は到達の宣言なので、
///     押した翌日に「まちがえた問題」と同じ間隔で届くと、押したこと自体が罰になる
///   - **まちがえた問題だけ、翌日からもう一度**。減点はしない
class OnboardingReadyPage extends StatelessWidget {
  const OnboardingReadyPage({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextTheme text = Theme.of(context).textTheme;

    Widget row(String title, String note) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(title, style: text.titleMedium),
            const SizedBox(height: 2),
            Text(note, style: text.bodySmall),
          ],
        );

    return CenteredScroll(
      children: <Widget>[
        const SizedBox(height: AppSpacing.md),
        // ここまで来た人に向ける顔。**この枚だけ `delighted`** —
        // 1周やってみた直後なので、労うのが自然な位置になる。
        // 顔は小さめに。**この枚は下に年表と注記が2本ぶら下がる**ので、
        // 顔を大きくすると 375×667 の英語で「減点はしません」と権限の予告が
        // 折り返しの下に落ちる(実測)。
        const FadeSlideIn(
          child: Center(
            child: AmbientHalo(
              color: AppColors.streak,
              size: 140,
              child: SenpaiFace(mood: SenpaiMood.delighted, size: 88),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        FadeSlideIn.staggered(
          index: 1,
          child: Text(
            strings.onboardingReadyTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        RevealTrail(
          delay: AppDurations.stagger * 3,
          // 1行に見出しと注記の2段が入るので、行間は詰める。
          rowGap: AppSpacing.sm,
          nodes: <TrailNode>[
            TrailNode(
              icon: Icons.photo_camera_outlined,
              tint: AppColors.blue,
              child: row(strings.onboardingTimelineToday, strings.onboardingTimelineTodayNote),
            ),
            TrailNode(
              icon: Icons.notifications_none,
              tint: AppColors.hole,
              child: row(strings.onboardingReviewDay3, strings.onboardingTimelineDay3Note),
            ),
            TrailNode(
              icon: Icons.event_repeat,
              tint: AppColors.hole,
              child: row(strings.onboardingReviewDay7, strings.onboardingTimelineDay7Note),
            ),
          ],
        ),
        // **まちがえた日の段も、同じ画面で言い切る。**あとから出すと、
        // 追加された罰のように読める。年表の最後の行にぶら下がって見えないよう、
        // ひと呼吸あける([RevealTrail] の最後の行は下の余白を持たない)。
        const SizedBox(height: AppSpacing.sm),
        Text(
          strings.onboardingTimelineWrongNote,
          textAlign: TextAlign.center,
          style: text.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
        // 権限の予告。ここが**最後に読まれる**位置なので、
        // 次の画面でカメラを開く直前の心づもりになる。
        Text(
          strings.onboardingPermissionNote,
          textAlign: TextAlign.center,
          style: text.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
      ],
    );
  }
}
