import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../../session/domain/session.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// 通知とホームのカードが着地する、復習問題の1画面。
///
/// 旧画面も先頭の1問だけを大きく出していたため、一覧を別画面に分けず、
/// 解答・採点待ち・結果をここへ一本化する。通知から余分な1タップを増やすと、
/// 30秒で終わるはずの復習が「一覧を開いてから問題を選ぶ」体験になるため。
///
/// 穴の自己申告は畳んだ。正誤は採点が決め、`unclear` もこの画面で同じ解答を
/// 書き直せるので、本人にもう一度「言えたか」を決めさせる受け皿は残さない。
class ReviewScreen extends ConsumerWidget {
  const ReviewScreen({this.problemId, super.key});

  /// 通知の `problem_id`。旧 `hole_id` 通知では null のまま先頭問題へ安全に落ちる。
  final String? problemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<PracticeQueue> queue = ref.watch(reviewControllerProvider);

    return queue.when(
      loading: () => _MessageScaffold(
        title: strings.reviewTitle,
        child: const Center(child: CircularProgressIndicator()),
      ),
      error: (Object error, StackTrace stack) => _MessageScaffold(
        title: strings.reviewTitle,
        child: _Message(
          text: strings.errorGeneric,
          primaryLabel: strings.errorRetry,
          onPrimary: () => ref.read(reviewControllerProvider.notifier).refresh(),
        ),
      ),
      data: (PracticeQueue data) {
        final int index = _indexOf(data.items, problemId);
        if (index >= 0) {
          final PracticeQueueItem item = data.items[index];
          return _PracticeFlow(
            key: ValueKey<String>(item.problem.id),
            item: item,
            position: index + 1,
            total: data.items.length,
          );
        }
        // **名指しされた問題がリストに無い。**正解した問題にも7日後の通知は
        // 届く(段を取り消さない。ADR 0009)ので、`items` から外れた問題を
        // 開こうとしている。1問ぶんのAPIで引き直す。
        final String? requested = problemId;
        if (requested != null) {
          return _SingleProblem(problemId: requested);
        }
        return _MessageScaffold(
          title: strings.reviewTitle,
          child: _EmptyPractice(queue: data),
        );
      },
    );
  }

  int _indexOf(List<PracticeQueueItem> items, String? requestedId) {
    if (items.isEmpty) return -1;
    if (requestedId == null) return 0;
    for (int index = 0; index < items.length; index += 1) {
      if (items[index].problem.id == requestedId) return index;
    }
    return -1;
  }
}

/// 通知が名指しした1問を、リストを介さずに開く。
///
/// **旧 `hole_id` の通知でここへ来ることはない**(あちらは `problemId` を
/// 持たないので、上の分岐で先頭の問題に落ちる)。ここに来るのは
/// `problem_id` を持つ通知だけで、その問題が見つからなければ 404 になる —
/// そのときは「もう残っていない」として空の画面へ落とす(#180 の確かめること)。
class _SingleProblem extends ConsumerWidget {
  const _SingleProblem({required this.problemId});

  final String problemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    return ref.watch(practiceProblemProvider(problemId)).when(
          loading: () => _MessageScaffold(
            title: strings.reviewTitle,
            child: const Center(child: CircularProgressIndicator()),
          ),
          error: (Object error, StackTrace stack) => _MessageScaffold(
            title: strings.reviewTitle,
            child: _Message(
              text: strings.errorGeneric,
              primaryLabel: strings.reviewBackHome,
              onPrimary: () => context.go(AppRoute.home.path),
            ),
          ),
          data: (PracticeQueueItem item) => _PracticeFlow(
            key: ValueKey<String>(item.problem.id),
            item: item,
            position: 1,
            total: 1,
          ),
        );
  }
}

class _PracticeFlow extends ConsumerStatefulWidget {
  const _PracticeFlow({
    required this.item,
    required this.position,
    required this.total,
    super.key,
  });

  final PracticeQueueItem item;

