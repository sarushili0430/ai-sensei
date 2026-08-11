import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../../session/domain/session.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';
import 'hole_self_report_prompt.dart';

/// 復習画面(ホームのカード、またはプッシュ通知が起点)。
///
/// 出すものは2つ。**埋めにいく穴**(これからやること)と
/// **埋めた穴**(やってきたこと)。後者がペイウォールの謳う「履歴」で、
/// 別画面は作らない。
///
/// どの状態でも必ず出口を持たせる。ここは通知から直接着地しうる画面なので、
/// 「読み込み中のまま」「文言だけ」で行き止まりにすると本当に戻れなくなる。
class ReviewScreen extends ConsumerWidget {
  const ReviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ReviewQueue> queue = ref.watch(reviewControllerProvider);

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
            onPrimary: () => ref.read(reviewControllerProvider.notifier).refresh(),
          ),
          data: (ReviewQueue data) {
            if (data.requiresPremium) {
              return _Message(
                text: strings.reviewLocked,
                primaryLabel: strings.paywallCta,
                onPrimary: () => context.push(AppRoute.paywall.path),
              );
            }
            if (data.isEmpty) {
              return _Message(text: strings.reviewEmpty);
            }
            return ListView(
              padding: const EdgeInsets.all(AppSpacing.lg),
              children: <Widget>[
                for (final ReviewQueueItem item in data.items) ...<Widget>[
                  _ReviewCard(item: item),
                  const SizedBox(height: AppSpacing.md),
                ],
                if (data.items.isEmpty)
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
          },
        ),
      ),
    );
  }
}

class _ReviewCard extends ConsumerWidget {
  const _ReviewCard({required this.item});

  final ReviewQueueItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
          // 先輩の声のひとこと。通知文と同じものを見せて、続きだと分かるようにする。
          Text(item.prompt, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: AppSpacing.sm),
          Text(item.hole.description, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          ChunkyButton(
            label: strings.reviewStart,
            // ここではまだマイクを開かない。本人の「言えた」だけで終える道を
            // 先に出し、「まだ。先輩と見直す」を選んだときだけ会話を作る。
            onPressed: () => _openSelfReport(context, ref),
          ),
        ],
      ),
    );
  }

  Future<void> _openSelfReport(BuildContext context, WidgetRef ref) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext sheetContext) => SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          AppSpacing.lg,
          AppSpacing.lg,
          AppSpacing.lg,
          AppSpacing.lg + MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: HoleSelfReportPrompt(
          hole: item.hole,
          onFilled: () => Navigator.of(sheetContext).pop(),
          // 「まだ」は閉じるだけ。openのまま残るので、何も失わない。
          onNotYet: () => Navigator.of(sheetContext).pop(),
          onReview: () async {
            Navigator.of(sheetContext).pop();
            await _startReview(context, ref);
          },
        ),
      ),
    );
  }

  Future<void> _startReview(BuildContext context, WidgetRef ref) async {
    // 復習は写真を使わず、この穴を起点にサーバ側でセッションを作る。
    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .startReview(
          item.hole.id,
          locale: Localizations.localeOf(context).languageCode,
        );
    // 会話は一方通行。戻る先を持たせない。
    if (session != null && context.mounted) context.go(AppRoute.session.path);
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
          Text(strings.reviewFilledEmpty, style: Theme.of(context).textTheme.bodySmall)
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
