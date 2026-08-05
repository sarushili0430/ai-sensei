import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../l10n/strings.dart';
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

    final String message = switch (outcome) {
      RestoreSucceeded() => strings.paywallRestored,
      // 「失敗」ではない。見つからなかった、と正直に出す。
      RestoreFoundNothing() => strings.paywallRestoredNothing,
      RestoreFailed(:final PurchaseFailure failure) => failure.message(strings),
    };
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

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

/// 契約の状態をひとこと添える。解約予約済みなら期限を出す。
///
/// 「あと◯日で終わります」と急かすのではなく、
/// 「それまではこのまま使えます」と書く(§6 煽らない)。
class SubscriptionStatusLine extends ConsumerWidget {
  const SubscriptionStatusLine({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Entitlement? entitlement = ref.watch(entitlementControllerProvider).value;
    final DateTime? expiresAt = entitlement?.expiresAt;

    if (entitlement == null || !entitlement.isPremium || expiresAt == null) {
      return const SizedBox.shrink();
    }

    final String text = entitlement.isCancelled
        ? strings.premiumEndsOn(strings.date(expiresAt))
        : strings.premiumUntil(strings.date(expiresAt));

    return Text(text, style: Theme.of(context).textTheme.bodySmall);
  }
}
