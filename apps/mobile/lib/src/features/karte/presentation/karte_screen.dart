import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:permission_handler/permission_handler.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../notifications/application/push_controller.dart';
import '../../notifications/data/push_repository.dart';
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
    final Karte? karte = ref.watch(latestKarteControllerProvider);
    final bool showPaywall = ref.watch(sessionOutcomeControllerProvider).showPaywall;

    // 直近のカルテが無いときはルータがホームへ戻す(app_router.dart の redirect)。
    // ここに来るのはその1フレームぶんなので、エラー文言は出さない。
    if (karte == null) {
      return Scaffold(
        appBar: AppBar(title: Text(strings.karteTitle)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(strings.karteTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: <Widget>[
            // マーカーは上の行から順に引かれる。今日の会話が書き取られていく順。
            // 速くしない — ここは読み返す画面なので、走らせると落ち着かない。
            _Section(
              title: strings.karteSaidWell,
              children: <Widget>[
                for (int i = 0; i < karte.saidWell.length; i++)
                  MarkerText(
                    karte.saidWell[i],
                    marker: MarkerColor.said,
                    delay: AppDurations.draw * i,
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
            _Section(
              title: strings.karteHoles(karte.holes.length),
              children: karte.holes.isEmpty
                  ? <Widget>[Text(strings.karteNoHoles)]
                  : <Widget>[
                      for (int i = 0; i < karte.holes.length; i++)
                        MarkerText(
                          karte.holes[i].description,
                          marker: MarkerColor.hole,
                          // 言えたことを引き終わってから、穴に移る。
                          delay: AppDurations.draw * (karte.saidWell.length + i),
                        ),
                    ],
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
            if (karte.holes.isNotEmpty) const _ReviewReminderCard(),
            const SizedBox(height: AppSpacing.lg),
            if (karte.holes.isNotEmpty)
              ChunkyButton(
                label: strings.karteRetry,
                onPressed: () => context.push(AppRoute.review.path),
              ),
            GhostButton(
              label: strings.karteDone,
              // 初回カルテで穴が見えた直後だけ、ここでペイウォールを挟む。
              // 出す/出さないの判断はサーバが持つ(煽らないため2回目以降は出さない)。
              onPressed: () => context.go(
                showPaywall ? AppRoute.paywall.path : AppRoute.home.path,
              ),
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

/// あしたの夜、もう一度きいてもいいか。
///
/// **通知の許可を求めるのはアプリ中でここだけ。** 初回起動では聞かない。
/// 穴が見つかった直後、先輩からのお願いとして尋ねるほうが文脈が立つし、
/// ここで断られても「翌日・3日後・7日後」の価値は伝わっている。
///
/// スイッチをアプリ側に持たないのは、OSの許可がそのまま状態だから。
/// 二重に持つと「アプリではオンなのに届かない」が生まれる。
class _ReviewReminderCard extends ConsumerWidget {
  const _ReviewReminderCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final PushPermission permission = ref.watch(pushPermissionControllerProvider);

    // 通知を扱えないビルドでは、約束の文言だけを静かに出す。
    final bool granted = permission.granted || !permission.available;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              granted ? strings.karteReviewToggle : strings.karteReviewAsk,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          if (permission.available)
            Switch(
              value: permission.granted,
              activeThumbColor: AppColors.blue,
              onChanged: (bool wantsOn) async {
                // 切るのは設定アプリで。アプリ側に別のスイッチを作らない。
                if (!wantsOn) {
                  await openAppSettings();
                  return;
                }
                final bool ok =
                    await ref.read(pushPermissionControllerProvider.notifier).request();
                if (ok || !context.mounted) return;
                // 一度断られると、iOSはもうダイアログを出さない。設定への行き方を伝える。
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(strings.karteReviewDenied),
                    action: SnackBarAction(
                      label: strings.settingsNotificationsOpenSettings,
                      onPressed: openAppSettings,
                    ),
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

/// 先輩のあと追い質問(Premium)。
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