  /// ヘッダのチップ(`2 / 3`)。**いま何問目か**が分かると、
  /// 「あと何回これが来るのか」が読めて、途中でやめにくくなる。
  final int position;
  final int total;

  @override
  ConsumerState<_PracticeFlow> createState() => _PracticeFlowState();
}

class _PracticeFlowState extends ConsumerState<_PracticeFlow> {
  late final TextEditingController _responseController;
  bool _showLessonGate = false;

  String get _problemId => widget.item.problem.id;

  @override
  void initState() {
    super.initState();
    _responseController = TextEditingController(
      text: ref.read(practiceAnswerControllerProvider).draftFor(_problemId),
    );
  }

  @override
  void dispose() {
    _responseController.dispose();
    super.dispose();
  }

  void _updateDraft(String value) {
    ref.read(practiceAnswerControllerProvider.notifier).updateDraft(
          _problemId,
          value,
        );
  }

  void _submit() {
    FocusScope.of(context).unfocus();
    unawaited(
      ref.read(practiceAnswerControllerProvider.notifier).submit(_problemId),
    );
  }

  void _retry() {
    ref.read(practiceAnswerControllerProvider.notifier).retry(_problemId);
    setState(() => _showLessonGate = false);
  }

  void _finish() {
    ref.read(practiceAnswerControllerProvider.notifier).clear(_problemId);
    // 解いた直後の問題をキューへ残すと、ホームから同じ問題をもう一度出してしまう。
    // 結果を読む時間は守り、出口を選んだところで初めて次回用に取り直す。
    ref.invalidate(reviewControllerProvider);
    context.go(AppRoute.home.path);
  }

  void _openPaywall() {
    setState(() => _showLessonGate = false);
    context.push(AppRoute.paywall.path);
  }

