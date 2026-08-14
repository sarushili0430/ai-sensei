import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:purchases_ui_flutter/purchases_ui_flutter.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/external_link.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/entitlement_controller.dart';
import 'purchase_messages.dart';

/// Paywall, shown right after the first karte.
///
/// Honesty is what matters here:
///   - "stay on free" sits on the same screen, unhidden
///   - cancellation is stated explicitly
///   - no countdowns, no pressure copy, no hard-to-close UI
///
/// It is shown in two tiers:
///   1. RevenueCat's paywall (copy and prices editable in the dashboard)
///   2. our own paywall below, when the first cannot be shown
///
/// Ours is kept so key-less builds, old OS versions and an unconfigured
/// dashboard all still get a screen with a way to stay free. It is also what
/// the golden tests look at.
class PaywallScreen extends ConsumerStatefulWidget {
  const PaywallScreen({super.key});

  @override
  ConsumerState<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends ConsumerState<PaywallScreen> {
  @override
  void initState() {
    super.initState();
    // Show RevenueCat's on top while ours stays underneath, so a failure to
    // present never flashes an empty screen.
    if (RevenueCatConfig.isConfigured) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _presentRemotePaywall());
    }
  }

  Future<void> _presentRemotePaywall() async {
    final PaywallResult result =
        await ref.read(entitlementControllerProvider.notifier).presentPaywall();
    if (!mounted) return;

    switch (result) {
      // Bought or restored. Do not merely close: people who bought through
      // RevenueCat's paywall get the same thank-you as everyone else.
      case PaywallResult.purchased:
        context.replaceWithThanks();
      case PaywallResult.restored:
        context.replaceWithThanks(restored: true);
      // Just closed; treated the same as tapping "stay on free".
      case PaywallResult.cancelled:
      case PaywallResult.notPresented:
        context.closeOrGoHome();
      // No paywall in the dashboard, or the OS is too old. Ours, already
      // underneath, simply stays.
      case PaywallResult.error:
        break;
    }
  }

  @override
  Widget build(BuildContext context) => const _ManualPaywall();
}

/// Our own paywall.
///
/// With a RevenueCat Offering it lists plans at those prices. Without one it
/// shows copy that promises no price and disables the buy button — a button
/// that taps but cannot buy is the worst outcome.
class _ManualPaywall extends ConsumerStatefulWidget {
  const _ManualPaywall();

  @override
  ConsumerState<_ManualPaywall> createState() => _ManualPaywallState();
}

class _ManualPaywallState extends ConsumerState<_ManualPaywall> {
  /// The selected plan, defaulting to monthly — the easiest step to take. We do
  /// not preselect yearly to make the pricier option the default.
  PlanPeriod? _selected;
  String? _message;
  bool _busy = false;

  Future<void> _purchase(SubscriptionPlan plan) async {
    final AppStrings strings = AppStrings.of(context);
    setState(() {
      _busy = true;
      _message = null;
    });

    final PurchaseOutcome outcome =
        await ref.read(entitlementControllerProvider.notifier).purchase(plan.package);
    if (!mounted) return;
    setState(() => _busy = false);

    switch (outcome) {
      case PurchaseSucceeded():
        context.replaceWithThanks();
      // They closed it themselves: no error, and no attempt to hold them back.
      case PurchaseCancelled():
        break;
      case PurchaseNotEntitled():
        setState(() => _message = strings.purchaseErrorNotEntitled);
      case PurchaseFailed(:final PurchaseFailure failure):
        setState(() => _message = failure.message(strings));
    }
  }

