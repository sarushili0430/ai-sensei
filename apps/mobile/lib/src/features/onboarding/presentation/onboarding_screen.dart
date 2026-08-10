import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import 'onboarding_karte_preview.dart';
import 'onboarding_rehearsal.dart';

/// オンボーディング(初回のみ・4ページ)。
///
/// 1枚目は機能ではなく**約束**。ピボット計画 §0 の憲法改正で、この約束は
/// 「答えを教えない」から**「教える。そのあと教え返してもらう」**に変わった。
/// 機能ではなく約束を先に言い切る、という設計意図はそのまま引き継いでいる
/// (「教える」だけなら手元の無料AIと同じに見えるので、後半まで含めて1つの約束)。
/// 2枚目でコアループ(§2)の全体像を見せる。何をする時間なのか分からないまま
/// カメラを開かせない。
///
/// 3枚目と4枚目は**やってみる枚**。
/// 約束は、読むだけでは腑に落ちない(inception-deck §7-7 が
/// 「答えを教えない」について指摘していた問題。改正後も構造は同じで、
/// **言葉を足すほど遠くなる**)。だから説明を増やすのではなく、
/// 教わって・教え返して(または言えなくて)・カルテに残る、までを1往復させる。
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
///
/// **`Spacer` で中央に置いた `Column` から [CenteredScroll] に替えてある。**
/// 改正後の約束は前後2拍あるぶん長く、英語(`The AI tutor that teaches you —
/// then asks you to teach it back.`)を 375pt 幅の端末に流すと、
/// 見出しだけで画面を食い切って**下がはみ出す**(実測で確認)。
/// はみ出した `Column` は中身を切り落とすので、
/// 3・4枚目と同じ「収まれば中央・収まらなければスクロール」に揃える。
class _PromisePage extends StatelessWidget {
  const _PromisePage();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return CenteredScroll(
      children: <Widget>[
        // 困り顔(`puzzled`)は「教わる側」の表情だった。配役が先輩に変わって
        // ここは教える側の顔になるので、待っている顔で置く。
        // 顔ウィジェットそのものの刷新は横断的なので別タスク。
        const FadeSlideIn(
          child: Center(child: SenpaiFace(mood: SenpaiMood.neutral, size: 140)),
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

/// 2枚目 — コアループ(計画書§2)の全体像と、権限の予告。
///
/// 4行は「撮る → 先輩が板書つきで教える → 教え返す → 詰まったところが穴として残る」。
/// **穴の出どころが4行目にある**のが要で、ここが「質問した内容をメモ」に
/// 化けると、1/3/7日の再訪の根拠(§1-3)ごと崩れる。
class _HowItWorksPage extends StatelessWidget {
  const _HowItWorksPage();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    // 1枚目と同じ理由で [CenteredScroll]。手順の文が長くなったぶん、
    // 小さい端末の英語では4行目(穴の出どころ)から先が切れていた。
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
        _Step(index: 1, icon: Icons.photo_camera_outlined, label: strings.onboardingStepCapture),
        // 2番目は「書きながら教える」。ペン先のアイコンにしてあるのは、
        // 板書が飾りではなくこのループの一手だと1行目で分かるようにするため。
        _Step(index: 2, icon: Icons.draw_outlined, label: strings.onboardingStepTaught),
        _Step(index: 3, icon: Icons.mic_none_outlined, label: strings.onboardingStepExplain),
        _Step(index: 4, icon: Icons.description_outlined, label: strings.onboardingStepKarte),
        // `Spacer` で画面下へ押し付けるのはやめた(スクロールの中では使えない)。
        // 権限の予告は手順のすぐ下、同じかたまりの一部として置く。
        const SizedBox(height: AppSpacing.lg),
        Text(
          strings.onboardingPermissionNote,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
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
