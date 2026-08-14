import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// Card that asks only the student whether a gap is filled.
///
/// The API is called only on "said it". "Not yet" just closes the card, leaving
/// the gap, notifications and progress untouched. Two options exist so closing
/// never reads as a failure or a deduction. There is no entry point for an AI
/// verdict. The submit path and both labels are shared with the 10-second quiz,
/// so no screen invents its own self-report.
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
      // On failure the gap stays open, so nothing they recorded is lost.
      // Resending is idempotent on the API side.
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
