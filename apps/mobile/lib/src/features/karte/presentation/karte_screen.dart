import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// カルテ画面。
///
/// **静かな画面**にする(handoff §7「騒がしい/静かの分離」)。
/// 内省する場所なので、祝福画面のにぎやかさを持ち込まない。
/// 点数は出さない。穴は「これから埋まる場所」として提示する。
class KarteScreen extends ConsumerWidget {
  const KarteScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Karte? karte = ref.watch(latestKarteProvider);

    if (karte == null) {
      return Scaffold(
        appBar: AppBar(title: Text(strings.karteTitle)),
        body: Center(child: Text(strings.errorGeneric)),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(strings.karteTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: <Widget>[
            _Section(
              title: strings.karteSaidWell,
              children: karte.saidWell
                  .map((String it) => MarkerText(it, marker: MarkerColor.said))
                  .toList(growable: false),
            ),
            const SizedBox(height: AppSpacing.lg),
            _Section(
              title: strings.karteHoles(karte.holes.length),
              children: karte.holes.isEmpty
                  ? <Widget>[Text(strings.karteNoHoles)]
                  : karte.holes
                      .map((Hole it) => MarkerText(it.description, marker: MarkerColor.hole))
                      .toList(growable: false),
            ),
            if (karte.termNotes.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _Section(
                title: strings.karteTermNotes,
                children: karte.termNotes
                    .map((String it) => Text(it, style: Theme.of(context).textTheme.bodyMedium))
                    .toList(growable: false),
              ),
            ],
            if (karte.followupQuestion != null) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _FollowupCard(question: karte.followupQuestion!),
            ],
            const SizedBox(height: AppSpacing.xl),
            if (karte.holes.isNotEmpty)
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  borderRadius: BorderRadius.circular(AppRadius.card),
                  border: Border.all(color: AppColors.border),
                ),
                child: Text(
                  strings.karteReviewToggle,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            const SizedBox(height: AppSpacing.lg),
            if (karte.holes.isNotEmpty)
              ChunkyButton(
                label: strings.karteRetry,
                onPressed: () => context.go(AppRoute.review.path),
              ),
            GhostButton(
              label: strings.karteDone,
              onPressed: () => context.go(AppRoute.home.path),
            ),
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        for (final Widget child in children)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Align(alignment: Alignment.centerLeft, child: child),
          ),
      ],
    );
  }
}

/// 後輩のあと追い質問(Premium)。
class _FollowupCard extends StatelessWidget {
  const _FollowupCard({required this.question});

  final String question;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.blue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      child: Text(question, style: Theme.of(context).textTheme.bodyLarge),
    );
  }
}
