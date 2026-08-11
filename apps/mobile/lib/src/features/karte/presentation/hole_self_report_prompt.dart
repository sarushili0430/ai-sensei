import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// 穴を埋めるかどうかを、本人にだけ聞くカード。
///
/// 「言えた」を押したときだけAPIを呼ぶ。「まだ」は画面を閉じるだけで、穴・通知・
/// 進捗のどれも変えない。二択を置くのは、閉じる操作を失敗や減点に見せないため。
/// AIの判定結果を受け取る入口は持たない(計画書 §2)。送信経路と二択の文言は
/// 10秒小テストと共有し、画面ごとに別の「自己申告」を作らない。
class HoleSelfReportPrompt extends ConsumerStatefulWidget {
  const HoleSelfReportPrompt({
    required this.hole,
    required this.onFilled,
    required this.onNotYet,
    this.showLaterHint = false,
    super.key,
  });

  final Hole hole;
  final VoidCallback onFilled;
  final VoidCallback onNotYet;
  final bool showLaterHint;

  @override
  ConsumerState<HoleSelfReportPrompt> createState() =>
      _HoleSelfReportPromptState();
}

class _HoleSelfReportPromptState extends ConsumerState<HoleSelfReportPrompt> {
  bool _submitting = false;

  Future<void> _fill() async {
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      final bool succeeded = await ref
          .read(reviewControllerProvider.notifier)
          .answer(widget.hole.id, ReviewOutcome.saidIt);
      if (!mounted) return;
      if (!succeeded) {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(AppStrings.of(context).errorGeneric)),
        );
        return;
      }
      widget.onFilled();
    } on Object catch (error) {
      // 失敗しても open のままなので、本人の記録は失われない。再送はAPI側が冪等。
      debugPrint('穴の自己申告を反映できませんでした: $error');
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).errorGeneric)),
      );
    }
  }

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
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            strings.holeSelfReportQuestion,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            widget.hole.description,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            strings.holeSelfReportNoPressure,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (widget.showLaterHint) ...<Widget>[
            const SizedBox(height: AppSpacing.xs),
            Text(
              strings.holeSelfReportLater,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          ChunkyButton(
            label: _submitting
                ? strings.holeSelfReportFilling
                : strings.reviewSaidIt,
            onPressed: _submitting ? null : _fill,
          ),
          GhostButton(
            label: strings.reviewNotYet,
            onPressed: _submitting ? null : widget.onNotYet,
          ),
        ],
      ),
    );
  }
}
