import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../session/domain/board.dart';
import '../../session/presentation/board/board_view.dart';

/// 板書が下に続いていることを示す帯([_BottomFade])の目印。
///
/// **出る / 出ないの出し分けそのものが仕様**(切れているのに手がかりが無いのが
/// いちばん悪い状態で、切れていないのに出続けるのは嘘)なので、
/// 見た目ではなくこの目印でテストできるようにしてある。
const Key onboardingBoardMoreBelowKey = Key('onboarding_board_more_below');

/// リハーサルの結果。
enum RehearsalOutcome {
  /// 教え返せた → 黄マーカー。
  explained,

  /// うまく言えなかった → ピンクのマーカー(= 穴)。**失敗ではない。**
  passed,
}

/// オンボーディング3枚目 — リハーサル。
///
/// 読んで分かった気になる説明を、**一度やってみる**に置き換える枚。
/// ここを通ると、初回の撮影ボタンを押す前に、
/// 「先輩が板書で教えてくれる」と「教え返せなかったことが残る」の両方を体験している。
///
/// **この1枚の主張は「答えが目の前にあっても、説明できるとは限らない」。**
/// 板書には結論(`解が2つ ⇔ D > 0`)まで書いてあり、隠していない。
/// それでも「なんで D を見るんだっけ?」には詰まる — そこが穴で、
/// 教えて終わりにしない理由そのもの(ピボット計画 §1-1「誤読の保険」と同じ構造)。
/// 改正前の「答えを出さない」を守るために質問だけを見せていたのを、
/// **答えを見せたうえで聞く**に作り替えてある。
///
/// 3つ守る:
///   - **繋がない。** 板書も質問も固定の台本で、LiveKitにもAPIにも触らない。
///   - **権限を要求しない。** マイクもカメラも使わない。録らないことは画面に書く。
///   - **正解にしない。** 教え返しても、パスしても、先へ進める。
///     どちらを選んだかで責めない(§0 の約束3。ここは改正されていない)。
///
/// ## 画面を「読む側」と「やる側」に割ってある
///
/// 板書を積んだぶん縦に伸び、375×667(SE級)では操作が折り返しの下に落ちた。
/// **操作が初期表示に無いことは、板書が全部見えないことより重い** —
/// 板書は切れていても「下に続く」と分かれば体験は壊れないが、操作が見えなければ
/// **やることがある枚だと気づかれないままスワイプされる**。この1枚は
/// 「読ませる枚」ではなく「やらせる枚」なので、そこで離脱されると存在理由が消える。
///
/// そこで上下に割った:
///   - **上(スクロールする)**: 見出し・撮った問題・板書。収まらなければここだけが動く
///   - **下(固定)**: 先輩の顔とふきだし・操作・録音しない注記
///
/// 顔とふきだしを固定側に入れているのは、**押しているあいだの手ごたえが顔だから**。
/// 長押し中は表情が `listening` に変わるので、顔が流れて見えなくなると
/// 「聞いてもらえている」という唯一のフィードバックが消える。
/// ふきだしの問いかけも、操作の意味そのものなので離さない。
class OnboardingRehearsalPage extends StatefulWidget {
  const OnboardingRehearsalPage({required this.outcome, required this.onOutcome, super.key});

  final RehearsalOutcome? outcome;

  /// 結果が決まった(または「もう一度ためす」で消えた)ときに親へ返す。
  /// 4枚目のカルテ見本が、この結果をそのまま使う。
  final ValueChanged<RehearsalOutcome?> onOutcome;

  @override
  State<OnboardingRehearsalPage> createState() => _OnboardingRehearsalPageState();
}

class _OnboardingRehearsalPageState extends State<OnboardingRehearsalPage> {
  /// 質問を打ち終わるまで、操作は出さない。まだ聞かれていないので。
  bool _asked = false;
  bool _holding = false;

