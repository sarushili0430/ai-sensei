import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/external_link.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../monetization/application/entitlement_controller.dart';
import '../../monetization/presentation/purchase_messages.dart';
import '../application/parent_report_controller.dart';
import '../data/parent_report_mail.dart';
import '../domain/parent_report.dart';

/// This month's parent report.
///
/// The full mail body is shown here before sharing, unabridged. The student's
/// own quotes are sensitive, so nothing appears for the first time only after
/// the share button. No public URL — just text handed to a local mail draft.
class ParentReportScreen extends ConsumerWidget {
  const ParentReportScreen({super.key});

  void _refreshLockedReport(WidgetRef ref) {
    // RevenueCat is only a trigger to refetch. Unlocking a locked body from
    // the client would drift from a server that has not seen the webhook yet;
    // the API still decides whether the body may be returned.
    if (!ref.read(isPremiumProvider)) return;

    final AsyncValue<ParentReportResponse> current = ref.read(
      parentReportControllerProvider,
    );
    if (current.value?.requiresPremium == false) return;

    // Discard the provider holding the response rather than calling `refresh()`
    // on a stale Notifier: a push across StatefulShellRoute can rebuild the
    // screen, and awaiting the old Notifier never reaches the locked response
    // the new screen reads. invalidate guarantees the currently watching build
    // starts a fresh GET.
    ref.invalidate(parentReportControllerProvider);
  }

  Future<void> _openPaywall(BuildContext context, WidgetRef ref) async {
    await context.push<void>(AppRoute.paywall.path);
    if (!context.mounted) return;

    // Even if the SDK notification is missed, returning from the paywall is a
    // reliable boundary to re-check. Cancelling leaves you non-Premium, so it
    // adds no request.
    _refreshLockedReport(ref);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ParentReportResponse> response = ref.watch(
      parentReportControllerProvider,
    );
    final List<SubscriptionPlan> plans =
        ref.watch(entitlementControllerProvider).value?.plans ??
        const <SubscriptionPlan>[];
    // Same function as the paywall's default selection. It falls back to the
    // first entry when an Offering has no monthly plan, so the price shown to
    // the parent matches the product actually selected.
    final SubscriptionPlan? pricePlan = planForPeriod(
      plans,
      PlanPeriod.monthly,
    );

    ref.listen<bool>(isPremiumProvider, (bool? previous, bool next) {
      if (!next || previous == true) return;

      // RevenueCat's paywall sits on top of this screen, so the locked provider
      // stays alive during purchase. Without re-reading the moment Premium
      // flips, closing the thank-you leaves the stale 200 response
      // (`requires_premium: true`) in place.
      _refreshLockedReport(ref);
    });

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.parentReportTitle),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: context.closeOrGoHome,
        ),
      ),
      body: SafeArea(
        child: response.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (Object error, StackTrace stack) => _Message(
            text: strings.errorGeneric,
            primaryLabel: strings.errorRetry,
            onPrimary: () =>
                ref.read(parentReportControllerProvider.notifier).refresh(),
          ),
          data: (ParentReportResponse data) {
            final ParentReport? report = data.report;
            if (data.requiresPremium || report == null) {
              return _Message(
                text:
                    '${strings.parentReportLocked}\n\n'
                    '${strings.parentReportPriceNote(plan: pricePlan?.period.label(strings), price: pricePlan?.priceString)}',
                primaryLabel: strings.paywallCta,
                onPrimary: () => _openPaywall(context, ref),
              );
            }
            return _ReportBody(report: report, pricePlan: pricePlan);
          },
        ),
      ),
    );
  }
}

class _ReportBody extends StatelessWidget {
  const _ReportBody({required this.report, required this.pricePlan});

  final ParentReport report;
  final SubscriptionPlan? pricePlan;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String text = buildParentReportText(
      report,
      strings,
      plan: pricePlan?.period.label(strings),
      price: pricePlan?.priceString,
    );
    final Uri mail = buildParentReportMail(
      subject: strings.parentReportMailSubject,
      body: text,
    );

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: <Widget>[
        Text(
          strings.parentReportPreviewNote,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: AppSpacing.md),
        Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadius.card),
            border: Border.all(color: AppColors.border),
          ),
          // This string and the mail `body` are the same variable: nothing off
          // screen can be sent.
          child: SelectableText(
            text,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        ChunkyButton(
          label: strings.parentReportSendEmail,
          onPressed: () => openExternalLink(context, mail),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          strings.parentReportDraftNote,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({
    required this.text,
    required this.primaryLabel,
    required this.onPrimary,
  });

  final String text;
  final String primaryLabel;
  final VoidCallback onPrimary;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            text,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: AppSpacing.lg),
          ChunkyButton(label: primaryLabel, onPressed: onPrimary),
        ],
      ),
    );
  }
}
