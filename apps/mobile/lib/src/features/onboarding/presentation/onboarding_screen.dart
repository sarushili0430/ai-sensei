import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../settings/application/school_stage_controller.dart';
import 'onboarding_loop.dart';
import 'onboarding_motion.dart';
import 'onboarding_practice.dart';
import 'onboarding_promise.dart';
import 'onboarding_ready.dart';
import 'onboarding_rehearsal.dart';
import 'onboarding_stage.dart';

/// オンボーディング(初回のみ)。
///
/// ## 何を見せる枚なのか
///
/// **ADR 0009 でコアループが入れ替わったので、この画面も作り直してある。**
/// 教え返しとカルテは畳まれ、いまの1周は
/// 「撮る → 板書つきで教わる →『わかった』→ その板書から復習問題が1問 →
/// 3日後・7日後に届く → 書いて答える → AIが採点」。
/// 旧オンボーディングは前半しか見せておらず、**手元の無料AIとの差**である
/// 後半(3日後に聞きにいく)は文字の説明だけで終わっていた。
///
/// 枚の並び:
///
///   1. **約束** — 機能ではなく約束から([ADR 0004])。飛ばさせない
///   2. **学年**(日本語のみ)— 唯一「聞く」枚。答えが探す範囲を半分にする
///   3. **やること** — 1周を4手順の年表で
///   4. **授業のリハーサル** — 板書で教わって、「わかった」を押す
///   5. **復習のリハーサル** — 3日後の通知が届いて、書いて答えて、採点される
///   6. **これから** — 今日 / 3日後 / 7日後の年表と、権限の予告
///
/// 4・5枚目は**やってみる枚**。約束は読むだけでは腑に落ちない
/// (inception-deck §7-7 が指摘していた問題。**言葉を足すほど遠くなる**)。
/// だから説明を増やすのではなく、1周を通す。台本は固定で、写真も声も
/// 使わないので、ここではまだ何の権限も要らない。
///
/// **権限はここで求めない。** カメラは撮る直前、マイクは会話の直前、
/// 通知は初回の復習問題ができた直後に、それぞれ文脈の中で聞く。
/// 初回離脱の最大要因を、まとめて先頭に置かないため。
///
/// ## 進み具合は棒で出す
///
/// 点(旧 `_Dots`)から棒([OnboardingProgressBar])に替えた。枚数が増えたぶん
/// 「あとどれだけか」が見えないと最後まで連れていけない。Mobbin の学習アプリ
/// (Brilliant / Duolingo / Uxcel)が揃って上に置いているのもこの形。
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final PageController _controller = PageController();
  int _page = 0;

  /// 学年。**まだ選んでいない**のと「既定が入っている」を分けて持つ
  /// ([OnboardingStagePage] の説明)。
  SchoolStage? _stage;

  /// 授業のリハーサルで「わかった」を押したか。
  bool _understood = false;

  /// 復習のリハーサルで採点まで通ったか。
  bool _answered = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 学年を聞くのは日本語だけ。海外課程は段階で分かれていないので、
  /// 英語では**答えが何も変えない質問**になる([OnboardingStagePage])。
  bool get _asksStage => AppStrings.of(context).locale.languageCode == 'ja';

  /// 枚の中身。**並びと枚数はここだけが決める**(進み具合の棒も、
  /// 「とばす」を出し始める位置も、この並びから計算する)。
  List<Widget> _pages() {
    return <Widget>[
      const OnboardingPromisePage(),
      if (_asksStage)
        OnboardingStagePage(
          chosen: _stage,
          onSelected: (SchoolStage stage) => setState(() => _stage = stage),
        ),
      const OnboardingLoopPage(),
      OnboardingRehearsalPage(
        understood: _understood,
        onUnderstood: () => setState(() => _understood = true),
        onReset: () => setState(() => _understood = false),
      ),
      OnboardingPracticePage(
        answered: _answered,
        onAnswered: () => setState(() => _answered = true),
      ),
      const OnboardingReadyPage(),
    ];
  }

  int get _pageCount => _pages().length;

  /// やってみる枚(授業 → 復習)の位置。**ここから「とばす」を出す。**
  ///
  /// 約束(1枚目)とやること・学年は飛ばさせない。デッキが期待値の設計を
  /// 前半に置いているので、出口を作るのは操作待ちが始まってから。
  int get _stagePage => 1;
  int get _lessonPage => _asksStage ? 3 : 2;
  int get _practicePage => _lessonPage + 1;

  bool get _isLast => _page == _pageCount - 1;

  /// 操作待ちの枚だけ、先へ進むボタンが止まる。
  ///
  /// **どれも行き止まりにはしない。**学年はどちらを選んでも同じ1タップで通り、
  /// リハーサルは一手押すだけ、復習は書く→こたえるの2タップ。
  /// やってみる枚からは、上の「とばす」でいつでも降りられる。
  ///
  /// 学年だけ「とばす」を出さずに止めているのは、**既定(高校生)のまま
  /// 素通りされるのがいちばん悪い**から — 中学生が黙って高校の単元を
  /// 候補にされる。選択肢は2つで、どちらにも正解/不正解が無い。
  bool get _canAdvance {
    if (_asksStage && _page == _stagePage) return _stage != null;
    if (_page == _lessonPage) return _understood;
    if (_page == _practicePage) return _answered;
    return true;
  }

  bool get _canSkip => _page >= _lessonPage;

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
    final List<Widget> pages = _pages();

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.lg,
                AppSpacing.sm,
                AppSpacing.lg,
                0,
              ),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: OnboardingProgressBar(
                      value: (_page + 1) / pages.length,
                      label: strings.onboardingProgress(_page + 1, pages.length),
                    ),
                  ),
                  // 出口は棒の右。**幅は常に取っておく** —— 出た瞬間に
                  // 棒が縮むと、進んだのか戻ったのか分からなくなる。
                  SizedBox(
                    width: 72,
                    child: AnimatedOpacity(
                      opacity: _canSkip ? 1 : 0,
                      duration: AppMotion.decorative(context, AppDurations.reaction),
                      child: TextButton(
                        onPressed: _canSkip ? _finish : null,
                        style: TextButton.styleFrom(foregroundColor: AppColors.inkMuted),
                        child: Text(strings.onboardingSkip),
                      ),
                    ),
                  ),
                ],
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

/// めくっている最中だけ、隣のページを縮めて薄くし、中身を少し遅れて動かす。
///
/// 横に動いていることが指の下で分かるようにするための演出で、
/// 止まっている状態(= golden で撮る状態)には何の影響もない。
///
/// 中身をページ自身より**ゆっくり**動かす(視差)ことで、
/// 紙が重なって滑っているように見える。同じ速さで動くと、
/// ただ横に切り替わっただけの絵になる。
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
        final double delta = (page - index).clamp(-1.0, 1.0);
        final double distance = delta.abs();

        return Opacity(
          opacity: 1 - 0.6 * distance,
          child: Transform.translate(
            // 幅の 12% ぶんだけ置いていかれる。めくり終われば 0 に戻る。
            offset: Offset(delta * MediaQuery.sizeOf(context).width * 0.12, 0),
            child: Transform.scale(scale: 1 - 0.06 * distance, child: child),
          ),
        );
      },
      child: child,
    );
  }
}
