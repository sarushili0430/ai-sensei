import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../karte/application/karte_controllers.dart';
import '../../karte/domain/karte.dart';

/// 祝福画面(説明中とカルテの間)。
///
/// **にぎやかな画面**。ただし数えるのは連続日数と「埋めた穴」だけで、
/// 点数・正誤・XPは出さない(handoff §7)。
class CelebrationScreen extends ConsumerWidget {
  const CelebrationScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Progress progress = ref.watch(progressControllerProvider).valueOrNull ?? Progress.empty;
    final Karte? karte = ref.watch(latestKarteProvider);
    final int filledThisSession = karte == null
        ? 0
        : karte.holes.where((Hole it) => it.status == HoleStatus.filled).length;

    return Scaffold(
      backgroundColor: AppColors.streak.withValues(alpha: 0.08),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const KohaiFace(mood: KohaiMood.delighted, size: 160),
              const SizedBox(height: AppSpacing.xl),
              Text(
                filledThisSession > 0
                    ? strings.celebrationFilled(filledThisSession)
                    : strings.celebrationThanks,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.displaySmall,
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                strings.streakDays(progress.streakDays),
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: AppColors.streak),
              ),
              const SizedBox(height: AppSpacing.xl),
              ChunkyButton(
                label: strings.karteTitle,
                onPressed: () => context.go(AppRoute.karte.path),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
