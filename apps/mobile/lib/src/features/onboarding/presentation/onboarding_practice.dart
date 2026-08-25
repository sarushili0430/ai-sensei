import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../brand/app_mark.dart';
import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/confetti.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import 'onboarding_motion.dart';

/// 通知の見本の目印(テスト・golden から)。
const Key onboardingPushKey = Key('onboarding_push');

/// 採点が終わった状態の目印。
const Key onboardingVerdictKey = Key('onboarding_verdict');

/// 解答欄の目印。**押す口ではない**(開いた瞬間から勝手に書かれる)。
const Key onboardingAnswerKey = Key('onboarding_answer');

/// 復習のリハーサル — **コアループの後半を、一度やってみる枚**。
///
/// ここが無かったあいだ、オンボーディングは約束の前半(教える)しか
/// 見せていなかった。**後半(3日後に聞く)こそが手元の無料AIとの差**なので、
/// 読むだけで済ませると、いちばん効く一言が「言っただけの約束」で終わる。
///
/// 通し方は本番と同じ順(ADR 0009 / `docs/core_loop_screens.html` の②):
/// **通知が届く → 問題を読む → 書いて答える → AIが採点する → 次の段が決まる。**
///
/// 3つ守る:
///   - **繋がない。** 採点はしない。台本の1問と、決まった判定だけ。
///   - **権限を要求しない。** 通知はこの画面の中の絵で、OSには何も頼まない。
///   - **キーボードを出さない。** 開いた瞬間から、解答は**ひとりでに書かれていく**。
///     ここで打たせると、まだ何も起きていないうちに入力の手間だけが先に来るし、
///     タップ待ちにすると「書くところ」だと気づかれないまま止まる。
class OnboardingPracticePage extends StatefulWidget {
  const OnboardingPracticePage({required this.answered, required this.onAnswered, super.key});

  /// 採点まで通ったか。通るまで先へは進めない(親が「つぎへ」を止める)。
  final bool answered;

  final VoidCallback onAnswered;

  @override
  State<OnboardingPracticePage> createState() => _OnboardingPracticePageState();
}

/// 採点にかける時間。**本番と同じ数秒**の代わりに、待つ形だけを見せる。
/// 待たせるためではなく、「読んでいる」が画面に出ることを見せるための長さ。
const Duration _gradingDuration = Duration(milliseconds: 900);

