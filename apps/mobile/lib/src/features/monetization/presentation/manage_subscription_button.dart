import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/entitlement_controller.dart';
import 'purchase_messages.dart';

/// Subscription management (RevenueCat's Customer Center).
///
/// Cancel, plan change, refund request and restore all live there. Building our
/// own is the kind of screen App Review flags every time, so we show theirs.
///
/// Hidden for people without a subscription: home stays quiet, and the restore
/// path is on the paywall.
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
        // Could not be shown (an old OS, say). Silently doing nothing is the
        // worst outcome, so say so.
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

/// Restore purchases.
///
/// The paywall has the same action, but people without a subscription should not
/// find the paywall their only exit. Anyone who changed devices looks in
/// settings first, so it lives here too (App Review checks for it as well).
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
      // A successful restore deserves more than a SnackBar. For someone who
      // came here after changing devices this is the anxious moment, so they get
      // the same welcome-back screen as a buyer. Settings stays beneath (pushed
      // on top).
      case RestoreSucceeded():
        context.pushThanks(restored: true);
      // Not a failure: say plainly that nothing was found.
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
    // In key-less builds tapping does nothing, so drop the whole row.
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

/// Subscription status, at the top of the settings "subscription" section.
///
/// A card rather than a line of text, because this is the only place the
/// subscription is shown. It is also where [PremiumChip] on home lands, so it
/// states the status and what happens next (renewal, end or billing start).
///
/// It says "you can keep using it until then" rather than counting down
/// "X days left".
class SubscriptionStatusCard extends ConsumerWidget {
  const SubscriptionStatusCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Entitlement? entitlement = ref.watch(entitlementControllerProvider).value;

    // Hidden without a subscription: saying "you're on the free plan" here
    // would read as a pitch every time settings is opened.
    if (entitlement == null || !entitlement.isPremium) return const SizedBox.shrink();

    final DateTime? expiresAt = entitlement.expiresAt;
    final String? date = expiresAt == null ? null : strings.date(expiresAt);
    final String? note = switch (entitlement) {
      // During a trial, state the billing start date, not the renewal date.
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

/// "Active" / "In free trial". A filled pill reads as tappable, so this one
/// stays small and pale to avoid confusion with the tappable chip.
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

/// The subscribed marker, top right on home.
///
/// Not a rank or a title. We count only streak days and filled gaps, so it
/// carries no number and no more color than a blue outline; filling it would
/// give it a chunky button's weight and make it look tappable in that way.
///
/// Tapping goes to settings, where the status and renewal date live
/// ([SubscriptionStatusCard]).
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
