import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/external_link.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import '../../monetization/application/entitlement_controller.dart' show RevenueCatConfig;
import '../../monetization/presentation/manage_subscription_button.dart';
import '../../notifications/application/push_controller.dart';
import '../../notifications/data/push_repository.dart';
import '../application/school_stage_controller.dart';
import '../data/support_links.dart';

/// Settings. Adds no new features — it collects what had nowhere else to go:
///   - Manage subscription and restore purchases (moved off home)
///   - Notifications on/off
///   - Privacy policy and terms (review checks these for subscriptions)
///   - Reporting inappropriate questions (required for AI output)
///   - Device ID and version, which support will ask for
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(title: Text(strings.settingsTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
          children: <Widget>[
            // Builds without keys show nothing here, so drop the heading too.
            if (RevenueCatConfig.isConfigured) ...<Widget>[
              _Section(title: strings.settingsSectionAccount),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                child: SubscriptionStatusCard(),
              ),
              const Align(alignment: Alignment.centerLeft, child: ManageSubscriptionButton()),
              const RestorePurchasesButton(),
            ],
            _Section(title: strings.settingsSectionSchoolStage),
            const _SchoolStageRows(),
            _Section(title: strings.settingsSectionNotifications),
            const _NotificationRow(),
            _Section(title: strings.settingsSectionAbout),
            if (SupportLinks.hasSupportEmail) const _ReportRow(),
            if (SupportLinks.hasPrivacyPolicy)
              _LinkRow(
                label: strings.settingsPrivacy,
                url: Uri.parse(SupportLinks.privacyPolicyUrl),
              ),
            if (SupportLinks.hasTerms)
              _LinkRow(label: strings.settingsTerms, url: Uri.parse(SupportLinks.termsUrl)),
            const _VersionRow(),
            const _DeviceIdRow(),
          ],
        ),
      ),
    );
  }
}

/// Junior high / senior high.
///
/// This bounds the topic search for a photo, it does not restrict learning:
/// choosing junior high does not forbid senior-high topics. Without it, a
/// junior-high photo also offers all 52 senior-high math topics and the
/// analyzer can pick one.
///
/// Two rows rather than a switch, because this is a choice between two, not
/// an on/off — "junior high off = senior high" does not read.
class _SchoolStageRows extends ConsumerWidget {
  const _SchoolStageRows();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final SchoolStage current = ref.watch(schoolStageControllerProvider);

    Widget row(SchoolStage stage, String label) {
      final bool selected = current == stage;
      return ListTile(
        title: Text(label),
        trailing: selected ? const Icon(Icons.check, color: AppColors.blue) : null,
        selected: selected,
        onTap: () => ref.read(schoolStageControllerProvider.notifier).select(stage),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // The hint sits before the options, not on a row: attached to one row
        // it reads as describing the selected one and appears to move on every
        // change.
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
          child: Text(
            strings.settingsSchoolStageHint,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        row(SchoolStage.juniorHigh, strings.settingsSchoolStageJuniorHigh),
        row(SchoolStage.highSchool, strings.settingsSchoolStageHighSchool),
      ],
    );
  }
}

/// Notifications on/off.
///
/// No in-app switch: the OS permission is the state, and turning it off or
/// back on happens in system settings. Holding it in two places creates
/// "on in the app but nothing arrives".
class _NotificationRow extends ConsumerWidget {
  const _NotificationRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final PushPermission permission = ref.watch(pushPermissionControllerProvider);

    return ListTile(
      title: Text(strings.settingsNotifications),
      subtitle: Text(
        permission.granted ? strings.settingsNotificationsOn : strings.settingsNotificationsOff,
        style: Theme.of(context).textTheme.bodySmall,
      ),
      trailing: const Icon(Icons.chevron_right, color: AppColors.inkMuted),
      onTap: openAppSettings,
    );
  }
}

/// Where to report a bad explanation, board or question from senpai.
class _ReportRow extends ConsumerWidget {
  const _ReportRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    return ListTile(
      title: Text(strings.settingsReport),
      subtitle: Text(strings.settingsReportBody, style: Theme.of(context).textTheme.bodySmall),
      trailing: const Icon(Icons.mail_outline, color: AppColors.inkMuted),
      onTap: () async {
        final PackageInfo info = await PackageInfo.fromPlatform();
        final Uri mail = SupportLinks.reportMail(
          subject: strings.settingsReport,
          deviceId: ref.read(deviceIdProvider),
          version: '${info.version}+${info.buildNumber}',
        );
        if (!context.mounted) return;
        await openExternalLink(context, mail);
      },
    );
  }
}

class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.label, required this.url});

  final String label;
  final Uri url;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(label),
      trailing: const Icon(Icons.open_in_new, size: 18, color: AppColors.inkMuted),
      onTap: () => openExternalLink(context, url),
    );
  }
}

class _VersionRow extends StatelessWidget {
  const _VersionRow();

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return FutureBuilder<PackageInfo>(
      future: PackageInfo.fromPlatform(),
      builder: (BuildContext context, AsyncSnapshot<PackageInfo> snapshot) {
        final PackageInfo? info = snapshot.data;
        return ListTile(
          title: Text(strings.settingsVersion, style: Theme.of(context).textTheme.bodyMedium),
          trailing: Text(
            info == null ? '—' : '${info.version} (${info.buildNumber})',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        );
      },
    );
  }
}

/// Support asks for this. With no accounts, it is the only handle we have.
class _DeviceIdRow extends ConsumerWidget {
  const _DeviceIdRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final String deviceId = ref.watch(deviceIdProvider);

    return ListTile(
      title: Text(strings.settingsDeviceId, style: Theme.of(context).textTheme.bodyMedium),
      subtitle: Text(deviceId, style: Theme.of(context).textTheme.bodySmall),
      trailing: const Icon(Icons.copy_outlined, size: 18, color: AppColors.inkMuted),
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: deviceId));
        if (!context.mounted) return;
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(strings.settingsCopied)));
      },
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.lg,
        AppSpacing.lg,
        AppSpacing.sm,
      ),
      child: Text(
        title,
        style: Theme.of(context).textTheme.titleMedium?.copyWith(color: AppColors.inkMuted),
      ),
    );
  }
}

