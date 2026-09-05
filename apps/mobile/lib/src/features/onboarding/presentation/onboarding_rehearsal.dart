import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../session/domain/board.dart';
import '../../session/presentation/board/board_view.dart';
import 'onboarding_motion.dart';

/// 板書が下に続いていることを示す帯([_BottomFade])の目印。
///
/// **出る / 出ないの出し分けそのものが仕様**(切れているのに手がかりが無いのが
/// いちばん悪い状態で、切れていないのに出続けるのは嘘)なので、
/// 見た目ではなくこの目印でテストできるようにしてある。
const Key onboardingBoardMoreBelowKey = Key('onboarding_board_more_below');

/// できあがった復習問題のカードの目印。
const Key onboardingMadeProblemKey = Key('onboarding_made_problem');

/// 授業のリハーサル — **コアループの前半を、一度やってみる枚**。
///
/// 読んで分かった気になる説明を、**やってみる**に置き換える。ここを通ると、
/// 初回の撮影ボタンを押す前に「先輩が板書で教えてくれる」と
/// 「わかったと言うと1問できる」の両方を体験している。
///
/// **ADR 0009 でこの枚の中身が入れ替わった。**教え返し(長押しして説明する →
/// 言えた / 言えない)は畳まれ、いま置いてあるのは**授業を終わらせる操作**
/// ひとつだけ。降りる口は生徒側に2つ(「わかった」と ×)で、確認を挟むのは
/// × だけ —「わかった」は素通し。だからここでも確認は出さない。
///
/// 3つ守る:
///   - **繋がない。** 板書も台本も固定で、LiveKitにもAPIにも触らない。
///   - **権限を要求しない。** カメラもマイクも使わない。
///   - **待たせない。** 押した瞬間に問題ができる(ADR 0009「生成の完了を待たせない」)。
///     本番では生成は `/complete` の裏に回るが、**待たされないという体験**は同じ。
///
/// ## 画面を「読む側」と「やる側」に割ってある
///
/// 板書を積んだぶん縦に伸び、375×667(SE級)では操作が折り返しの下に落ちた。
/// **操作が初期表示に無いことは、板書が全部見えないことより重い** —
/// 板書は切れていても「下に続く」と分かれば体験は壊れないが、操作が見えなければ
/// **やることがある枚だと気づかれないままスワイプされる**。
///
///   - **上(スクロールする)**: 見出し・撮った問題・板書
///   - **下(固定)**: 先輩の顔とふきだし・操作
class OnboardingRehearsalPage extends StatefulWidget {
  const OnboardingRehearsalPage({
    required this.understood,
    required this.onUnderstood,
    super.key,
  });

  /// 「わかった」を押したか。押すまで先へは進めない(親が「つぎへ」を止める)。
  final bool understood;

  final VoidCallback onUnderstood;

  @override
  State<OnboardingRehearsalPage> createState() => _OnboardingRehearsalPageState();
}

class _OnboardingRehearsalPageState extends State<OnboardingRehearsalPage> {
  /// 先輩が言い終わるまで、操作は出さない。まだ教わっていないので。
  bool _taught = false;

  /// **押したあとも顔を曇らせない。**「わかった」は到達の宣言(ADR 0009)で、
  /// 先輩が採点し直すものではない。応えるのは言葉と、できた1問だけ。
  SenpaiMood get _mood => widget.understood ? SenpaiMood.delighted : SenpaiMood.neutral;

  void _understood() {
    HapticFeedback.mediumImpact();
    widget.onUnderstood();
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String line = widget.understood
        ? strings.onboardingTryUnderstoodReaction
        : strings.onboardingTryTeachLine;

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
                      child: SenpaiBubble(
                        child: TypingText(
                          // **せりふが替わったら、打ち直させる。**[TypingText] は
                          // 最初の文字列でコントローラを組むので、同じ場所で文だけ
                          // 差し替えると State が使い回されて**前のせりふのまま**
                          // 止まる。鍵を文そのものにして作り直させる。
                          key: ValueKey<String>(line),
                          line,
                          style: Theme.of(context).textTheme.bodyLarge,
                          onDone: () {
                            if (mounted && !_taught) setState(() => _taught = true);
                          },
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              _resize(
                child: _taught ? _buildAnswer(strings) : const SizedBox(width: double.infinity),
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
          ),
        ),
      ],
    );
  }

  /// 教わる → 押す → 1問できた、で高さが変わる。急に伸び縮みしないよう繋ぐ。
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
    if (!widget.understood) {
      return Column(
        key: const ValueKey<String>('ask'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          // **本番と同じ言葉・同じ位置**(`sessionUnderstood`)。
          // ここだけ別の名前にすると、この枚が授業モードの下見として働かない。
          ChunkyButton(
            key: const Key('onboarding-understood'),
            label: strings.sessionUnderstood,
            color: AppColors.streak,
            onPressed: _understood,
          ),
        ],
      );
    }

    return Column(
      key: const ValueKey<String>('understood'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 押した瞬間に、できた1問が出る。**跳ねて出す**のは、
        // これが持ち帰るものだから(にぎやかな画面だけが `pop` を使える)。
        PopIn(child: _MadeProblemCard(label: strings.onboardingTryProblemLabel)),
      ],
    );
  }
}

/// 撮った問題の代わり。本物の写真は使わない(まだカメラを開かせない)。
///
/// **傾けない。** かつては机の上に置いた紙に見せるため少しだけ傾けてあったが、
/// 紙の質感も影も無いただのカードでは「紙っぽさ」までは届かず、
/// **問題文だけが斜めに組まれた不具合**に見えていた。すぐ下の板書も、
/// できた復習問題のカードもまっすぐなので、この1枚だけが浮く。
/// 撮ったものだと分かるのはラベル(`onboardingTryNotebookLabel`)の仕事で、
/// 傾きに担わせるものではない。
class _NotebookCard extends StatelessWidget {
  const _NotebookCard();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

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
          Text(strings.onboardingTryNotebookLabel, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          Text(strings.onboardingTryNotebook, style: Theme.of(context).textTheme.titleMedium),
        ],
      ),
    );
  }
}

/// 「わかった」で生まれた復習問題。**紙のカード**(板書は黒板)。
///
/// 素材の分けは `board_style.dart` と同じ — 復習画面の `_ProblemCard` も紙なので、
/// 3日後に届く問題と同じ見た目のものが、ここで生まれたことになる。
class _MadeProblemCard extends StatelessWidget {
  const _MadeProblemCard({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Container(
      key: onboardingMadeProblemKey,
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.hole.withValues(alpha: 0.5), width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.auto_awesome, size: 16, color: AppColors.hole),
              const SizedBox(width: AppSpacing.xs),
              Text(label, style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            strings.onboardingPracticeQuestion,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ],
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
/// 通す相手がいない。行が1行ずつ書かれる動きは [BoardView] 側の `BoardReveal` が
/// そのまま持っている(**書かれるところを見せる**のがこの枚の主役)。
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
        // **板は角の丸いカード**(ADR 0009 / `board_style.dart`)。高さを知って
        // いる側が角を丸める決まりなので、ここで包む。
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.card),
          child: BoardView(
            title: strings.onboardingTryBoardTitle,
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
        ),
      ],
    );
  }
}