  Future<void> _askSenpai() async {
    final ProgressSummary progress =
        ref.read(progressControllerProvider).value ?? ProgressSummary.empty;
    final CaptureState capture = ref.read(captureControllerProvider);
    final _LessonAvailability availability = _lessonAvailability(
      progress: progress,
      error: capture.error,
    );
    if (!availability.allowed) {
      setState(() => _showLessonGate = true);
      return;
    }

    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .startReview(
          _problemId,
          locale: Localizations.localeOf(context).languageCode,
        );
    if (!mounted) return;
    if (session != null) {
      context.go(AppRoute.session.path);
    } else {
      // 押した直前に契約や日次枠が変わることがある。サーバの判定を同じ場所に出し、
      // 何も起きなかったように元の結果だけを残さない。
      setState(() => _showLessonGate = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final PracticeAnswersState state = ref.watch(
      practiceAnswerControllerProvider,
    );
    final PracticeAnswer? answer = state.answerFor(_problemId);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          // キャンバスの `padding: 44px 24px 24px`。上は SafeArea が持つので、
          // ここが持つのは左右24と下24、そしてヘッダとの間の少しだけ。
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.lg,
            AppSpacing.sm,
            AppSpacing.lg,
            AppSpacing.lg,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              _PracticeHeader(
                item: widget.item,
                position: widget.position,
                total: widget.total,
                variant: answer != null
                    ? _HeaderVariant.result
                    : state.isGrading(_problemId)
                        ? _HeaderVariant.grading
                        : _HeaderVariant.answering,
              ),
              const SizedBox(height: AppSpacing.md),
              if (answer != null)
                Expanded(
                  child: _ResultView(
                    answer: answer,
                    showLessonGate: _showLessonGate,
                    onAskSenpai: _askSenpai,
                    onLater: _finish,
                    onRetry: _retry,
                    onHome: _finish,
                    onUpgrade: _openPaywall,
                  ),
                )
              else if (state.isGrading(_problemId))
                Expanded(
                  child: _GradingView(
                    problem: widget.item.problem,
                    response: state.draftFor(_problemId),
                  ),
                )
              else
                Expanded(
                  child: _AnswerView(
                    problem: widget.item.problem,
                    controller: _responseController,
                    hasError: state.errorFor(_problemId) != null,
                    onChanged: _updateDraft,
                    onSubmit: _submit,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// ヘッダの出し分け。**画面の状態ごとに、要るものだけ置く。**
///
/// 解答中は戻れる必要があるが、採点待ちに戻る操作を置くと「送ったのに抜けられる」
/// になり、結果画面では下の操作(ホームへ戻る / 先輩に聞く)が出口を持っている。
/// 出口が2つある画面を作らないための出し分け(`docs/core_loop_screens.html`)。
enum _HeaderVariant { answering, grading, result }

class _PracticeHeader extends StatelessWidget {
  const _PracticeHeader({
    required this.item,
    required this.position,
    required this.total,
    required this.variant,
  });

  final PracticeQueueItem item;
  final int position;
  final int total;
  final _HeaderVariant variant;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // 結果は1行に畳む。顔と見出しが主役なので、上に箱を積まない。
    if (variant == _HeaderVariant.result) {
      return Text(
        '${strings.practiceHeader(item.daysSince)} — ${item.topicLabel}',
        key: const Key('practice-result-header'),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodySmall,
      );
    }

    return SizedBox(
      height: 52,
      child: Row(
        children: <Widget>[
          if (variant == _HeaderVariant.answering)
            Semantics(
              button: true,
              label: MaterialLocalizations.of(context).backButtonTooltip,
              child: SizedBox.square(
                key: const Key('practice-back'),
                dimension: 44,
                child: Material(
                  type: MaterialType.transparency,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(AppRadius.button),
                    onTap: context.closeOrGoHome,
                    child: const Icon(Icons.arrow_back, color: AppColors.ink),
                  ),
                ),
              ),
            ),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text(
                  strings.practiceHeader(item.daysSince),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                Text(
                  item.topicLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          // 採点待ちに「1 / 3」を残すと、**まだ送った1問の結果も見ていないのに
          // 残りの数が目に入る**。急かす数字はこの画面から外す(約束4)。
          if (variant == _HeaderVariant.answering)
            Container(
              key: const Key('practice-position'),
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.sm,
                vertical: AppSpacing.xs,
              ),
              decoration: BoxDecoration(
                color: AppColors.said,
                borderRadius: BorderRadius.circular(AppRadius.chip),
              ),
              child: Text(
                '$position / $total',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ),
    );
  }
}

class _AnswerView extends StatefulWidget {
  const _AnswerView({
    required this.problem,
    required this.controller,
    required this.hasError,
    required this.onChanged,
    required this.onSubmit,
  });

  final PracticeProblem problem;
  final TextEditingController controller;
  final bool hasError;
  final ValueChanged<String> onChanged;
  final VoidCallback onSubmit;

  @override
  State<_AnswerView> createState() => _AnswerViewState();
}

class _AnswerViewState extends State<_AnswerView> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_refreshButton);
  }

  @override
  void didUpdateWidget(_AnswerView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    oldWidget.controller.removeListener(_refreshButton);
    widget.controller.addListener(_refreshButton);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_refreshButton);
    super.dispose();
  }

  void _refreshButton() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final bool canSubmit = widget.controller.text.trim().isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _ProblemCard(problem: widget.problem),
        const SizedBox(height: AppSpacing.md),
        // **ラベルは枠の外に置く。**`hintText` にすると打ち始めた瞬間に消えて、
        // 書いている途中の画面から「これは何の欄か」が無くなる。
        Text(
          strings.practiceAnswerHint,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.sm),
        Expanded(
          child: TextField(
            key: const Key('practice-response'),
            controller: widget.controller,
            onChanged: widget.onChanged,
            expands: true,
            minLines: null,
            maxLines: null,
            maxLength: 500,
            textAlignVertical: TextAlignVertical.top,
            style: Theme.of(context).textTheme.bodyLarge,
            decoration: InputDecoration(
              counterText: '',
              filled: true,
              fillColor: AppColors.surface,
              contentPadding: const EdgeInsets.all(AppSpacing.md),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadius.card),
                borderSide: const BorderSide(color: AppColors.blue, width: 2),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadius.card),
                borderSide: const BorderSide(color: AppColors.blue, width: 2),
              ),
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          strings.practiceAnswerHelper,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (widget.hasError)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xs),
            child: Text(
              strings.errorGeneric,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        const SizedBox(height: AppSpacing.md),
        ChunkyButton(
          key: const Key('practice-submit'),
          label: strings.practiceSubmit,
          onPressed: canSubmit ? widget.onSubmit : null,
        ),
      ],
    );
  }
}

class _GradingView extends StatelessWidget {
  const _GradingView({required this.problem, required this.response});

