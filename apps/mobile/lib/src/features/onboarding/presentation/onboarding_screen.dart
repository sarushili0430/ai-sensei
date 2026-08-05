import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';

/// オンボーディング(初回のみ・2ページ)。
///
/// 1枚目は機能ではなく**約束**。「答えは教えません」を先に言い切ることで、
/// 既存の写真×数学アプリとの違いがここで立つ。
/// 2枚目でやることの全体像を見せる。4分間なにをするのか分からないまま
/// カメラを開かせない。
///
/// **権限はここで求めない。** カメラは撮る直前、マイクは会話の直前、
/// 通知は初回カルテで穴が見えた直後に、それぞれ文脈の中で聞く。
/// 初回離脱の最大要因を、まとめて先頭に置かないため。
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final PageController _controller = PageController();
  int _page = 0;

  static const int _pageCount = 2;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _isLast => _page == _pageCount - 1;

  Future<void> _next() async {
    if (!_isLast) {
      await _controller.nextPage(
        duration: AppDurations.reaction,
        curve: Curves.easeOut,
      );
      return;
    }
    await markOnboardingSeen(ref.read(preferencesProvider));
    if (mounted) context.go(AppRoute.home.path);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Expanded(
              child: PageView(
                controller: _controller,
                onPageChanged: (int page) => setState(() => _page = page),
                children: const <Widget>[_PromisePage(), _HowItWorksPage()],
              ),
            ),
            _Dots(count: _pageCount, current: _page),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.md,
                AppSpacing.lg,
                AppSpacing.lg,
              ),
              child: ChunkyButton(
                label: _isLast ? strings.onboardingCta : strings.onboardingNext,
                onPressed: _next,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 1枚目 — 約束。
class _PromisePage extends StatelessWidget {
  const _PromisePage();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
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
        ],
      ),
    );
  }
}

/// 2枚目 — やることの全体像と、権限の予告。
class _HowItWorksPage extends StatelessWidget {
  const _HowItWorksPage();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const Spacer(),
          Text(
            strings.onboardingHowTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: AppSpacing.xl),
          _Step(index: 1, icon: Icons.photo_camera_outlined, label: strings.onboardingStepCapture),
          _Step(index: 2, icon: Icons.help_outline, label: strings.onboardingStepAsked),
          _Step(index: 3, icon: Icons.mic_none_outlined, label: strings.onboardingStepExplain),
          _Step(index: 4, icon: Icons.description_outlined, label: strings.onboardingStepKarte),
          const Spacer(),
          Text(
            strings.onboardingPermissionNote,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md),
        ],
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.index, required this.icon, required this.label});

  final int index;
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    // 4番目だけ色を変える。ここが持ち帰るもの(カルテ)だと分かるように。
    final Color tint = index == 4 ? AppColors.hole : AppColors.blue;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Row(
        children: <Widget>[
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: tint.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(AppRadius.button),
            ),
            child: Icon(icon, size: 20, color: tint),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Text(label, style: Theme.of(context).textTheme.bodyLarge),
          ),
        ],
      ),
    );
  }
}

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.current});

  final int count;
  final int current;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < count; i++)
          AnimatedContainer(
            duration: AppDurations.tap,
            margin: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
            width: i == current ? 20 : 8,
            height: 8,
            decoration: BoxDecoration(
              color: i == current ? AppColors.blue : AppColors.border,
              borderRadius: BorderRadius.circular(AppRadius.chip),
            ),
          ),
      ],
    );
  }
}
