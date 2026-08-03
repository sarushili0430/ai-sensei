import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// 復習画面(プッシュ通知が起点)。
///
/// 無料ユーザーには「使えない」ではなく「まだ開いていない」として見せる。
class ReviewScreen extends ConsumerWidget {
  const ReviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ReviewQueue> queue = ref.watch(reviewControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(strings.reviewTitle)),
      body: SafeArea(
        child: queue.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (Object error, StackTrace stack) => Center(child: Text(strings.errorGeneric)),
          data: (ReviewQueue data) {
            if (data.requiresPremium) {
              return _PremiumNotice(onTap: () => context.go(AppRoute.paywall.path));
            }
            if (data.items.isEmpty) {
              return Center(child: Text(strings.karteNoHoles));
            }
            return ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.lg),
              itemCount: data.items.length,
              separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
              itemBuilder: (BuildContext context, int index) =>
                  _ReviewCard(item: data.items[index]),
            );
          },
        ),
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.item});

  final ReviewQueueItem item;

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
          // 後輩の声のひとこと。通知文と同じものを見せて、続きだと分かるようにする。
          Text(item.prompt, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: AppSpacing.sm),
          Text(item.hole.description, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          ChunkyButton(
            label: strings.reviewStart,
            onPressed: () => context.go('${AppRoute.session.path}?hole=${item.hole.id}'),
          ),
        ],
      ),
    );
  }
}

class _PremiumNotice extends StatelessWidget {
  const _PremiumNotice({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(
            strings.reviewLocked,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: AppSpacing.lg),
          ChunkyButton(label: strings.paywallCta, onPressed: onTap),
        ],
      ),
    );
  }
}
