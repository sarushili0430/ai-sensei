import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// ホーム。
///
/// ここは**ハブ**であって、カメラの起動ボタンではない。置くのは3つだけ:
///   - 数えているもの(連続日数と埋めた穴。XP・レベル・ランクは出さない — handoff §7)
///   - 今日やること(撮る)と、きのうの続き(埋めていない穴)
///   - 今日あと何回撮れるか(事実だけ。煽らない — §6)
///
/// タブバーは置かない。常設タブに値するのはこの画面だけで、カルテは
/// セッション直後にだけ意味を持つ一過性の画面だから(タブにすると空タブになる)。
/// 設定は右上に逃がす。
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ProgressSummary> summary = ref.watch(progressControllerProvider);
    final ProgressSummary data = summary.value ?? ProgressSummary.empty;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              FadeSlideIn(child: _TopRow(progress: data.progress)),
              const Spacer(),
              const FadeSlideIn(
                child: Center(child: KohaiFace(mood: KohaiMood.neutral, size: 140)),
              ),
              const SizedBox(height: AppSpacing.lg),
              FadeSlideIn.staggered(
                index: 1,
                child: Text(
                  strings.homeGreeting,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              const Spacer(),
              FadeSlideIn.staggered(index: 2, child: _OpenHolesCard(progress: data.progress)),
              const SizedBox(height: AppSpacing.md),
              FadeSlideIn.staggered(
                index: 3,
                child: ChunkyButton(
                  label: strings.homeCapture,
                  onPressed: () => context.push(AppRoute.capture.path),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              FadeSlideIn.staggered(index: 4, child: _RemainingLine(summary: data)),
            ],
          ),
        ),
      ),
    );
  }
}

class _TopRow extends StatelessWidget {
  const _TopRow({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Row(
      children: <Widget>[
        _Counter(
          value: progress.streakDays,
          label: strings.streakDays(progress.streakDays),
          color: AppColors.streak,
        ),
        const SizedBox(width: AppSpacing.md),
        _Counter(
          value: progress.filledHoles,
          label: strings.filledHoles(progress.filledHoles),
          color: AppColors.blue,
        ),
        const Spacer(),
        IconButton(
          onPressed: () => context.push(AppRoute.settings.path),
          icon: const Icon(Icons.settings_outlined, size: 22),
          color: AppColors.inkMuted,
          tooltip: strings.settingsTitle,
        ),
      ],
    );
  }
}

/// きのうの続き。再訪の起点で、通知の着地先でもある。
///
/// 穴がゼロのときは代わりに「最初の1枚から始まる」と書く。
/// 初回起動のホームが、押すもののない空白にならないように。
class _OpenHolesCard extends StatelessWidget {
  const _OpenHolesCard({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    if (progress.openHoles == 0) {
      return Text(
        strings.homeFirstRun,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall,
      );
    }

    return GestureDetector(
      onTap: () => context.push(AppRoute.review.path),
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.card),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: <Widget>[
            Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(color: AppColors.hole, shape: BoxShape.circle),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(strings.reviewTitle, style: Theme.of(context).textTheme.titleMedium),
                  Text(
                    strings.openHoles(progress.openHoles),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: AppColors.inkMuted),
          ],
        ),
      ),
    );
  }
}

/// 今日あと何回撮れるか。撮ってから断らないために、先に出しておく。
class _RemainingLine extends StatelessWidget {
  const _RemainingLine({required this.summary});

  final ProgressSummary summary;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final int? remaining = summary.limits.remainingSessionsToday;

    // Premium は無制限。ここに何も足さない(契約の管理は設定にある)。
    if (remaining == null) return const SizedBox(height: AppSpacing.md);

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        Text(
          remaining > 0 ? strings.remainingSessions(remaining) : strings.remainingSessionsNone,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        TextButton(
          onPressed: () => context.push(AppRoute.paywall.path),
          style: TextButton.styleFrom(
            foregroundColor: AppColors.blue,
            visualDensity: VisualDensity.compact,
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
          ),
          child: Text(strings.homeUnlock, style: Theme.of(context).textTheme.bodySmall),
        ),
      ],
    );
  }
}

class _Counter extends StatelessWidget {
  const _Counter({required this.value, required this.label, required this.color});

  final int value;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      child: Row(
        children: <Widget>[
          // 数えているのはこの2つだけ(連続日数と埋めた穴)。
          // 増えたことが見えるように、0から数え上げる。
          CountUpText(
            value,
            style: Theme.of(context).textTheme.titleLarge?.copyWith(color: color),
          ),
          const SizedBox(width: AppSpacing.xs),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}
