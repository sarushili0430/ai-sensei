import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import 'onboarding_karte_preview.dart';
import 'onboarding_rehearsal.dart';

/// オンボーディング(初回のみ・4ページ)。
///
/// 1枚目は機能ではなく**約束**。「答えは教えません」を先に言い切ることで、
/// 既存の写真×数学アプリとの違いがここで立つ。
/// 2枚目でやることの全体像を見せる。4分間なにをするのか分からないまま
/// カメラを開かせない。
///
/// 3枚目と4枚目は**やってみる枚**。
/// 「答えを教えない」は、読むと不便に聞こえる(inception-deck §7-7)。
/// 言葉で否定するほど不便に見えるので、説明を増やすのではなく、
/// 質問されて・言えて/言えなくて・カルテに残る、までを1往復させる。
/// 台本は固定で、写真も声も使わないので、ここではまだ何の権限も要らない。
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
  RehearsalOutcome? _outcome;

  static const int _pageCount = 4;

  /// リハーサルの枚。ここだけ、先に進むボタンが操作待ちになる。
  static const int _rehearsalPage = 2;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _isLast => _page == _pageCount - 1;

  /// リハーサルは「説明する」か「うまく言えない」のどちらかを通ってほしい。
  /// どちらでも先へ進めるので行き止まりにはならないし、
  /// 上の「とばす」でいつでも降りられる。
  bool get _canAdvance => _page != _rehearsalPage || _outcome != null;

  Future<void> _next() async {
    if (_isLast) {
      await _finish();
      return;
    }

    // 動かさない設定では、めくらずに切り替える
    // (`nextPage` は長さ0を受け付けない)。
    final Duration duration = AppMotion.decorative(context, AppDurations.reaction);
    if (duration == Duration.zero) {
      _controller.jumpToPage(_page + 1);
      return;
    }
    await _controller.nextPage(duration: duration, curve: AppCurves.enter);
  }

  Future<void> _finish() async {
    await markOnboardingSeen(ref.read(preferencesProvider));
    if (mounted) context.go(AppRoute.home.path);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    final List<Widget> pages = <Widget>[
      const _PromisePage(),
      const _HowItWorksPage(),
      OnboardingRehearsalPage(
        outcome: _outcome,
        onOutcome: (RehearsalOutcome? outcome) => setState(() => _outcome = outcome),
      ),
      OnboardingKartePreviewPage(outcome: _outcome),
    ];

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            SizedBox(
              height: 40,
              child: Align(
                alignment: Alignment.centerRight,
                // 約束(1枚目)とやること(2枚目)は飛ばさせない。
                // デッキが期待値の設計をこの2枚に置いているので、
                // 出口を作るのはあとから足した2枚から。
                child: AnimatedOpacity(
                  opacity: _page >= _rehearsalPage ? 1 : 0,
                  duration: AppMotion.decorative(context, AppDurations.reaction),
                  child: TextButton(
                    onPressed: _page >= _rehearsalPage ? _finish : null,
                    style: TextButton.styleFrom(foregroundColor: AppColors.inkMuted),
                    child: Text(strings.onboardingSkip),
                  ),
                ),
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: pages.length,
                onPageChanged: (int page) => setState(() => _page = page),
                itemBuilder: (BuildContext context, int index) =>
                    _PageTransition(controller: _controller, index: index, child: pages[index]),
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
                onPressed: _canAdvance ? _next : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// めくっている最中だけ、隣のページを少し縮めて薄くする。
///
/// 横に動いていることが指の下で分かるようにするための演出で、
/// 止まっている状態(= golden で撮る状態)には何の影響もない。
class _PageTransition extends StatelessWidget {
  const _PageTransition({required this.controller, required this.index, required this.child});

  final PageController controller;
  final int index;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (AppMotion.isReduced(context)) return child;

    return AnimatedBuilder(
      animation: controller,
      builder: (BuildContext context, Widget? child) {
        // 初回ビルドではまだ寸法が無い。そのときは静止状態として扱う。
        final double page = controller.hasClients && controller.position.haveDimensions
            ? (controller.page ?? index.toDouble())
            : index.toDouble();
        final double distance = (page - index).abs().clamp(0.0, 1.0);

        return Opacity(
          opacity: 1 - 0.5 * distance,
          child: Transform.scale(scale: 1 - 0.05 * distance, child: child),
        );
      },
      child: child,
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
          const FadeSlideIn(
            child: Center(child: KohaiFace(mood: KohaiMood.puzzled, size: 140)),
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
          FadeSlideIn(
            child: Text(
              strings.onboardingHowTitle,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
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
    final bool isLast = index == 4;
    final Color tint = isLast ? AppColors.hole : AppColors.blue;

    return FadeSlideIn.staggered(
      index: index,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Column(
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
                // 次の手順へ続く線。1周であることが縦に見える。
                if (!isLast) Expanded(child: Container(width: 2, color: AppColors.border)),
              ],
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm, bottom: AppSpacing.md),
                child: Text(label, style: Theme.of(context).textTheme.bodyLarge),
              ),
            ),
          ],
        ),
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
            duration: AppMotion.decorative(context, AppDurations.reaction),
            curve: AppCurves.enter,
            margin: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
            width: i == current ? 20 : 8,
            height: 8,
            decoration: BoxDecoration(
              // 通ってきた枚は薄く残す。あと何枚あるかが見えるように。
              color: switch (i) {
                _ when i == current => AppColors.blue,
                _ when i < current => AppColors.blue.withValues(alpha: 0.35),
                _ => AppColors.border,
              },
              borderRadius: BorderRadius.circular(AppRadius.chip),
            ),
          ),
      ],
    );
  }
}
