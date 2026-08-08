import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/entitlement_controller.dart';
import 'purchase_messages.dart';

/// 契約の管理(RevenueCat の Customer Center)。
///
/// 解約・プラン変更・返金申請・購入の復元がここに入っている。
/// 自前で作ると App Review のたびに指摘が出る類の画面なので、
/// RevenueCat のものをそのまま出す。
///
/// 契約が無い人には出さない。ホームは静かな画面にしておきたいし、
/// 復元の導線はペイウォール側にある。
class ManageSubscriptionButton extends ConsumerWidget {
  const ManageSubscriptionButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Entitlement? entitlement = ref.watch(entitlementControllerProvider).value;

    if (entitlement == null || !entitlement.canManageSubscription) {
      return const SizedBox.shrink();
    }

    return TextButton.icon(
      onPressed: () async {
        final bool shown =
            await ref.read(entitlementControllerProvider.notifier).presentCustomerCenter();
        if (shown || !context.mounted) return;
        // 出せなかった(OSが古い等)。黙って何も起きないのが一番わるいので伝える。
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(strings.errorGeneric)));
      },
      icon: const Icon(Icons.settings_outlined, size: 18),
      label: Text(strings.manageSubscription, style: Theme.of(context).textTheme.bodySmall),
      style: TextButton.styleFrom(
        foregroundColor: AppColors.inkMuted,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}

/// 購入の復元。
///
/// ペイウォールにも同じものがあるが、**契約していない人にはペイウォールしか
/// 出口が無い**状態にはしたくない。機種変更した人が最初に探すのは設定なので、
/// ここにも置く(App Review でも復元導線は見られる)。
class RestorePurchasesButton extends ConsumerStatefulWidget {
  const RestorePurchasesButton({super.key});

  @override
  ConsumerState<RestorePurchasesButton> createState() => _RestorePurchasesButtonState();
}

class _RestorePurchasesButtonState extends ConsumerState<RestorePurchasesButton> {
  bool _busy = false;

  Future<void> _restore() async {
    final AppStrings strings = AppStrings.of(context);
    setState(() => _busy = true);

    final RestoreOutcome outcome =
        await ref.read(entitlementControllerProvider.notifier).restore();
    if (!mounted) return;
    setState(() => _busy = false);

    switch (outcome) {
      // 戻せたときは SnackBar で済ませない。機種変更でここへ来た人にとっては、
      // 契約が戻った瞬間がいちばん不安な瞬間なので、ペイウォールから買った人と
      // 同じ画面で「おかえりなさい」と出す。設定は残す(push で重ねる)。
      case RestoreSucceeded():
        context.pushThanks(restored: true);
      // 「失敗」ではない。見つからなかった、と正直に出す。
      case RestoreFoundNothing():
        _tell(strings.paywallRestoredNothing);
      case RestoreFailed(:final PurchaseFailure failure):
        _tell(failure.message(strings));
    }
  }

  void _tell(String message) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    // 鍵の無いビルドでは押しても何も起きないので、行ごと出さない。
    if (!RevenueCatConfig.isConfigured) return const SizedBox.shrink();

    return ListTile(
      title: Text(strings.paywallRestore, style: Theme.of(context).textTheme.bodyMedium),
      trailing: _busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.refresh, size: 18, color: AppColors.inkMuted),
      onTap: _busy ? null : _restore,
    );
  }
}

/// 契約の状態。設定の「契約」セクションの先頭に出す。
///
/// 一行のテキストではなくカードにしてあるのは、**契約している印がここにしか
/// 無い**ため。ホーム右上のチップ([PremiumChip])を押した人が着地する先でも
/// あるので、状態と次に起きること(更新日・終了日・課金開始日)をここで言い切る。
///
/// 「あと◯日で終わります」と急かすのではなく、
/// 「それまではこのまま使えます」と書く(§6 煽らない)。
class SubscriptionStatusCard extends ConsumerWidget {
  const SubscriptionStatusCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Entitlement? entitlement = ref.watch(entitlementControllerProvider).value;

    // 契約していない人には出さない。ここに「無料プランです」と書くと、
    // 設定を開くたびに売り込まれているように読める。
    if (entitlement == null || !entitlement.isPremium) return const SizedBox.shrink();

    final DateTime? expiresAt = entitlement.expiresAt;
    final String? date = expiresAt == null ? null : strings.date(expiresAt);
    final String? note = switch (entitlement) {
      // 無料期間中は、更新日ではなく**課金が始まる日**を言う。
      Entitlement(isTrial: true) when date != null => strings.premiumBillingStarts(date),
      Entitlement(isCancelled: true) when date != null => strings.premiumEndsOn(date),
      _ when date != null => strings.premiumRenewsOn(date),
      _ => null,
    };

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.blue.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.blue),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(strings.premiumBadge, style: Theme.of(context).textTheme.titleMedium),
              const Spacer(),
              _StateBadge(
                label: entitlement.isTrial ? strings.premiumTrialBadge : strings.premiumActive,
              ),
            ],
          ),
          if (note != null) ...<Widget>[
            const SizedBox(height: AppSpacing.xs),
            Text(note, style: Theme.of(context).textTheme.bodySmall),
          ],
        ],
      ),
    );
  }
}

/// 「有効」「無料おためし中」。塗りのピルは押せるものに見えるので、
/// 押せるもの(チップ)と取り違えないよう、こちらは小さく色を薄くしておく。
class _StateBadge extends StatelessWidget {
  const _StateBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 2),
      decoration: BoxDecoration(
        color: AppColors.blue,
        borderRadius: BorderRadius.circular(AppRadius.chip),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: AppColors.surface,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

/// 契約している印(ホーム右上)。
///
/// **ランクでも称号でもない。** 数えるのは連続日数と埋めた穴だけなので
/// (handoff §7)、数字を持たせず、色も主役のブルーの枠線だけに留める。
/// 塗りにすると厚いボタンと同じ重さになって、押すもののように見えてしまう。
///
/// 押すと設定へ飛ぶ。契約の状態と更新日はそこ([SubscriptionStatusCard])にある。
class PremiumChip extends ConsumerWidget {
  const PremiumChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    if (!ref.watch(isPremiumProvider)) return const SizedBox.shrink();

    return Semantics(
      button: true,
      label: strings.premiumBadge,
      child: InkWell(
        onTap: () => context.push(AppRoute.settings.path),
        borderRadius: BorderRadius.circular(AppRadius.chip),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 2),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.chip),
            border: Border.all(color: AppColors.blue, width: 1.5),
          ),
          child: Text(
            strings.premiumBadge,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: AppColors.blue,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}
