import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../features/settings/data/support_links.dart';
import '../l10n/strings.dart';
import '../theme/tokens.dart';

/// Opens an external link, surfacing failures instead of swallowing them.
Future<void> openExternalLink(BuildContext context, Uri url) async {
  final bool opened = await launchUrl(url, mode: LaunchMode.externalApplication);
  if (opened || !context.mounted) return;
  // Silently doing nothing is the worst outcome, so say so.
  ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(AppStrings.of(context).settingsOpenFailed)));
}

/// EULA and privacy policy links.
///
/// Required on the paywall, not just settings: App Review guideline 3.1.2
/// wants name, duration, price and working legal links on the subscription
/// screen, and missing them is a classic rejection. URLs arrive via
/// `--dart-define`; when empty the row is dropped, since a dead link is
/// worse than none.
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