  /// **うまく言えなかったときに顔を曇らせない。**
  ///
  /// 後輩版はここで困り顔([SenpaiMood.puzzled])にしていた。後輩にとっては
  /// 「聞いても分からなかった」という事実の表示で、責める意味を持たなかったからだ。
  /// 先輩がここで困ると意味が変わる — **教えたのに伝わらなかった、という落胆**に
  /// 読める。詰まることは織り込み済み(それを見つけに来ている)なので、
  /// 顔は受け取ったまま動かさず、応えるのは言葉とマーカーだけにする(§0 の約束3)。
  SenpaiMood get _mood => switch (widget.outcome) {
    RehearsalOutcome.explained => SenpaiMood.delighted,
    RehearsalOutcome.passed => SenpaiMood.neutral,
    null => _holding ? SenpaiMood.listening : SenpaiMood.neutral,
  };

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 読む側。ここだけがスクロールする。
        Flexible(
          child: _ScrollWithBottomFade(
            child: CenteredScroll(
              children: <Widget>[
                const SizedBox(height: AppSpacing.md),
                FadeSlideIn(
                  child: Text(
                    strings.onboardingTryTitle,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                const FadeSlideIn.staggered(index: 1, child: _NotebookCard()),
                // 問題と板書はひとつながりなので、あいだの間は詰める。
                const SizedBox(height: AppSpacing.md),
                const FadeSlideIn.staggered(index: 2, child: _SenpaiBoard()),
                const SizedBox(height: AppSpacing.md),
              ],
            ),
          ),
        ),
        // やる側。**折り返しの下には絶対に出さない。**
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              FadeSlideIn.staggered(
                index: 3,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: <Widget>[
                    SenpaiFace(mood: _mood, size: 76),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: _SpeechBubble(
                        child: TypingText(
                          strings.onboardingTryQuestion,
                          style: Theme.of(context).textTheme.bodyLarge,
                          onDone: () {
                            if (mounted && !_asked) setState(() => _asked = true);
                          },
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              _resize(
                child: _asked ? _buildAnswer(strings) : const SizedBox(width: double.infinity),
              ),
              // 注記を操作と「つぎへ」のあいだに挟む。
              // 同じ幅のボタンが2つ続けて並ぶと、どちらが今の一手か分かりにくい。
              const SizedBox(height: AppSpacing.sm),
              Text(
                strings.onboardingTryNotRecording,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
          ),
        ),
      ],
    );
  }

  /// 質問 → 操作 → 結果 で高さが変わる。急に伸び縮みしないよう繋ぐ。
  ///
  /// [AnimatedSize] は長さ0を渡せない(レイアウト中に自分をやり直して落ちる)ので、
  /// 動かさない設定のときは包まずにそのまま返す。
  Widget _resize({required Widget child}) {
    if (AppMotion.isReduced(context)) return child;

    return AnimatedSize(
      duration: AppDurations.reaction,
      curve: AppCurves.enter,
      alignment: Alignment.topCenter,
      child: child,
    );
  }

  Widget _buildAnswer(AppStrings strings) {
    final RehearsalOutcome? outcome = widget.outcome;
    if (outcome == null) {
      return Column(
        key: const ValueKey<String>('ask'),
        children: <Widget>[
          _HoldToExplainButton(
            onHoldChanged: (bool value) => setState(() => _holding = value),
            onExplained: () => widget.onOutcome(RehearsalOutcome.explained),
          ),
          // パスは恥ではない。同じ大きさで並べないが、隠しもしない。
          GhostButton(
            label: strings.sessionPass,
            onPressed: () => widget.onOutcome(RehearsalOutcome.passed),
          ),
        ],
      );
    }

    final bool explained = outcome == RehearsalOutcome.explained;
    return Column(
      key: ValueKey<RehearsalOutcome>(outcome),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          explained ? strings.onboardingTrySaidReaction : strings.onboardingTryHoleReaction,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.md),
        _KarteLine(
          title: explained ? strings.karteSaidWell : strings.karteHoles(1),
          text: explained ? strings.onboardingTrySaid : strings.onboardingTryHole,
          marker: explained ? MarkerColor.said : MarkerColor.hole,
        ),
        GhostButton(
          label: strings.onboardingTryAgain,
          onPressed: () {
            setState(() => _holding = false);
            widget.onOutcome(null);
          },
        ),
      ],
    );
  }
}

