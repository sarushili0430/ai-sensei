import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/plan_controller.dart';
import '../domain/study_plan.dart';

/// Study plan built by voice.
///
/// No input fields at all: making dates, scope and materials editable on
/// screen would recreate the form we rejected, so both creating and reworking
/// start at the same mic. Once a plan exists we show only per-day facts — no
/// completion or progress percentages.
class PlanScreen extends ConsumerStatefulWidget {
  const PlanScreen({super.key});

  @override
  ConsumerState<PlanScreen> createState() => _PlanScreenState();
}

class _PlanScreenState extends ConsumerState<PlanScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(planControllerProvider.notifier).load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final PlanState state = ref.watch(planControllerProvider);

    ref.listen<PlanState>(planControllerProvider, (
      PlanState? previous,
      PlanState next,
    ) {
      if (next.premiumRequired && previous?.premiumRequired != true) {
        ref.read(planControllerProvider.notifier).acknowledgePremiumRequired();
        unawaited(context.push(AppRoute.paywall.path));
      }
    });

    return Scaffold(
      appBar: AppBar(title: Text(strings.planTitle)),
      body: SafeArea(
        top: false,
        child: switch (state.phase) {
          PlanPhase.loading => const Center(child: CircularProgressIndicator()),
          PlanPhase.connecting ||
          PlanPhase.listening ||
          PlanPhase.senpaiSpeaking => _PlanConversation(state: state),
          PlanPhase.saving => const _PlanSaving(),
          PlanPhase.failed => _PlanFailed(state: state),
          PlanPhase.ready => _PlanReady(state: state),
        },
      ),
    );
  }
}

class _PlanConversation extends ConsumerWidget {
  const _PlanConversation({required this.state});

  final PlanState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final bool connecting = state.phase == PlanPhase.connecting;
    final bool listening = state.phase == PlanPhase.listening;
    final String subtitle = connecting
        ? strings.planConnecting
        : state.lastSenpaiText ?? strings.planListening;

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        children: <Widget>[
          const Spacer(),
          SenpaiFace(
            mood: listening ? SenpaiMood.listening : SenpaiMood.neutral,
            size: 160,
          ),
          const SizedBox(height: AppSpacing.lg),
          SpeakingWave(active: listening),
          const SizedBox(height: AppSpacing.lg),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 180),
            child: Text(
              subtitle,
              key: ValueKey<String>(subtitle),
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
          ),
          const Spacer(),
          GhostButton(
            label: strings.planEndConversation,
            onPressed: connecting
                ? null
                : () => ref.read(planControllerProvider.notifier).finish(),
          ),
        ],
      ),
    );
  }
}

class _PlanSaving extends StatelessWidget {
  const _PlanSaving();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const SenpaiFace(mood: SenpaiMood.neutral, size: 140),
            const SizedBox(height: AppSpacing.lg),
            const CircularProgressIndicator(),
            const SizedBox(height: AppSpacing.lg),
            Text(strings.planSaving, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

class _PlanFailed extends ConsumerWidget {
  const _PlanFailed({required this.state});

  final PlanState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final String message = switch (state.failure) {
      PlanFailure.load => strings.planLoadFailed,
      PlanFailure.senpaiUnavailable => strings.planSenpaiUnavailable,
      PlanFailure.connection || null => strings.planConnectionFailed,
    };
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const SenpaiFace(mood: SenpaiMood.puzzled, size: 140),
            const SizedBox(height: AppSpacing.lg),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: AppSpacing.xl),
            ChunkyButton(
              label: strings.errorRetry,
              onPressed: () {
                final PlanController controller = ref.read(
                  planControllerProvider.notifier,
                );
                if (state.failure == PlanFailure.load) {
                  controller.load();
                } else {
                  controller.retryConnection();
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _PlanReady extends ConsumerWidget {
  const _PlanReady({required this.state});

  final PlanState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final StudyPlan? plan = state.plan;
    final String locale = Localizations.localeOf(context).languageCode == 'en'
        ? 'en'
        : 'ja';
    final String? revisionSaid = plan != null && plan.revisions.isNotEmpty
        ? plan.revisions.last.said
        : null;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: <Widget>[
        if (plan == null) ...<Widget>[
          const SizedBox(height: AppSpacing.xl),
          const Center(child: SenpaiFace(mood: SenpaiMood.neutral, size: 150)),
          const SizedBox(height: AppSpacing.xl),
          Text(
            strings.planIntroTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            strings.planIntroBody,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: AppSpacing.xl),
        ] else ...<Widget>[
          _PlanHeader(plan: plan),
          if (state.resultPending) ...<Widget>[
            const SizedBox(height: AppSpacing.md),
            _PlanNotice(text: strings.planResultPending),
          ],
          if (revisionSaid case final String said) ...<Widget>[
            const SizedBox(height: AppSpacing.md),
            _PlanNotice(text: strings.planRevisionNote(said)),
          ],
          const SizedBox(height: AppSpacing.xl),
          for (final PlanDay day in plan.days) ...<Widget>[
            _PlanDaySection(day: day, plan: plan),
            const SizedBox(height: AppSpacing.lg),
          ],
        ],
        ChunkyButton(
          label: plan == null ? strings.planCreate : strings.planRebuild,
          onPressed: () =>
              ref.read(planControllerProvider.notifier).start(locale),
        ),
      ],
    );
  }
}

class _PlanHeader extends StatelessWidget {
  const _PlanHeader({required this.plan});

  final StudyPlan plan;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final PlanIntake intake = plan.intake;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(intake.examName, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: AppSpacing.xs),
          Text(
            strings.planExamDate(_displayDate(strings, intake.examDate)),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            strings.planScope,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          Text(intake.scope.said),
          const SizedBox(height: AppSpacing.md),
          Text(
            strings.planMaterials,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          Text(
            intake.materials.isEmpty
                ? strings.planNoMaterials
                : intake.materials.join(' / '),
          ),
        ],
      ),
    );
  }
}

class _PlanDaySection extends StatelessWidget {
  const _PlanDaySection({required this.day, required this.plan});

  final PlanDay day;
  final StudyPlan plan;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          _displayDate(strings, day.date),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (day.items.isEmpty)
          Text(
            strings.planRestDay,
            style: Theme.of(context).textTheme.bodyMedium,
          )
        else
          for (final PlanItem item in day.items)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: _PlanItemRow(item: item, materials: plan.intake.materials),
            ),
      ],
    );
  }
}

class _PlanItemRow extends StatelessWidget {
  const _PlanItemRow({required this.item, required this.materials});

  final PlanItem item;
  final List<String> materials;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final int? materialIndex = item.material;
    final String? material =
        materialIndex != null && materialIndex < materials.length
        ? materials[materialIndex]
        : null;
    final IconData statusIcon = switch (item.status) {
      PlanItemStatus.todo => Icons.radio_button_unchecked,
      PlanItemStatus.done => Icons.check_circle_outline,
      PlanItemStatus.moved => Icons.arrow_forward,
    };

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(statusIcon, size: 20, color: AppColors.blue),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  strings.planSubject(item.topicId),
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: AppColors.inkMuted),
                ),
                Text(item.what, style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  <String>[
                    ?material,
                    strings.planMinutes(item.minutes),
                    strings.planItemStatus(item.status.name),
                  ].join(' ・ '),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PlanNotice extends StatelessWidget {
  const _PlanNotice({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.blue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      child: Text(text),
    );
  }
}

String _displayDate(AppStrings strings, String value) {
  final DateTime? date = DateTime.tryParse(value);
  return date == null ? value : strings.date(date);
}
