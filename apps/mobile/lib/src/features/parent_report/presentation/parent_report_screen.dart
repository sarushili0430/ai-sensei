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

/// 今月の親レポート(ピボット計画 §5-1)。
///
/// 共有前に、メールへ入る本文を省略せず同じ画面へ出す。とくに本人の引用は
/// センシティブなので、「共有」ボタンのあとで初めて見える形にはしない。
/// 公開URLは作らず、端末のメール下書きへテキストだけを渡す。
class ParentReportScreen extends ConsumerWidget {
  const ParentReportScreen({super.key});

  void _refreshLockedReport(WidgetRef ref) {
    // RevenueCatは**再取得のきっかけ**にだけ使う。ここでロック済みの本文を
    // クライアント判断で開くと、webhookが届いていないサーバとの有料境界がずれる。
    // Premiumになっても、最後に本文を返してよいと決めるのは再取得先のAPI。
    if (!ref.read(isPremiumProvider)) return;

    final AsyncValue<ParentReportResponse> current = ref.read(
      parentReportControllerProvider,
    );
    if (current.value?.requiresPremium == false) return;

    // `refresh()`を古いNotifierへ投げるのではなく、応答を持つproviderごと捨てる。
    // StatefulShellRouteをまたぐpushでは画面が組み直される場合があり、古い
    // Notifierの完了を待つと、新しい画面が読んでいるロック応答には届かないため。
    // invalidateなら、いまwatchしている画面のbuildが必ず新しいGETを始める。
    ref.invalidate(parentReportControllerProvider);
  }

  Future<void> _openPaywall(BuildContext context, WidgetRef ref) async {
    await context.push<void>(AppRoute.paywall.path);
    if (!context.mounted) return;

    // SDKの通知を取りこぼしても、「この画面から課金へ行って戻った」という
    // 確実な境界でもう一度見る。キャンセル時はPremiumでないので通信を増やさない。
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
    // ペイウォールの既定選択と同じ関数を使う。月額が無いOfferingでは先頭へ
    // 縮退するので、親へ見せた価格と実際に選ばれる商品が食い違わない。
    final SubscriptionPlan? pricePlan = planForPeriod(
      plans,
      PlanPeriod.monthly,
    );

    ref.listen<bool>(isPremiumProvider, (bool? previous, bool next) {
      if (!next || previous == true) return;

      // RevenueCatのペイウォールはこの画面の上に載るので、購入中もロック済みの
      // providerは生きている。Premiumへ変わった瞬間に読み直さないと、お礼を
      // 閉じても古い200応答(`requires_premium: true`)がそのまま残る。
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
          // この文字列とメールの `body` は同じ変数。画面に無い内容は送られない。
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
