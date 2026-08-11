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

/// ペイウォール(初回カルテ直後)。
///
/// HAMM賞は**誠実さ**を見る(handoff §6)。ここで守ること:
///   - 「無料のまま続ける」を同じ画面に、隠さず置く
///   - 解約できることを明記する
///   - カウントダウン・煽り文言・閉じにくいUIを使わない
///
/// 出す順番は2段構え:
///   1. RevenueCat のペイウォール(ダッシュボードで文言と価格を差し替えられる)
///   2. 1が出せないときは、下の自前ペイウォール
///
/// 自前のほうを消さないのは、鍵の無いビルド・古いOS・ダッシュボード未設定の
/// どれでも「無料継続の導線がある画面」が必ず出るようにするため。
/// golden test が見ているのもこちら。
class PaywallScreen extends ConsumerStatefulWidget {
  const PaywallScreen({super.key});

  @override
  ConsumerState<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends ConsumerState<PaywallScreen> {
  @override
  void initState() {
    super.initState();
    // 自前のペイウォールを下に敷いたまま、上に RevenueCat のものを出す。
    // こうしておくと、出せなかったときに空の画面が一瞬見えることがない。
    if (RevenueCatConfig.isConfigured) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _presentRemotePaywall());
    }
  }

  Future<void> _presentRemotePaywall() async {
    final PaywallResult result =
        await ref.read(entitlementControllerProvider.notifier).presentPaywall();
    if (!mounted) return;

    switch (result) {
      // 買えた・戻せた。**ここを閉じるだけにしない。** RevenueCat の
      // ペイウォールで買った人にも、自前で買った人と同じお礼を出す。
      case PaywallResult.purchased:
        context.replaceWithThanks();
      case PaywallResult.restored:
        context.replaceWithThanks(restored: true);
      // 閉じただけ。「無料のまま続ける」を押したのと同じ扱いにする。
      case PaywallResult.cancelled:
      case PaywallResult.notPresented:
        context.closeOrGoHome();
      // ダッシュボードにペイウォールが無い / OSが古い。
      // 下に敷いてある自前のペイウォールがそのまま残る。
      case PaywallResult.error:
        break;
    }
  }

  @override
  Widget build(BuildContext context) => const _ManualPaywall();
}

/// 自前のペイウォール。
///
/// RevenueCat の Offering が取れていれば、その価格でプランを出す。
/// 取れていなければ価格を約束しない文言だけを出して、購入ボタンは押せなくする
/// (押せるのに買えない、が一番わるい)。
class _ManualPaywall extends ConsumerStatefulWidget {
  const _ManualPaywall();

  @override
  ConsumerState<_ManualPaywall> createState() => _ManualPaywallState();
}

class _ManualPaywallState extends ConsumerState<_ManualPaywall> {
  /// 選択中のプラン。既定は月額(いちばん踏み出しやすい額)にする。
  /// 年額を初期選択にして高いほうを既定にする、はやらない。
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
      // 自分で閉じただけ。エラーは出さないし、引き止めもしない。
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
      // 「失敗」ではない。見つからなかった、と正直に出す。
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
                  // Offering が取れていないあいだは、価格を約束しない文言に落とす。
                  // ストアの値段もトライアルも、取れていない状態からは作らない。
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
                    // トライアルの有無は Offering を読むまで分からない。
                    // 分かっているときだけ「無料」と書く。無い商品に
                    // 「7日間無料でためす」と出すと、押した瞬間に課金される。
                    label: selected != null && selected.hasFreeTrial
                        ? strings.planFreeTrial(selected.freeTrialDays)
                        : strings.paywallSubscribe,
                    // 買えないときは押せなくする。押しても何も起きないボタンは置かない。
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
                  // 無料継続の導線は隠さない。押しても損をしないことが分かる文言にする。
                  GhostButton(
                    label: strings.paywallDismiss,
                    onPressed: _busy ? null : context.closeOrGoHome,
                  ),
                  Text(
                    strings.paywallCancelNote,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  // 復元はApp Reviewの必須要件。機種変更で戻れなくなる人が出る。
                  GhostButton(
                    label: strings.paywallRestore,
                    onPressed: _busy ? null : _restore,
                  ),
                  // 規約とプライバシーポリシーも同じく必須(Guideline 3.1.2)。
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

/// プラン1枚。価格の文字列はストアが返したものをそのまま出す。
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
                    // 「いちばんお得」は月あたり単価から計算した事実だけ書く。
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