/// 撮った問題の代わり。本物の写真は使わない(まだカメラを開かせない)。
///
/// わずかに傾けてあるのは、机の上に置いた紙に見せるため。
/// まっすぐ置くと、アプリが用意した問題集に見える。
class _NotebookCard extends StatelessWidget {
  const _NotebookCard();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Transform.rotate(
      angle: -0.012,
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.card),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(strings.onboardingTryNotebookLabel, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.xs),
            Text(strings.onboardingTryNotebook, style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
      ),
    );
  }
}

/// 下に続きがあることを示す帯を重ねたスクロール領域。
///
/// **`LatexElementView` の右端フェード(`_ScrollWithEdgeFade`)の縦版。**
/// 判定基準も同じで、「スクロールできること」ではなく
/// **「スクロールできると分かること」**を保証する。計画書§3-6b が横スクロールを
/// 不採用にした理由 —「静止画では続きがある手がかりが一切出ず、
/// 『これで全部だ』と誤読させる」— は、板書が縦に切れるときもそのまま当てはまる。
/// 最後まで見えたら帯は消す(見えているのに手がかりを出し続けるのは嘘になる)。
///
/// 中身の [CenteredScroll] は共有ウィジェットで `ScrollController` を外に出して
/// いないので、位置は通知から読む。`ScrollMetricsNotification` が初回レイアウトの
/// ぶんを、`ScrollNotification` が指で動かしたぶんを運んでくる。
///
/// 既定を「続きが無い」にしてあるのは、`_ScrollWithEdgeFade` と逆
/// (あちらは計測前を「あるかもしれない」にしている)。**縦は、収まる端末のほうが
/// 主戦場**(393×852 では日本語は収まる)なので、計測前に帯を出すと、
/// 何も切れていない画面に一瞬だけ影が差す。通知は初回レイアウトで届くので、
/// 出遅れて困ることはない。
class _ScrollWithBottomFade extends StatefulWidget {
  const _ScrollWithBottomFade({required this.child});

  final Widget child;

  @override
  State<_ScrollWithBottomFade> createState() => _ScrollWithBottomFadeState();
}

class _ScrollWithBottomFadeState extends State<_ScrollWithBottomFade> {
  bool _hasMore = false;

  void _update(ScrollMetrics metrics) {
    final bool hasMore = metrics.extentAfter > 1;
    if (hasMore == _hasMore) return;

    // 通知はレイアウトの直後に来る。その場で setState するとフレームの最中に
    // 自分を作り直すことになるので、次のフレームに送る。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && hasMore != _hasMore) setState(() => _hasMore = hasMore);
    });
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (ScrollMetricsNotification notification) {
        _update(notification.metrics);
        return false;
      },
      child: NotificationListener<ScrollNotification>(
        onNotification: (ScrollNotification notification) {
          _update(notification.metrics);
          return false;
        },
        child: Stack(
          children: <Widget>[
            widget.child,
            if (_hasMore)
              const Positioned(
                key: onboardingBoardMoreBelowKey,
                left: 0,
                right: 0,
                bottom: 0,
                child: IgnorePointer(child: _BottomFade()),
              ),
          ],
        ),
      ),
    );
  }
}

/// 帯そのもの。色は既存トークンの範囲内(`AppColors.background` = 画面の地。
/// 透明から不透明へ)。新しい色は定義しない。
class _BottomFade extends StatelessWidget {
  const _BottomFade();

  static const double _height = 28;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: _height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            // alpha:0 は「その色の透明版」であって別の色ではない。
            colors: <Color>[
              AppColors.background.withValues(alpha: 0),
              AppColors.background,
            ],
          ),
        ),
      ),
    );
  }
}

