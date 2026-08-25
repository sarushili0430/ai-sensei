import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../notifications/application/push_controller.dart';
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
///   6. **これから** — 今日 / 3日後 / 7日後の年表
///
/// 4・5枚目は**やってみる枚**。約束は読むだけでは腑に落ちない
/// (inception-deck §7-7 が指摘していた問題。**言葉を足すほど遠くなる**)。
/// だから説明を増やすのではなく、1周を通す。台本は固定で、写真も声も
/// 使わないので、枚をめくっているあいだは何の権限も要らない。
///
/// ## 通知だけは、ここで聞く
///
/// カメラは撮る直前、マイクは会話の直前 —— これは変わらない。
/// **通知だけを [_finish] で聞く**([ADR 0004] の追記)。理由は2つ:
///
///   - **このアプリの再訪は、全部通知が起点。**3日後・7日後に届かなければ、
///     コアループの後半(ADR 0009)はそもそも始まらない
///   - **文脈がいちばん立っているのがここ。**直前の2枚で通知が届くところを
///     実際に見て、最後の枚で「3日後 / 7日後」の年表を読んだ直後に聞く。
///     設定画面のトグルまで自分で辿り着く人を待つより、ここのほうが近い
///
/// iOSはシステムダイアログを一度しか出せないので、**聞く場所は1つに絞る**。
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

  /// 関門つきの物理。**インスタンスは1つだけ作って使い回す。**
  ///
  /// `Scrollable` は物理を**型でしか比べない**(`_shouldUpdatePosition`)ので、
  /// 毎ビルド新しいインスタンスを渡しても、`ScrollPosition` が握っているのは
  /// 最初の1個のまま。関門の開閉を引数で渡すと**永遠に反映されない**ので、
  /// 状態は関数越しに読ませる。
  late final _GateScrollPhysics _physics = _GateScrollPhysics(
    lockedPage: () => _canAdvance ? null : _page,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 落ちどめ。**物理で止まっているはずのものを、位置でもう一度確かめる。**
  ///
  /// 読み上げの「次へスクロール」など、指以外の経路でページが動く道は
  /// 増えうる。関門の内側に居ることは画面の不変条件なので、
  /// 破れていたら止められた最初の枚へ戻す。
  void _onPageChanged(int page) {
    setState(() => _page = page);
    if (_canReach(page)) return;

    // 通知はスクロールの最中に来る。その場で位置を動かすと同じフレームで
    // 自分をやり直すことになるので、次のフレームに送る。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _canReach(_page)) return;
      int blocked = _page;
      while (blocked > 0 && !_canReach(blocked)) {
        blocked--;
      }
      _controller.jumpToPage(blocked);
    });
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

  /// [page] まで行ってよいか —— **手前の関門がぜんぶ開いているか。**
  ///
  /// **ボタンではなく位置で持つ。**「つぎへ」を無効にするだけでは、横に
  /// スワイプして関門を素通りできてしまう(`PageView` はボタンと関係なく
  /// 指で動く)。学年を選ばずに抜けられると、中学生が黙って高校の単元を
  /// 候補にされたまま本編に入る — 既定が高校生なので、**素通りがいちばん悪い**。
  /// だから通れる場所そのものをここで定義して、ボタンと指の両方に同じ判定を配る。
  ///
  /// **どれも行き止まりにはしない。**学年はどちらを選んでも同じ1タップで通り、
  /// リハーサルは一手押すだけ、復習は書く→こたえるの2タップ。
  /// やってみる枚からは、上の「とばす」でいつでも降りられる。
  /// 手前の枚へ**戻る**のはいつでも自由(関門は進む向きにしか無い)。
  bool _canReach(int page) {
    if (_asksStage && page > _stagePage && _stage == null) return false;
    if (page > _lessonPage && !_understood) return false;
    if (page > _practicePage && !_answered) return false;
    return true;
  }

  bool get _canAdvance => _canReach(_page + 1);

  bool get _canSkip => _page >= _lessonPage;

  /// 下の「つぎへ」を出すか。
  ///
  /// **枚が自分の一手を持っているあいだは出さない。**復習のリハーサルは
  /// 「開いてみる」→「こたえる」と自前のボタンが下に座るので、その真下に
  /// 押せない「つぎへ」を並べると、**どちらが今の一手なのか分からなくなる**
  /// (押せないボタンは、置いてあるだけで「ここが行き止まりか」と読ませる)。
  /// 採点まで通れば枚の仕事は終わりなので、そこで戻す。
  bool get _showNext => _page != _practicePage || _answered;

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

  /// オンボーディングを終える。**出口はここ1つ**(「はじめる」も「とばす」も通る)。
  ///
  /// 通知の許可はこの1箇所でだけ聞く(クラスの説明)。**断られても止めない** ——
  /// 許可が無くてもアプリは動くし、あとから設定で入れ直せる。
  /// 通知を扱えないビルド(App ID の無いテスト/CI)では
  /// [PushPermissionController.request] がその場で false を返して何も起きない。
  Future<void> _finish() async {
    await markOnboardingSeen(ref.read(preferencesProvider));
    await ref.read(pushPermissionControllerProvider.notifier).request();
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
                // 指でも関門を越えられないようにする([_GateScrollPhysics])。
                physics: _physics,
                onPageChanged: _onPageChanged,
                itemBuilder: (BuildContext context, int index) =>
                    _PageTransition(controller: _controller, index: index, child: pages[index]),
              ),
            ),
            if (_showNext)
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
              )
            else
              // 「つぎへ」を出していないあいだも、枚の一手が画面の縁に
              // 貼り付かないぶんだけ下を空ける。
              const SizedBox(height: AppSpacing.lg),
          ],
        ),
      ),
    );
  }
}

/// 関門より先へは指を通さないスクロール物理。
///
/// **前へだけ止める。**戻るのはいつでも自由なので、下限側は親に任せて、
/// 上限側だけを「いまの枚の先頭」で頭打ちにする。指は動くが越えられない —
/// 完全に固めてしまう(`NeverScrollableScrollPhysics`)と、**戻る手段が
/// 画面から消える**(この画面に戻るボタンは無く、スワイプだけが道)。
///
/// 関門の開閉は [lockedPage] を**毎回呼んで**読む。コンストラクタ引数で
/// 渡すと、`ScrollPosition` が最初のインスタンスを握り続けるせいで
/// 開いたことが伝わらない([_OnboardingScreenState._physics] の説明)。
class _GateScrollPhysics extends ScrollPhysics {
  const _GateScrollPhysics({required this.lockedPage, super.parent});

  /// これ以上進めない枚(0始まり)。関門が開いていれば null。
  final ValueGetter<int?> lockedPage;

  @override
  _GateScrollPhysics applyTo(ScrollPhysics? ancestor) =>
      _GateScrollPhysics(lockedPage: lockedPage, parent: buildParent(ancestor));

  @override
  double applyBoundaryConditions(ScrollMetrics position, double value) {
    final int? locked = lockedPage();
    if (locked != null) {
      // `viewportFraction` は既定の1なので、枚の先頭 = 番号 × 画面幅。
      final double limit = locked * position.viewportDimension;
      // 越えたぶんを「はみ出し」として返すと、そこで頭打ちになる。
      if (value > limit && position.pixels <= limit) return value - limit;
    }
    return super.applyBoundaryConditions(position, value);
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
