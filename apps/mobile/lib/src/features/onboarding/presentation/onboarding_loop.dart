import 'package:flutter/material.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/entrance.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import 'onboarding_motion.dart';

/// コアループ(ADR 0009)の全体像と、権限の予告。
///
/// 4行は「撮る → 先輩が板書つきで教える →『わかった』を押す →
/// その板書から復習問題が1問できて、3日後と7日後に届く」。
/// **復習問題の出どころが4行目にある**のが要で、ここが「質問した内容をメモ」に
/// 化けると、3/7日の再訪の根拠(ADR 0009)ごと崩れる。
///
/// 手順は [RevealTrail] に渡してある。**線が上から引かれて、届いた印だけが
/// 現れる。**1周が1本道であることを、読む前に形で見せるため
/// (最後の枚の年表も同じ絵にしてあるので、後半が別の話に見えない)。
class OnboardingLoopPage extends StatelessWidget {
  const OnboardingLoopPage({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextStyle? body = Theme.of(context).textTheme.bodyLarge;

    // 手順の文が長くなったぶん、小さい端末の英語では4行目から先が切れていた。
    // **切れてはいけないのが最後の1行**なので、スクロールできる形にする。
    return CenteredScroll(
      children: <Widget>[
        FadeSlideIn(
          child: Text(
            strings.onboardingHowTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: AppSpacing.xl),
        RevealTrail(
          // 見出しが読まれるぶんだけ待ってから引き始める。
          delay: AppDurations.stagger * 2,
          nodes: <TrailNode>[
            TrailNode(
              icon: Icons.photo_camera_outlined,
              tint: AppColors.blue,
              child: Text(strings.onboardingStepCapture, style: body),
            ),
            // 2番目は「書きながら教える」。ペン先のアイコンにしてあるのは、
            // 板書が飾りではなくこのループの一手だと1行目で分かるようにするため。
            TrailNode(
              icon: Icons.draw_outlined,
              tint: AppColors.blue,
              child: Text(strings.onboardingStepTaught, style: body),
            ),
            // 3番目だけ「押す」。**授業を終わらせるのは生徒**(ADR 0009)なので、
            // ここだけ手が出る絵にしてある。色は祝福と同じ橙
            // (蛍光マーカーの黄は紙の上でしか読めない — 白地の印には薄すぎる)。
            TrailNode(
              icon: Icons.check_circle_outline,
              tint: AppColors.streak,
              child: Text(strings.onboardingStepUnderstood, style: body),
            ),
            // 4番目が持ち帰るもの。色を変えて、ここが**次に会う場所**だと分かるように。
            TrailNode(
              icon: Icons.notifications_none,
              tint: AppColors.hole,
              child: Text(strings.onboardingStepPractice, style: body),
            ),
          ],
        ),
      ],
    );
  }
}