  final PracticeProblem problem;
  final String response;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // **問題と自分の答えを上に残したまま待つ。**送ったものが画面から消えると、
        // 何を採点されているのか分からないまま数秒を過ごすことになる。
        // 1枚のカードに区切り線で並べるのは、両方が同じ1回の解答だから。
        _PaperCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                strings.sessionProblemTitle,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(problem.question, style: Theme.of(context).textTheme.titleMedium),
              const _PaperDivider(),
              Text(
                strings.practiceYourAnswer,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(response, style: Theme.of(context).textTheme.bodyLarge),
            ],
          ),
        ),
        Expanded(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const SenpaiFace(
                key: Key('practice-face-listening'),
                mood: SenpaiMood.listening,
                size: 120,
              ),
              const SizedBox(height: AppSpacing.md),
              // **待っている間に何が起きているか**を出す。ここを空にすると、
              // 数秒の沈黙が「送れていない」に見える(#175 が実例)。
              Text(
                strings.practiceGrading,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: AppSpacing.md),
              const _GradingDots(),
            ],
          ),
        ),
        // 画面のいちばん下。**閉じてよいこと**を、下の操作と同じ位置で言う。
        SizedBox(
          height: 48,
          child: Center(
            child: Text(
              strings.practiceGradingCanClose,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ),
      ],
    );
  }
}

/// 紙のカード。**問題も答えも紙**(板書は黒板)。素材の分けは `board_style.dart`。
class _PaperCard extends StatelessWidget {
  const _PaperCard({required this.child, this.cardKey});

  final Widget child;
  final Key? cardKey;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: cardKey,
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
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

class _GradingDots extends StatefulWidget {
  const _GradingDots();