/// 先輩が書いた板書。**本番と同じ [BoardView] に、固定の台本を渡しているだけ。**
///
/// ここだけ別の見た目を作らないのは、リハーサルで見た板書と授業モードで出る板書が
/// 食い違うと、この枚が下見として機能しなくなるため。LiveKit も
/// `BoardChannelReceiver` も通らない — 届くはずの手順が最初から手元にあるので、
/// 通す相手がいない。
///
/// **白いカードには乗せない。** `LatexElementView` の右端フェードは、板書が
/// 画面の地(`AppColors.background`)に直接乗っている前提の色で描かれる
/// (同ファイルの `_EdgeFade` のコメントに既知の前提として書いてある)。
/// 別の地の上に置くと、長い式が来たときにフェードだけ色が合わない。
/// ここは地の上に直接置き、見出しだけで区切る。
class _SenpaiBoard extends StatelessWidget {
  const _SenpaiBoard();

  /// 2手順目。**数式はロケールを持たないので、ここに直接置く**
  /// (1手順目の日本語は `text` 要素として `strings` 側にある。
  /// LaTeXの中に日本語を入れると文字化けする・計画書§3-6d)。
  ///
  /// 短い式を選んであるのは意図的で、`BoardStyle.latexMinScale`(70%)の
  /// フォールバック(横スクロール)に落ちない幅に収まる。
  static const String _tex = r'D = (-4)^2 - 4k > 0';

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(strings.onboardingTryBoardLabel, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.xs),
        BoardView(
          // `speech` を空にしてあるのは手抜きではない。この枚は音を出さないし、
          // そもそも「書いている間は喋らない」が板書レイヤーの原則(§3-1)なので、
          // 板書だけが残る形は本番の1手順としても正しい。
          steps: <BoardStep>[
            BoardStep(
              index: 0,
              speech: '',
              board: BoardElement.text(body: strings.onboardingTryBoardText),
            ),
            const BoardStep(index: 1, speech: '', board: BoardElement.latex(tex: _tex)),
          ],
        ),
      ],
    );
  }
}

/// 先輩のふきだし。しっぽを左に向けて、話しているのが顔の側だと分かるようにする。
class _SpeechBubble extends StatelessWidget {
  const _SpeechBubble({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        const CustomPaint(size: Size(8, 14), painter: _TailPainter()),
        Expanded(
          child: Container(
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: AppColors.blue.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(AppRadius.card),
            ),
            child: child,
          ),
        ),
      ],
    );
  }
}

class _TailPainter extends CustomPainter {
  const _TailPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = Path()
      ..moveTo(size.width, 0)
      ..lineTo(0, size.height / 2)
      ..lineTo(size.width, size.height)
      ..close();
    canvas.drawPath(path, Paint()..color = AppColors.blue.withValues(alpha: 0.08));
  }

  @override
  bool shouldRepaint(_TailPainter oldDelegate) => false;
}

/// カルテに1行だけ書かれた状態。本物のカルテと同じ見出しとマーカーを使う。
class _KarteLine extends StatelessWidget {
  const _KarteLine({required this.title, required this.text, required this.marker});

  final String title;
  final String text;
  final MarkerColor marker;

  @override
  Widget build(BuildContext context) {
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
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.sm),
          // 少し待ってから引く。反応の言葉を読む時間をつくる。
          MarkerText(text, marker: marker, delay: AppDurations.reaction),
        ],
      ),
    );
  }
}

/// 長押ししているあいだだけ、先輩が聞いている。
///
/// 本番のセッションは「話し続ける」ので、ここでも押し続ける操作にしてある。
/// 押している時間そのものが説明の比喩なので、この長さは
/// アニメーションを減らす設定でも縮めない([AppDurations.hold])。
/// 押し続けられない人のために、読み上げ利用時はタップで済むようにする。
class _HoldToExplainButton extends StatefulWidget {
  const _HoldToExplainButton({required this.onHoldChanged, required this.onExplained});