  Future<void> _restore() async {
    final AppStrings strings = AppStrings.of(context);
    setState(() {
      _busy = true;
      _message = null;
    });

    final RestoreOutcome outcome =
        await ref.read(entitlementControllerProvider.notifier).restore();
    if (!mounted) return;
    setState(() => _busy = false);

    switch (outcome) {
      case RestoreSucceeded():
        context.replaceWithThanks(restored: true);
      // Not a failure: say plainly that nothing was found.
      case RestoreFoundNothing():
        setState(() => _message = strings.paywallRestoredNothing);
      case RestoreFailed(:final PurchaseFailure failure):
        setState(() => _message = failure.message(strings));
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<Entitlement> entitlement = ref.watch(entitlementControllerProvider);
    final List<SubscriptionPlan> plans = entitlement.value?.plans ?? const <SubscriptionPlan>[];
    final SubscriptionPlan? selected =
        planForPeriod(plans, _selected ?? PlanPeriod.monthly);

    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.lg,
                  vertical: AppSpacing.lg,
                ),
                children: <Widget>[
                  const SizedBox(height: AppSpacing.lg),
                  Text(strings.paywallTitle, style: Theme.of(context).textTheme.displaySmall),
                  const SizedBox(height: AppSpacing.sm),
                  // Without an Offering, fall back to copy that promises no
                  // price. Never invent store prices or trials from nothing.
                  if (plans.isEmpty)
                    Text(strings.paywallPriceUnavailable,
                        style: Theme.of(context).textTheme.bodyLarge)
                  else
                    ...plans.map(
                      (SubscriptionPlan plan) => Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                        child: _PlanCard(
                          plan: plan,
                          selected: plan.period == selected?.period,
                          onTap: () => setState(() => _selected = plan.period),
                        ),
                      ),
                    ),
                  const SizedBox(height: AppSpacing.lg),
                  _ComparisonTable(strings: strings),
                  if (RevenueCatConfig.usesTestStore) ...<Widget>[
                    const SizedBox(height: AppSpacing.md),
                    Text(
                      strings.testStoreNotice,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  ChunkyButton(
                    // Whether a trial exists is unknown until the Offering is
                    // read; only say "free" when it is. Offering "7 days free"
                    // on a product without one bills on the first tap.
                    label: selected != null && selected.hasFreeTrial
                        ? strings.planFreeTrial(selected.freeTrialDays)
                        : strings.paywallSubscribe,
                    // Disabled when buying is impossible; never a button that
                    // does nothing when tapped.
                    onPressed: selected == null || _busy ? null : () => _purchase(selected),
                  ),
                  if (_message != null)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.sm),
                      child: Text(
                        _message!,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  // The stay-free path is never hidden; the wording makes clear
                  // that taking it costs nothing.
                  GhostButton(
                    label: strings.paywallDismiss,
                    onPressed: _busy ? null : context.closeOrGoHome,
                  ),
                  Text(
                    strings.paywallCancelNote,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  // Restore is required by App Review, and people do get locked
                  // out after changing devices.
                  GhostButton(
                    label: strings.paywallRestore,
                    onPressed: _busy ? null : _restore,
                  ),
                  // Terms and privacy policy are equally required (3.1.2).
                  const LegalLinks(),
                  const SizedBox(height: AppSpacing.sm),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One plan card. Price strings are shown exactly as the store returns them.
class _PlanCard extends StatelessWidget {
  const _PlanCard({required this.plan, required this.selected, required this.onTap});

  final SubscriptionPlan plan;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String? perMonth = plan.pricePerMonthString;

    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.card),
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: selected ? AppColors.blue.withValues(alpha: 0.08) : AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadius.card),
            border: Border.all(
              color: selected ? AppColors.blue : AppColors.border,
              width: selected ? 2 : 1,
            ),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(plan.period.label(strings),
                        style: Theme.of(context).textTheme.titleMedium),
                    if (plan.hasFreeTrial)
                      Text(
                        strings.planFreeTrial(plan.freeTrialDays),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    // "Best value" states only the fact computed from the
                    // per-month price.
                    if (plan.isBestValue)
                      Text(
                        strings.planBestValue,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(plan.priceString, style: Theme.of(context).textTheme.titleMedium),
                  if (perMonth != null && plan.period != PlanPeriod.monthly)
                    Text(
                      strings.planPerMonth(perMonth),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ComparisonTable extends StatelessWidget {
  const _ComparisonTable({required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    return Table(
      border: TableBorder.all(color: AppColors.border, borderRadius: BorderRadius.circular(12)),
      children: <TableRow>[
        _row(context, '', strings.paywallFree, strings.paywallPremium, header: true),
        _row(
          context,
          strings.paywallRowSessions,
          strings.paywallEverydayOne,
          strings.paywallEverydayQuestions,
        ),
        _row(context, strings.paywallRowKarte, strings.paywallTodayOnly, strings.paywallHistory),
        _row(context, strings.paywallRowFollowup, '—', strings.paywallIncluded),
      ],
    );
  }

  TableRow _row(
    BuildContext context,
    String label,
    String free,
    String premium, {
    bool header = false,
  }) {
    final TextStyle? style = header
        ? Theme.of(context).textTheme.bodySmall
        : Theme.of(context).textTheme.bodyMedium;
    return TableRow(
      children: <Widget>[
        for (final String cell in <String>[label, free, premium])
          Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Text(cell, style: style, textAlign: TextAlign.center),
          ),
      ],
    );
  }
}
