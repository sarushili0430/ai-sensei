import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../features/settings/data/support_links.dart';
import '../l10n/strings.dart';
import '../theme/tokens.dart';

/// 外部リンクを開く。開けなかったことを黙って飲み込まない。
Future<void> openExternalLink(BuildContext context, Uri url) async {
  final bool opened = await launchUrl(url, mode: LaunchMode.externalApplication);
  if (opened || !context.mounted) return;
  // 黙って何も起きないのが一番わるいので伝える。
  ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(AppStrings.of(context).settingsOpenFailed)));
}

/// 利用規約(EULA)とプライバシーポリシーへのリンク。
///
/// 設定画面だけでなく**購入画面にも**必要。App Review は
/// Guideline 3.1.2 で、サブスクの購入画面に
/// 「名称・期間・価格・規約とプライバシーポリシーへの動くリンク」が
/// 揃っていることを求めていて、ここが欠けているのは定番のリジェクト理由。
///
/// URLは `--dart-define` から入るので、空のビルドでは行ごと出さない
/// (押しても開かないリンクは、無いより悪い)。
class LegalLinks extends StatelessWidget {
  const LegalLinks({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextStyle? style = Theme.of(context)
        .textTheme
        .bodySmall
        ?.copyWith(color: AppColors.inkMuted, decoration: TextDecoration.underline);

    final List<Widget> links = <Widget>[
      if (SupportLinks.hasTerms)
        _Link(
          label: strings.settingsTerms,
          url: Uri.parse(SupportLinks.termsUrl),
          style: style,
        ),
      if (SupportLinks.hasPrivacyPolicy)
        _Link(
          label: strings.settingsPrivacy,
          url: Uri.parse(SupportLinks.privacyPolicyUrl),
          style: style,
        ),
    ];
    if (links.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Wrap(
        alignment: WrapAlignment.center,
        spacing: AppSpacing.md,
        children: links,
      ),
    );
  }
}

class _Link extends StatelessWidget {
  const _Link({required this.label, required this.url, required this.style});

  final String label;
  final Uri url;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => openExternalLink(context, url),
      child: Text(label, style: style),
    );
  }
}