  @override
  State<_GradingDots> createState() => _GradingDotsState();
}

class _GradingDotsState extends State<_GradingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!AppMotion.isReduced(context) && !_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: AppStrings.of(context).practiceGradingProgress,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (BuildContext context, Widget? child) {
          final int active = (_controller.value * 3).floor().clamp(0, 2);
          return Row(
            key: const Key('practice-grading-dots'),
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              for (int index = 0; index < 3; index++)
                Container(
                  width: 8,
                  height: 8,
                  margin: const EdgeInsets.symmetric(horizontal: AppSpacing.xs),
                  decoration: BoxDecoration(
                    color: index == active ? AppColors.blue : AppColors.border,
                    shape: BoxShape.circle,
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _ResultView extends ConsumerWidget {
  const _ResultView({
    required this.answer,
    required this.showLessonGate,
    required this.onAskSenpai,
    required this.onLater,
    required this.onRetry,
    required this.onHome,
    required this.onUpgrade,
  });

  final PracticeAnswer answer;
  final bool showLessonGate;
  final Future<void> Function() onAskSenpai;
  final VoidCallback onLater;
  final VoidCallback onRetry;
  final VoidCallback onHome;
  final VoidCallback onUpgrade;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final PracticeVerdict verdict = answer.attempt.verdict;
    final SenpaiMood mood = switch (verdict) {
      PracticeVerdict.correct => SenpaiMood.delighted,
      PracticeVerdict.incorrect => SenpaiMood.neutral,
      PracticeVerdict.unclear => SenpaiMood.puzzled,
    };
    final String heading = switch (verdict) {
      PracticeVerdict.correct => strings.practiceCorrect,
      PracticeVerdict.incorrect => strings.practiceIncorrect,
      PracticeVerdict.unclear => strings.practiceUnclear,
    };
    final MarkerColor? marker = switch (verdict) {
      PracticeVerdict.correct => MarkerColor.said,
      PracticeVerdict.incorrect => MarkerColor.hole,
      PracticeVerdict.unclear => null,
    };
    final ProgressSummary progress =
        ref.watch(progressControllerProvider).value ?? ProgressSummary.empty;
    final CaptureState capture = ref.watch(captureControllerProvider);
    final _LessonAvailability availability = _lessonAvailability(
      progress: progress,
      error: capture.error,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            children: <Widget>[
              SenpaiFace(
                key: Key('practice-face-${mood.name}'),
                mood: mood,
                size: 120,
              ),
              const SizedBox(height: AppSpacing.md),
              Center(
                child: marker == null
                    ? Text(
                        heading,
                        key: const Key('practice-result-heading'),
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.displaySmall,
                      )
                    : MarkerText(
                        heading,
                        key: const Key('practice-result-heading'),
                        marker: marker,
                        style: Theme.of(context).textTheme.displaySmall,
                      ),
              ),
              const SizedBox(height: AppSpacing.lg),
              _ResultAnswerCard(attempt: answer.attempt),
              const SizedBox(height: AppSpacing.md),
              _ScheduleBand(answer: answer),
            ],
          ),
        ),
        if (showLessonGate && verdict != PracticeVerdict.correct) ...<Widget>[
          _LessonGate(availability: availability, onUpgrade: onUpgrade),
          const SizedBox(height: AppSpacing.sm),
        ],
        switch (verdict) {
          PracticeVerdict.correct => ChunkyButton(
              key: const Key('practice-home'),
              label: strings.reviewBackHome,
              onPressed: onHome,
            ),
          PracticeVerdict.incorrect => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                ChunkyButton(
                  key: const Key('practice-ask-senpai'),
                  label: strings.reviewAskSenpai,
                  onPressed: capture.isSubmitting
                      ? null
                      : () => unawaited(onAskSenpai()),
                ),
                GhostButton(
                  key: const Key('practice-later'),
                  label: strings.reviewLater,
                  onPressed: capture.isSubmitting ? null : onLater,
                ),
              ],
            ),
          PracticeVerdict.unclear => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                ChunkyButton(
                  key: const Key('practice-retry'),
                  label: strings.practiceRetry,
                  onPressed: capture.isSubmitting ? null : onRetry,
                ),
                GhostButton(
                  key: const Key('practice-ask-senpai'),
                  label: strings.reviewAskSenpai,
                  onPressed: capture.isSubmitting
                      ? null
                      : () => unawaited(onAskSenpai()),
                ),
              ],
            ),
        },
      ],
    );
  }
}

class _ProblemCard extends StatelessWidget {
  const _ProblemCard({required this.problem});

  final PracticeProblem problem;

  @override
  Widget build(BuildContext context) {
    // 板書は黒板、問題は紙。授業画面の board_style.dart と同じ材質の境界を守る。
    return Container(
      key: const Key('practice-problem-card'),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 授業画面の紙カードと同じ形。何の枠かをラベルで言い切る。
          Text(
            AppStrings.of(context).sessionProblemTitle,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            problem.question,
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ],
      ),
    );
  }
}

class _ResultAnswerCard extends StatelessWidget {
  const _ResultAnswerCard({required this.attempt});

  final PracticeAttempt attempt;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String? comment = attempt.comment;