class _OnboardingPracticePageState extends State<OnboardingPracticePage>
    with SingleTickerProviderStateMixin {
  /// 通知を開いたか。
  ///
  /// **開くところまでを一手にしてある。**通知が飾りとして置いてあるだけだと、
  /// 3日後に届くものが「読むだけのお知らせ」に見える。押して開いて初めて、
  /// あれが**問題への入口**だと分かる(本番でも、通知の着地先はこの画面)。
  ///
  /// 段を分けているのは縦の都合でもある。見出し+通知+問題+解答欄を一度に
  /// 積むと、375×667 の英語で解答欄が折り返しの下へ落ちた(実測)。
  /// **やることがある枚は、やる口が必ず初期表示に無いといけない。**
  bool _opened = false;

  /// 書き終わったか。**書き終わるまで「こたえる」は押せない**
  /// (本番も空文字では送れない)。
  bool _written = false;

  bool _grading = false;

  /// 採点の待ち。**`Timer` ではなくコントローラで測る。**
  /// 減らす設定では長さが 0 になり、その場で採点が返る
  /// (`Timer` だと、動きを止めたテストでフレームが来ずに止まったままになる)。
  late final AnimationController _grader = AnimationController(vsync: this);

  @override
  void initState() {
    super.initState();
    _grader.addStatusListener((AnimationStatus status) {
      if (status != AnimationStatus.completed || !mounted) return;
      setState(() => _grading = false);
      HapticFeedback.mediumImpact();
      widget.onAnswered();
    });
  }

  @override
  void dispose() {
    _grader.dispose();
    super.dispose();
  }

  void _open() {
    HapticFeedback.selectionClick();
    setState(() => _opened = true);
  }

  void _submit() {
    setState(() => _grading = true);
    _grader
      ..duration = AppMotion.decorative(context, _gradingDuration)
      ..forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Stack(
      children: <Widget>[
        // 採点が通ったところだけ祝う。**紙吹雪は一度きり**で、
        // 降り終わったら止まる(待たせていないので降り続けさせない)。
        if (widget.answered) const Positioned.fill(child: ConfettiBurst(pieces: 18)),
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Flexible(
              child: CenteredScroll(
                children: switch ((widget.answered, _opened)) {
                  (true, _) => _graded(strings),
                  (false, true) => _answering(strings),
                  (false, false) => _arrived(strings),
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
              child: _resize(child: _action(strings)),
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
        ),
      ],
    );
  }

  /// 3日後。通知が届いたところ。
  List<Widget> _arrived(AppStrings strings) {
    return <Widget>[
      const SizedBox(height: AppSpacing.md),
      _title(strings),
      const SizedBox(height: AppSpacing.lg),
      // **上から降ってくる。**届いたことが要るので、置くのではなく届かせる。
      DropIn(
        delay: AppDurations.stagger * 2,
        child: _PushPreview(
          title: strings.onboardingPushTitle,
          body: strings.onboardingPushBody,
          when: strings.onboardingPushWhen,
          onTap: _open,
        ),
      ),
      const SizedBox(height: AppSpacing.md),
    ];
  }

  /// 開いた先。**通知は畳む** —— もう入口ではなく、いま開いている画面そのもの。
  List<Widget> _answering(AppStrings strings) {
    return <Widget>[
      const SizedBox(height: AppSpacing.md),
      _title(strings),
      const SizedBox(height: AppSpacing.lg),
      FadeSlideIn(child: _paper(strings)),
      const SizedBox(height: AppSpacing.md),
    ];
  }

  Widget _title(AppStrings strings) => FadeSlideIn(
    child: Text(
      strings.onboardingReviewTitle,
      textAlign: TextAlign.center,
      style: Theme.of(context).textTheme.headlineSmall,
    ),
  );

  /// 採点が返ってきたところ。
  ///
  /// **通知と見出しは畳む。**本番の `_ResultView` も、結果の画面には結果しか
  /// 置かない。ここで足し続けると、**いちばん見せたい「言えてる」が
  /// 折り返しの下に落ちる**(375×667の英語で実測)。
  List<Widget> _graded(AppStrings strings) {
    return <Widget>[
      const SizedBox(height: AppSpacing.md),
      Row(
        key: onboardingVerdictKey,
        children: <Widget>[
          const SenpaiFace(mood: SenpaiMood.delighted, size: 72),
          const SizedBox(width: AppSpacing.sm),
          // 本番と同じ言葉・同じマーカー(`practiceCorrect` / 黄)。点数は出さない。
          Expanded(
            child: MarkerText(
              strings.practiceCorrect,
              marker: MarkerColor.said,
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
        ],
      ),
      const SizedBox(height: AppSpacing.md),
      _paper(strings),
      const SizedBox(height: AppSpacing.md),
      // 次の段。**作成時に決めた段は取り消さない**(ADR 0009)ので、
      // 正解しても7日後は消えない。そこまで含めて見せる。
      _ScheduleBand(text: strings.practiceNextSchedule(const <int>[7])),
      const SizedBox(height: AppSpacing.md),
    ];
  }

  /// 問題と解答を**1枚の紙**に置く。
  ///
  /// 本番の `_GradingView` / `_ResultView` と同じ形(`_PaperCard` を区切り線で
  /// 割る)。**同じ1回の解答だから別のカードに割らない**という理由がそのまま
  /// ここにも当てはまるうえ、カード2枚ぶんの余白が消えて縦に収まる。
  Widget _paper(AppStrings strings) {
    final TextTheme text = Theme.of(context).textTheme;

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
          Text(strings.practiceHeader(3), style: text.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          Text(strings.onboardingPracticeQuestion, style: text.titleMedium),
          const _PaperDivider(),
          Text(
            widget.answered ? strings.practiceYourAnswer : strings.practiceAnswerHint,
            style: text.bodySmall,
          ),
          const SizedBox(height: AppSpacing.sm),
          _answerSlot(strings),
        ],
      ),
    );
  }

  /// 解答のところ。**開いた瞬間から、ひとりでに書かれていく。**
  ///
  /// タップして書かせるのはやめた。押されるまで「タップして書く」の薄い文字が
  /// 座っているだけで、**そこが解答欄だと気づかれないまま**通知の枚が終わる。
  /// 書かれるところが目に入れば、3日後にやることは説明せずに伝わる。
  ///
  /// **枠の色は本番の `TextField` と同じ青の2px**にしてある。打てないだけで、
  /// 書くところであることは形で分かるように。採点後は枠を外す
  /// (もう書き直すところではないので、押せそうに見せない)。
  Widget _answerSlot(AppStrings strings) {
    final TextStyle? body = Theme.of(context).textTheme.bodyLarge;

    if (widget.answered) {
      return Text(strings.onboardingPracticeAnswer, style: body);
    }

    return Container(
      key: onboardingAnswerKey,
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 52),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(AppRadius.button),
        border: Border.all(color: AppColors.blue, width: 2),
      ),
      child: TypingText(
        strings.onboardingPracticeAnswer,
        style: body,
        onDone: () {
          if (mounted && !_written) setState(() => _written = true);
        },
      ),
    );
  }

  /// 下に固定する一手。押す → 待つ → 一言、で入れ替わる。
  Widget _action(AppStrings strings) {
    if (widget.answered) {
      return Padding(
        key: const ValueKey<String>('reaction'),
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: Text(
          strings.onboardingPracticeReaction,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      );
    }

    if (_grading) {
      // 待っているあいだに何が起きているかを必ず出す(本番の `_GradingView` と同じ)。
      return Padding(
        key: const ValueKey<String>('grading'),
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text(
              strings.practiceGradingProgress,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(color: AppColors.inkMuted),
            ),
            const SizedBox(width: AppSpacing.sm),
            const GradingDots(),
          ],
        ),
      );
    }

    if (!_opened) {
      return ChunkyButton(
        key: const Key('onboarding-practice-open'),
        label: strings.onboardingPracticeOpen,
        onPressed: _open,
      );
    }

    return ChunkyButton(
      key: const Key('onboarding-practice-submit'),
      label: strings.practiceSubmit,
      onPressed: _written ? _submit : null,
    );
  }

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
}

