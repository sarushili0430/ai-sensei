import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';

/// オンボーディング。
///
/// 最初に伝えるのは機能ではなく**約束**。
/// 「答えは教えません」を先に言い切ることで、既存の写真×数学アプリとの違いが立つ。
class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Spacer(),
              const Center(child: KohaiFace(mood: KohaiMood.puzzled, size: 140)),
              const SizedBox(height: AppSpacing.xl),
              Text(
                strings.onboardingTitle,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.displaySmall,
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                strings.onboardingBody,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const Spacer(),
              ChunkyButton(
                label: strings.onboardingCta,
                onPressed: () async {
                  await markOnboardingSeen(ref.read(preferencesProvider));
                  if (context.mounted) context.go(AppRoute.home.path);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