  final ValueChanged<bool> onHoldChanged;
  final VoidCallback onExplained;

  @override
  State<_HoldToExplainButton> createState() => _HoldToExplainButtonState();
}

class _HoldToExplainButtonState extends State<_HoldToExplainButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _progress = AnimationController(
    vsync: this,
    duration: AppDurations.hold,
  );
  bool _holding = false;
  bool _showHint = false;

  @override
  void initState() {
    super.initState();
    _progress.addStatusListener((AnimationStatus status) {
      if (status != AnimationStatus.completed) return;
      HapticFeedback.mediumImpact();
      widget.onExplained();
    });
  }

  @override
  void dispose() {
    _progress.dispose();
    super.dispose();
  }

  void _setHolding(bool value) {
    if (_holding == value) return;
    setState(() => _holding = value);
    widget.onHoldChanged(value);
  }

  void _start() {
    HapticFeedback.selectionClick();
    _setHolding(true);
    setState(() => _showHint = false);
    _progress.forward();
  }

  void _stop() {
    if (_progress.isCompleted) return;
    _setHolding(false);
    // 途中で離した。責めずに、押し方だけ伝える。
    if (_progress.value > 0.05) setState(() => _showHint = true);
    _progress.reverse();
  }

  /// 押し続けずに離したとき。読み上げ中は、これが正規の操作になる。
  void _tapped() {
    if (!AppMotion.prefersTapOverHold(context)) return;
    _progress.value = 1;
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final bool tapInstead = AppMotion.prefersTapOverHold(context);
    final String label = tapInstead ? strings.onboardingTryTap : strings.onboardingTryHold;

    return Column(
      children: <Widget>[
        Semantics(
          button: true,
          label: label,
          child: GestureDetector(
            onTapDown: (TapDownDetails _) => _start(),
            onTapUp: (TapUpDetails _) => _stop(),
            onTapCancel: _stop,
            onTap: _tapped,
            child: AnimatedBuilder(
              animation: _progress,
              builder: (BuildContext context, Widget? child) => ClipRRect(
                borderRadius: BorderRadius.circular(AppRadius.button),
                child: Container(
                  height: 60,
                  decoration: BoxDecoration(
                    color: AppColors.blue.withValues(alpha: 0.10),
                    border: Border.all(color: AppColors.blue, width: 2),
                    borderRadius: BorderRadius.circular(AppRadius.button),
                  ),
                  child: Stack(
                    children: <Widget>[
                      // 押しているあいだ、左から満ちていく。
                      // 進み具合が見えないと、いつまで押すのか分からない。
                      FractionallySizedBox(
                        widthFactor: _progress.value,
                        alignment: Alignment.centerLeft,
                        child: ColoredBox(
                          color: AppColors.blue.withValues(alpha: 0.28),
                          child: const SizedBox.expand(),
                        ),
                      ),
                      Center(
                        child: _holding
                            ? Row(
                                mainAxisSize: MainAxisSize.min,
                                children: <Widget>[
                                  const SpeakingWave(active: true, height: 22),
                                  const SizedBox(width: AppSpacing.sm),
                                  Text(
                                    strings.onboardingTryHolding,
                                    style: Theme.of(
                                      context,
                                    ).textTheme.titleMedium?.copyWith(color: AppColors.blue),
                                  ),
                                ],
                              )
                            : Text(
                                label,
                                style: Theme.of(
                                  context,
                                ).textTheme.titleMedium?.copyWith(color: AppColors.blue),
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        SizedBox(
          height: 28,
          child: Center(
            child: AnimatedOpacity(
              opacity: _showHint ? 1 : 0,
              duration: AppMotion.decorative(context, AppDurations.reaction),
              child: Text(strings.onboardingTryHint, style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
        ),
      ],
    );
  }
}
