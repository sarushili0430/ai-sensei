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
import '../application/language_controller.dart';
import '../data/support_links.dart';

/// 設定。
///
/// **置き場所が無かったものを集めた画面**:
///   - 言語(端末に合わせる / 日本語 / English)
///   - 契約の管理と購入の復元(ホームから移した)
///   - 通知のオン/オフ
///   - プライバシーポリシー・利用規約(サブスクを載せる以上、審査で見られる)
///   - 不適切な質問の報告(AI生成物を含むアプリの導線 — handoff §5)
///   - 問い合わせのときに聞かれる端末IDとバージョン
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
            // 言語をいちばん上に置く。読めない言葉で書かれた画面から
            // 探し始める人がいるので、下のほうに埋めない。
            _Section(title: strings.settingsSectionLanguage),
            const _LanguageRows(),
            // 鍵の無いビルドでは中身が全部消えるので、見出しごと出さない。
            if (RevenueCatConfig.isConfigured) ...<Widget>[
              _Section(title: strings.settingsSectionAccount),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                child: SubscriptionStatusLine(),
              ),
              const Align(alignment: Alignment.centerLeft, child: ManageSubscriptionButton()),
              const RestorePurchasesButton(),
            ],
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

/// 言語の選択。端末に合わせる / 日本語 / English。
///
/// 通知と違って、こちらはアプリ側に状態を持つ(端末の言語とアプリの言語を
/// 別々にできることが、この行の存在理由そのもの)。
///
/// 選んだ瞬間に画面全体の言葉が入れ替わる。再起動も、確認ダイアログも挟まない
/// —— 押した結果が目の前に出るので、押し間違えたらもう一度押せば戻せる。
class _LanguageRows extends ConsumerWidget {
  const _LanguageRows();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AppLanguage selected = ref.watch(languageControllerProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final AppLanguage language in AppLanguage.values)
          _LanguageRow(language: language, selected: language == selected),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.lg,
            AppSpacing.sm,
            AppSpacing.lg,
            0,
          ),
          child: Text(
            strings.settingsLanguageNote,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    );
  }
}

class _LanguageRow extends ConsumerWidget {
  const _LanguageRow({required this.language, required this.selected});

  final AppLanguage language;
  final bool selected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    return ListTile(
      // 言語名はその言語自身の表記。訳したものに置き換えない。
      title: Text(language.nativeName ?? strings.settingsLanguageSystem),
      // `selected` は色だけでなく読み上げ(Semantics)にも乗る。
      // チェックの印を色だけに預けない。
      selected: selected,
      selectedColor: AppColors.blue,
      trailing: selected ? const Icon(Icons.check, color: AppColors.blue) : null,
      onTap: () => ref.read(languageControllerProvider.notifier).select(language),
    );
  }
}

/// 通知のオン/オフ。
///
/// アプリ側にスイッチを持たない。OSの許可がそのまま状態で、切るのも戻すのも
/// 設定アプリでやってもらう。二重に持つと「アプリではオンなのに届かない」が生まれる。
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

/// 後輩の質問がおかしかったときの報告先。
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

/// 問い合わせでこれを聞く。アカウントが無いので、これが唯一の手がかりになる。
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

