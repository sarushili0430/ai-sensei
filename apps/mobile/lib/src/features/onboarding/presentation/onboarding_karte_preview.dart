import 'package:flutter/material.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import 'onboarding_rehearsal.dart';

/// オンボーディング4枚目 — さっきのリハーサルが、カルテになって返ってくる。
///
/// ここで初めて「持ち帰るもの」が見える。3枚目で**教え返した / 詰まった**ことが
/// そのまま1行として残っているので、カルテが**自分の記録**だと分かる。
/// 教わった内容の要約ではない、というのがこの枚の要
/// (ピボット計画 §2「出題元はユーザーが説明した内容。AIが教えた内容から作らない」)。
///
/// リハーサルを飛ばしてきた人には見本として両方の色を見せる。
/// やっていないことを「やった」として書かない。
class OnboardingKartePreviewPage extends StatelessWidget {
  const OnboardingKartePreviewPage({required this.outcome, super.key});

  final RehearsalOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return CenteredScroll(
      children: <Widget>[
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn(
          child: Text(
            strings.onboardingKarteTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        FadeSlideIn.staggered(index: 1, child: _KarteCard(outcome: outcome)),
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn.staggered(
          index: 2,
          child: Text(
            strings.onboardingKarteBody,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        const SizedBox(height: AppSpacing.xl),
        FadeSlideIn.staggered(
          index: 3,
          child: Text(
            strings.onboardingReviewTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        const _ReviewTimeline(),
        const SizedBox(height: AppSpacing.xl),
        Text(
          strings.onboardingPermissionNote,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
      ],
    );
  }
}

class _KarteCard extends StatelessWidget {
  const _KarteCard({required this.outcome});

  final RehearsalOutcome? outcome;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // リハーサルをしていれば、その1行だけ。していなければ見本として両方。
    final List<(String, String, MarkerColor)> lines = switch (outcome) {
      RehearsalOutcome.explained => <(String, String, MarkerColor)>[
        (strings.karteSaidWell, strings.onboardingTrySaid, MarkerColor.said),
      ],
      RehearsalOutcome.passed => <(String, String, MarkerColor)>[
        (strings.karteHoles(1), strings.onboardingTryHole, MarkerColor.hole),
      ],
      null => <(String, String, MarkerColor)>[
        (strings.karteSaidWell, strings.onboardingTrySaid, MarkerColor.said),
        (strings.karteHoles(1), strings.onboardingTryHole, MarkerColor.hole),
      ],
    };

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
          Text(strings.karteTitle, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          for (int i = 0; i < lines.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: AppSpacing.md),
            Text(lines[i].$1, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.xs),
            // 上の行から順に引かれる。書かれていく順番が見えるように。
            MarkerText(
              lines[i].$2,
              marker: lines[i].$3,
              delay: AppDurations.reaction + AppDurations.draw * i,
            ),
          ],
        ],
      ),
    );
  }
}

/// 翌日・3日後・7日後。**間隔反復そのものが製品機能**(デッキ §9 の OneSignal 賞の根拠)
/// なので、文字で説明せず、線と点で「また来る」ことを見せる。
///
/// ピボット後もここは落とさない。再訪の起点は小テストに変わったが、
/// 出題元は**本人が説明した内容**のままなので、後付けの通知にはなっていない
/// (計画書 §2。有料か無料かはここでは主張しない — 1/3/7日の通知は
/// 原価が出ない側なので、§6-3 では無料枠に置かれている)。
class _ReviewTimeline extends StatelessWidget {
  const _ReviewTimeline();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final List<String> labels = <String>[
      strings.onboardingReviewTomorrow,
      strings.onboardingReviewDay3,
      strings.onboardingReviewDay7,
    ];

    return Column(
      children: <Widget>[
        SizedBox(
          height: 16,
          child: TweenAnimationBuilder<double>(
            tween: Tween<double>(begin: 0, end: 1),
            duration: AppMotion.decorative(context, AppDurations.celebrate),
            curve: AppCurves.enter,
            builder: (BuildContext context, double progress, Widget? child) =>
                CustomPaint(painter: _TimelinePainter(progress), size: Size.infinite),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        Row(
          children: <Widget>[
            for (int i = 0; i < labels.length; i++)
              Expanded(
                child: FadeSlideIn(
                  delay: AppDurations.stagger * (i * 2),
                  offset: 6,
                  child: Text(
                    labels[i],
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _TimelinePainter extends CustomPainter {
  const _TimelinePainter(this.progress);

  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    // 点は、下のラベル(3等分の中央)に合わせて 1/6・3/6・5/6 に置く。
    final List<double> stops = <double>[size.width / 6, size.width / 2, size.width * 5 / 6];
    final double y = size.height / 2;
    final double head = stops.first + (stops.last - stops.first) * progress;

    canvas.drawLine(
      Offset(stops.first, y),
      Offset(head, y),
      Paint()
        ..color = AppColors.border
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round,
    );

    for (final double x in stops) {
      if (x > head + 0.5) continue;
      canvas.drawCircle(Offset(x, y), 5, Paint()..color = AppColors.hole);
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter oldDelegate) => oldDelegate.progress != progress;
}
