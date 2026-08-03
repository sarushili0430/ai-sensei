import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// ホーム。数えるのは連続日数と「埋めた穴」だけ(handoff §7)。
/// XP・レベル・ランクは出さない。
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<Progress> progress = ref.watch(progressControllerProvider);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _CounterRow(progress: progress.value ?? Progress.empty),
              const Spacer(),
              const Center(child: KohaiFace(mood: KohaiMood.neutral, size: 140)),
              const SizedBox(height: AppSpacing.lg),
              Text(
                strings.homeGreeting,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const Spacer(),
              ChunkyButton(
                label: strings.homeCapture,
                onPressed: () => context.go(AppRoute.capture.path),
              ),
              const SizedBox(height: AppSpacing.sm),
              GhostButton(
                label: strings.reviewTitle,
                onPressed: () => context.go(AppRoute.review.path),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CounterRow extends StatelessWidget {
  const _CounterRow({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        _Counter(
          value: progress.streakDays,
          label: strings.streakDays(progress.streakDays),
          color: AppColors.streak,
        ),
        _Counter(
          value: progress.filledHoles,
          label: strings.filledHoles(progress.filledHoles),
          color: AppColors.blue,
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
          Text(
            '$value',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(color: color),
          ),
          const SizedBox(width: AppSpacing.xs),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}