/// カードの中の区切り線。**別のカードに割らない** — 同じ1回の解答だから。
class _PaperDivider extends StatelessWidget {
  const _PaperDivider();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 14),
      child: ColoredBox(
        color: AppColors.border,
        child: SizedBox(height: 1, width: double.infinity),
      ),
    );
  }
}

/// 3日後に届く通知の見本。
///
/// **端末の通知に寄せて描く**(丸いアイコン・太い1行目・薄い2行目・右上に時刻)。
/// 別の形にすると、これが**ロック画面に出るもの**だと伝わらない。
/// OSには何も頼んでいない — 許可を聞くのは、初回の問題ができたあと。
class _PushPreview extends StatelessWidget {
  const _PushPreview({
    required this.title,
    required this.body,
    required this.when,
    required this.onTap,
  });

  final String title;
  final String body;
  final String when;

  /// 通知そのものを押せる。**本物と同じ触り方**にしておく
  /// (押せると分かるのは押した人だけなので、下にも同じ口を置いてある)。
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        key: onboardingPushKey,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.border),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: AppColors.ink.withValues(alpha: 0.08),
              blurRadius: 18,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            ClipRRect(borderRadius: BorderRadius.circular(9), child: const AppMarkView(size: 34)),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
                      Text(when, style: Theme.of(context).textTheme.bodySmall),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(body, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 次の段の帯。復習画面の `_ScheduleBand` と同じ形。
class _ScheduleBand extends StatelessWidget {
  const _ScheduleBand({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.schedule, size: 20, color: AppColors.inkMuted),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
        ],
      ),
    );
  }
}
