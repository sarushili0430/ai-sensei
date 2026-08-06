import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';

/// リハーサルの結果。
enum RehearsalOutcome {
  /// 説明できた → 黄マーカー。
  explained,

  /// うまく言えなかった → ピンクのマーカー(= 穴)。**失敗ではない。**
  passed,
}

/// オンボーディング3枚目 — リハーサル。
///
/// 読んで分かった気になる説明を、**一度やってみる**に置き換える枚。
/// ここを通ると、初回の撮影ボタンを押す前に、後輩に聞かれる感じと
/// 「言えなかったことが残る」ことの両方を体験している。
///
/// 3つ守る:
///   - **答えを出さない。** 台本は質問だけで、模範解答は持たない(§0 の約束1)。
///   - **権限を要求しない。** マイクもカメラも使わない。録らないことは画面に書く。
///   - **正解にしない。** 説明しても、パスしても、先へ進める。
///     どちらを選んだかで責めない(§0 の約束3)。
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

  KohaiMood get _mood => switch (widget.outcome) {
    RehearsalOutcome.explained => KohaiMood.delighted,
    RehearsalOutcome.passed => KohaiMood.puzzled,
    null => _holding ? KohaiMood.listening : KohaiMood.neutral,
  };

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return CenteredScroll(
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
        const SizedBox(height: AppSpacing.lg),
        FadeSlideIn.staggered(
          index: 2,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              KohaiFace(mood: _mood, size: 76),
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
        const SizedBox(height: AppSpacing.lg),
        _resize(child: _asked ? _buildAnswer(strings) : const SizedBox(width: double.infinity)),
        const SizedBox(height: AppSpacing.md),
        Text(
          strings.onboardingTryNotRecording,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
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

/// 撮ったノートの代わり。本物の写真は使わない(まだカメラを開かせない)。
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

/// 後輩のふきだし。しっぽを左に向けて、話しているのが顔の側だと分かるようにする。
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

/// 長押ししているあいだだけ、後輩が聞いている。
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
