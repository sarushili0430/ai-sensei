import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../../session/domain/session.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// 復習画面(ホームのカード、またはプッシュ通知が起点)。
///
/// 出すものは2つ。**埋めにいく穴**(これからやること)と
/// **埋めた穴**(やってきたこと)。後者がペイウォールの謳う「履歴」で、
/// 別画面は作らない。
///
/// どの状態でも必ず出口を持たせる。ここは通知から直接着地しうる画面なので、
/// 「読み込み中のまま」「文言だけ」で行き止まりにすると本当に戻れなくなる。
class ReviewScreen extends ConsumerStatefulWidget {
  const ReviewScreen({super.key});

  @override
  ConsumerState<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends ConsumerState<ReviewScreen> {
  /// 「まだ」を選んだ穴。キューが次へ進めばIDが変わるので、自動で質問状態に戻る。
  String? _notYetHoleId;
  bool _isAnswering = false;
  bool _answerFailed = false;
  bool _showLessonError = false;

  Future<void> _answer(ReviewQueueItem item) async {
    setState(() {
      _isAnswering = true;
      _answerFailed = false;
    });

    final bool succeeded = await ref
        .read(reviewControllerProvider.notifier)
        .answer(item.hole.id, ReviewOutcome.saidIt);
    if (!mounted) return;

    setState(() {
      _isAnswering = false;
      _answerFailed = !succeeded;
      if (succeeded) _notYetHoleId = null;
    });
  }

  void _chooseNotYet(ReviewQueueItem item) {
    // 「まだ」だけではサーバへ送らない。穴はopenのまま、次の行き先を本人が選べる。
    setState(() {
      _notYetHoleId = item.hole.id;
      _answerFailed = false;
      _showLessonError = false;
    });
  }

  void _later() {
    setState(() {
      _notYetHoleId = null;
      _showLessonError = false;
    });
  }

  void _openPaywall() {
    setState(() => _showLessonError = false);
    context.push(AppRoute.paywall.path);
  }

  Future<void> _startLesson(ReviewQueueItem item) async {
    setState(() => _showLessonError = false);

    // 復習授業は写真を使わず、この穴を起点にサーバ側でセッションを作る。
    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .startReview(
          item.hole.id,
          locale: Localizations.localeOf(context).languageCode,
        );
    if (!mounted) return;

    // 会話は一方通行。戻る先を持たせない。
    if (session != null) {
      context.go(AppRoute.session.path);
    } else {
      // startReview は失敗理由を CaptureState に残す。黙って元の画面に留めない。
      setState(() => _showLessonError = true);
    }
  }

  Widget _content({
    required AppStrings strings,
    required ReviewQueue data,
    required ProgressSummary progress,
    required CaptureState capture,
  }) {
    // §2「1回1問」。残りをリストにせず、先頭の1件だけを大きく出す。
    final ReviewQueueItem? item = data.items.isEmpty ? null : data.items.first;
    final bool notYet = item != null && _notYetHoleId == item.hole.id;
    final ApiException? lessonError = notYet && _showLessonError
        ? capture.error
        : null;
    final bool premiumRequired =
        !progress.isPremium || lessonError?.isPremiumRequired == true;
    final bool lessonLimitReached =
        lessonError != null &&
        (lessonError.isFreeLimitReached || lessonError.isFairUseLimitReached);
    final bool lessonAllowedToday =
        !premiumRequired &&
        progress.limits.lessonAllowedToday &&
        !lessonLimitReached;
    // エラーの code が返った競合時は、直前の進捗よりサーバの判定を優先する。
    final bool showUpgrade = lessonError?.isFairUseLimitReached == true
        ? false
        : premiumRequired || lessonError?.isFreeLimitReached == true;

    String? errorMessage;
    if (!notYet && _answerFailed) {
      errorMessage = strings.errorGeneric;
    } else if (notYet &&
        _showLessonError &&
        !lessonLimitReached &&
        !premiumRequired) {
      // 日次上限以外は、撮影画面と同じくサーバの理由をそのまま出す。
      final String message = lessonError?.message ?? strings.errorGeneric;
      errorMessage = message.isEmpty ? strings.errorGeneric : message;
    }

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: <Widget>[
        if (item != null) ...<Widget>[
          _ReviewCard(
            item: item,
            notYet: notYet,
            isBusy: _isAnswering || (notYet && capture.isSubmitting),
            lessonAllowedToday: lessonAllowedToday,
            showUpgrade: showUpgrade,
            errorMessage: errorMessage,
            onSaidIt: () => _answer(item),
            onNotYet: () => _chooseNotYet(item),
            // 声を使う復習授業はPremium。契約と日次枠の両方が通るときだけ呼ぶ。
            onAskSenpai: () => _startLesson(item),
            onUpgrade: _openPaywall,
            onLater: _later,
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        if (item == null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: Text(
              strings.reviewEmpty,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        const SizedBox(height: AppSpacing.lg),
        _FilledSection(filled: data.filled),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ReviewQueue> queue = ref.watch(reviewControllerProvider);
    final AsyncValue<ProgressSummary> progress = ref.watch(
      progressControllerProvider,
    );
    final CaptureState capture = ref.watch(captureControllerProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.reviewTitle),
        // 通知から直接来たときは戻る先が積まれていない。ホームへ逃がす。
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: context.closeOrGoHome,
        ),
      ),
      body: SafeArea(
        child: queue.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (Object error, StackTrace stack) => _Message(
            text: strings.errorGeneric,
            primaryLabel: strings.errorRetry,
            onPrimary: () =>
                ref.read(reviewControllerProvider.notifier).refresh(),
          ),
          data: (ReviewQueue data) {
            if (data.isEmpty) {
              return _Message(text: strings.reviewEmpty);
            }
            // **進捗の取得で小テストを人質に取らない。**
            //
            // 小テストは「1問・テキストで10秒」が売りで、答えるのに要るのは
            // キューだけ。進捗を使うのは「先輩に聞く」のPremium判定と
            // `lessonAllowedToday`だけなので、そちらが取れなくても
            // 言えた / まだ言えない は答えられなければならない。
            //
            // 取れていないあいだは「枠が無い」側に倒す。授業へ進ませてから
            // サーバに断られるより、いま答えられることを優先する
            // (押せたのに断られるのが、いちばん信用を落とす)。
            return _content(
              strings: strings,
              data: data,
              progress: progress.value ?? ProgressSummary.empty,
              capture: capture,
            );
          },
        ),
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({
    required this.item,
    required this.notYet,
    required this.isBusy,
    required this.lessonAllowedToday,
    required this.showUpgrade,
    required this.onSaidIt,
    required this.onNotYet,
    required this.onAskSenpai,
    required this.onUpgrade,
    required this.onLater,
    this.errorMessage,
  });

  final ReviewQueueItem item;
  final bool notYet;
  final bool isBusy;
  final bool lessonAllowedToday;
  final bool showUpgrade;
  final VoidCallback onSaidIt;
  final VoidCallback onNotYet;
  final VoidCallback onAskSenpai;
  final VoidCallback onUpgrade;
  final VoidCallback onLater;
  final String? errorMessage;

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
          if (notYet) ...<Widget>[
            // 「まだ」を咎めず、ここから先は先輩が引き取る。
            Text(
              strings.reviewNotYetLead,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: AppSpacing.md),
            if (lessonAllowedToday) ...<Widget>[
              if (errorMessage != null) ...<Widget>[
                Text(
                  errorMessage!,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: AppSpacing.md),
              ],
              ChunkyButton(
                label: strings.reviewAskSenpai,
                onPressed: isBusy ? null : onAskSenpai,
              ),
            ] else ...<Widget>[
              if (showUpgrade) ...<Widget>[
                // 小テストは閉じない。従量原価が始まる音声授業だけが境界だと伝える。
                Text(
                  strings.reviewVoicePremium,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                TextButton(
                  onPressed: onUpgrade,
                  style: TextButton.styleFrom(
                    foregroundColor: AppColors.blue,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.sm,
                    ),
                  ),
                  child: Text(
                    strings.homeUnlock,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ] else
                // Premiumのフェアユース上限は、先輩が今日の学習を締める判断として伝える。
                Text(
                  strings.lessonEnoughForToday,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
            const SizedBox(height: AppSpacing.sm),
            GhostButton(
              label: strings.reviewLater,
              onPressed: isBusy ? null : onLater,
            ),
          ] else ...<Widget>[
            // 先輩の声のひとこと。通知文と同じものを見せて、続きだと分かるようにする。
            Text(item.prompt, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.md),
            Text(item.quiz, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.lg),
            if (errorMessage != null) ...<Widget>[
              Text(errorMessage!, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: AppSpacing.md),
            ],
            ChunkyButton(
              label: strings.reviewSaidIt,
              onPressed: isBusy ? null : onSaidIt,
            ),
            const SizedBox(height: AppSpacing.sm),
            // 「まだ」は選んでも損しない選択肢。約束3を GhostButton の形にする。
            GhostButton(
              label: strings.reviewNotYet,
              onPressed: isBusy ? null : onNotYet,
            ),
          ],
        ],
      ),
    );
  }
}

/// 埋めた穴。ペイウォールが謳う Premium の「履歴」はここ。
///
/// 静かに置く。祝福画面のにぎやかさは持ち込まない(handoff §7)。
class _FilledSection extends StatelessWidget {
  const _FilledSection({required this.filled});

  final List<FilledHole> filled;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          strings.reviewFilledTitle(filled.length),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (filled.isEmpty)
          Text(
            strings.reviewFilledEmpty,
            style: Theme.of(context).textTheme.bodySmall,
          )
        else
          // 埋めた穴は、ピンクではなく黄で引き直される。
          // 上から順に引くことで、積み上がってきたものとして見える。
          for (int i = 0; i < filled.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  MarkerText(
                    filled[i].hole.description,
                    marker: MarkerColor.said,
                    delay: AppDurations.draw * i,
                  ),
                  Text(
                    strings.reviewFilledDays(filled[i].daysSinceFilled),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
      ],
    );
  }
}

/// 中身が出せないときの画面。**必ずホームに戻れる**ようにする。
class _Message extends StatelessWidget {
  const _Message({required this.text, this.primaryLabel, this.onPrimary});

  final String text;
  final String? primaryLabel;
  final VoidCallback? onPrimary;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String? label = primaryLabel;

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
          if (label != null && onPrimary != null)
            ChunkyButton(label: label, onPressed: onPrimary),
          GhostButton(
            label: strings.reviewBackHome,
            onPressed: context.closeOrGoHome,
          ),
        ],
      ),
    );
  }
}
