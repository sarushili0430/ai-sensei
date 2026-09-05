import 'package:flutter/material.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import 'onboarding_motion.dart';

/// 1枚目 — 約束。
///
/// **機能ではなく約束から始める**(ADR 0004)。約束は ADR 0009 で
/// 「教える。そのあと教え返してもらう」から
/// **「わかったと言えるまで教える。3日後に、ほんとうにそうか聞く」**に替わった。
/// 前半だけなら手元の無料AIと同じに見えるので、後半まで含めて1つの約束。
///
/// **`Spacer` で中央に置いた `Column` ではなく [CenteredScroll]。**
/// 約束は前後2拍あるぶん長く、英語を 375pt 幅の端末に流すと見出しだけで
/// 画面を食い切って下がはみ出す。はみ出した `Column` は中身を切り落とすので、
/// 「収まれば中央・収まらなければスクロール」に揃えてある。
class OnboardingPromisePage extends StatelessWidget {
  const OnboardingPromisePage({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return CenteredScroll(
      children: <Widget>[
        // 顔の後ろでゆっくり息をする光。**顔と同じ周期**なので、
        // 動きが2つに割れて見えない([AmbientHalo])。
        //
        // 光の直径は顔の1.4倍まで。既定(260)のままだと、**375×667 の英語で
        // 約束の3行目が折り返しの下に落ちた**(実測)。約束は読ませる枚なので、
        // 光のために本文を追い出さない。
        const FadeSlideIn(
          child: Center(
            child: AmbientHalo(
              size: 200,
              child: SenpaiFace(mood: SenpaiMood.neutral, size: 140),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.xl),
        FadeSlideIn.staggered(
          index: 1,
          child: Text(
            strings.onboardingTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.displaySmall,
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn.staggered(
          index: 2,
          child: Text(
            strings.onboardingBody,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      ],
    );
  }
}
