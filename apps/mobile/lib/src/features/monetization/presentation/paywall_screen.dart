import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../application/entitlement_controller.dart';

/// ペイウォール(初回カルテ直後)。
///
/// HAMM賞は**誠実さ**を見る(handoff §6)。ここで守ること:
///   - 「無料のまま続ける」を同じ画面に、隠さず置く
///   - 解約できることを明記する
///   - カウントダウン・煽り文言・閉じにくいUIを使わない
class PaywallScreen extends ConsumerWidget {
  const PaywallScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<Entitlement> entitlement = ref.watch(entitlementControllerProvider);
    final List<Package> packages =
        entitlement.valueOrNull?.offering?.availablePackages ?? const <Package>[];
    final Package? package = packages.isEmpty ? null : packages.first;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: AppSpacing.lg),
              Text(strings.paywallTitle, style: Theme.of(context).textTheme.displaySmall),
              const SizedBox(height: AppSpacing.sm),
              Text(strings.paywallPrice, style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: AppSpacing.xl),
              _ComparisonTable(strings: strings),
              const Spacer(),
              ChunkyButton(
                label: strings.paywallCta,
                onPressed: package == null
                    ? null
                    : () async {
                        await ref.read(entitlementControllerProvider.notifier).purchase(package);
                        // キャンセルやストアのエラーでも purchase() は正常に返る。
                        // entitlementを見てから閉じないと、失敗を隠したまま
                        // ホームへ戻してしまう。
                        final bool isPremium = ref
                                .read(entitlementControllerProvider)
                                .valueOrNull
                                ?.isPremium ??
                            false;
                        if (isPremium && context.mounted) context.go(AppRoute.home.path);
                      },
              ),
              if (entitlement.hasError)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: Text(
                    strings.errorGeneric,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              // 無料継続の導線は隠さない。押しても損をしないことが分かる文言にする。
              GhostButton(
                label: strings.paywallDismiss,
                onPressed: () => context.go(AppRoute.home.path),
              ),
              Text(
                strings.paywallCancelNote,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.sm),
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
          strings.paywallOncePerDay,
          strings.paywallUnlimited,
        ),
        _row(context, strings.paywallRowKarte, strings.paywallTodayOnly, strings.paywallHistory),
        _row(context, strings.paywallRowFollowup, '—', '✓'),
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