    return _PaperCard(
      cardKey: const Key('practice-result-answer'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(strings.practiceYourAnswer, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          Text(attempt.response, style: Theme.of(context).textTheme.bodyLarge),
          // 先輩の一言。**正解は書かない**(採点プロンプトが縛っている)ので、
          // ここに出るのは「どこまで合っていたか」と次の一手だけ。
          if (comment != null) ...<Widget>[
            const _PaperDivider(),
            Text(comment, style: Theme.of(context).textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}

class _ScheduleBand extends StatelessWidget {
  const _ScheduleBand({required this.answer});

  final PracticeAnswer answer;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final List<int> days = answer.nextSchedule
        .map((PracticeScheduleEntry entry) => entry.days)
        .toList(growable: false);
    final bool unclear = answer.attempt.verdict == PracticeVerdict.unclear;
    final String text =
        unclear ? strings.practiceScheduleUnclear : strings.practiceNextSchedule(days);

    return Container(
      key: const Key('practice-schedule'),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // 時計は「次にいつ」、丸い i は「今回は何も動かない」。
          // 同じ形の帯に**別の意味**を載せるので、印だけは分ける。
          Icon(
            unclear ? Icons.info_outline : Icons.schedule,
            size: 20,
            color: AppColors.inkMuted,
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(text, style: Theme.of(context).textTheme.bodySmall),
          ),
        ],
      ),
    );
  }
}

class _LessonGate extends StatelessWidget {
  const _LessonGate({required this.availability, required this.onUpgrade});

  final _LessonAvailability availability;
  final VoidCallback onUpgrade;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      children: <Widget>[
        Text(
          availability.showUpgrade
              ? strings.reviewVoicePremium
              : availability.message ?? strings.lessonEnoughForToday,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (availability.showUpgrade)
          TextButton(
            onPressed: onUpgrade,
            style: TextButton.styleFrom(foregroundColor: AppColors.blue),
            child: Text(strings.homeUnlock),
          ),
      ],
    );
  }
}

@immutable
class _LessonAvailability {
  const _LessonAvailability({
    required this.allowed,
    required this.showUpgrade,
    this.message,
  });

  final bool allowed;
  final bool showUpgrade;
  final String? message;
}

_LessonAvailability _lessonAvailability({
  required ProgressSummary progress,
  required ApiException? error,
}) {
  final bool premiumRequired =
      !progress.isPremium || error?.isPremiumRequired == true;
  final bool limitReached =
      error?.isFreeLimitReached == true || error?.isFairUseLimitReached == true;
  final bool allowed =
      !premiumRequired && progress.limits.lessonAllowedToday && !limitReached;
  final bool showUpgrade = error?.isFairUseLimitReached == true
      ? false
      : premiumRequired || error?.isFreeLimitReached == true;
  final String? message = !showUpgrade && error != null && !limitReached
      ? (error.message.isEmpty ? null : error.message)
      : null;
  return _LessonAvailability(
    allowed: allowed,
    showUpgrade: showUpgrade,
    message: message,
  );
}

class _MessageScaffold extends StatelessWidget {
  const _MessageScaffold({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: context.closeOrGoHome,
        ),
      ),
      body: SafeArea(child: child),
    );
  }
}

class _EmptyPractice extends StatelessWidget {
  const _EmptyPractice({required this.queue});

  final PracticeQueue queue;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: <Widget>[
        Text(
          strings.reviewEmpty,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        const SizedBox(height: AppSpacing.xl),
        Text(
          strings.practiceSolvedTitle(queue.solved.length),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.sm),
        for (final SolvedPractice solved in queue.solved)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
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
                  Text(
                    solved.problem.question,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    strings.practiceSolvedMeta(
                      solved.topicLabel,
                      solved.daysSinceSolved,
                    ),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        const SizedBox(height: AppSpacing.lg),
        GhostButton(
          label: strings.reviewBackHome,
          onPressed: context.closeOrGoHome,
        ),
      ],
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.text, this.primaryLabel, this.onPrimary});

  final String text;
  final String? primaryLabel;
  final VoidCallback? onPrimary;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(
            text,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: AppSpacing.lg),
          if (primaryLabel != null && onPrimary != null)
            ChunkyButton(label: primaryLabel!, onPressed: onPrimary),
          GhostButton(
            label: strings.reviewBackHome,
            onPressed: context.closeOrGoHome,
          ),
        ],
      ),
    );
  }
}
