import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../../api/device_id.dart';
import '../../../common_widgets/external_link.dart';
import '../../../common_widgets/settings_list.dart';
import '../../../l10n/strings.dart';
import '../../../theme/tokens.dart';
import '../../monetization/application/entitlement_controller.dart'
    show Entitlement, RevenueCatConfig, entitlementControllerProvider;
import '../../monetization/presentation/manage_subscription_button.dart';
import '../../notifications/application/push_controller.dart';
import '../../notifications/data/push_repository.dart';
import '../../notifications/presentation/push_toggle.dart';
import '../application/school_stage_controller.dart';
import '../data/support_links.dart';

/// 設定。
///
/// 新しい機能は何も足していない。**置き場所が無かったものを集めた画面**:
///   - 契約の管理と購入の復元(ホームから移した)
///   - 通知のオン/オフ
///   - プライバシーポリシー・利用規約(サブスクを載せる以上、審査で見られる)
///   - 不適切な質問の報告(AI生成物を含むアプリの導線)
///   - 問い合わせのときに聞かれる端末IDとバージョン
///
/// **AppBar は持たない。** ここは常設タブの根で、画面の名前は下部ナビが
/// 「設定」と出している。AppBar にも同じ語を置くと、ひとつの画面に同じ
/// 「設定」が2回出る(ホームも同じ理由でタイトルを持たない)。
///
/// **並べ方は [SettingsSection] にまかせる。** 直接 [ListTile] を置くと
/// 素の余白(16)で並び、見出しのガター(24)と 8px ずれる。ずれた行と
/// ずれていない行が交互に来るので、字下げが揃っていないことだけが目立つ。
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.only(top: AppSpacing.lg, bottom: AppSpacing.xl),
          children: <Widget>[
            // 鍵の無いビルドでは中身が全部消えるので、見出しごと出さない。
            if (RevenueCatConfig.isConfigured) const _AccountSection(),
            const _SchoolStageSection(),
            SettingsSection(
              title: strings.settingsSectionNotifications,
              children: const <Widget>[_NotificationRow()],
            ),
            SettingsSection(
              title: strings.settingsSectionAbout,
              children: <Widget>[
                // 出ない行は**ここで落とす**。行に自分で消えさせると、
                // その行ぶんの区切りの線だけがまとまりの中に残る。
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
          ],
        ),
      ),
    );
  }
}

/// 契約。状態のカードと、その下に管理・復元の2行。
class _AccountSection extends ConsumerWidget {
  const _AccountSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Entitlement? entitlement = ref.watch(entitlementControllerProvider).value;

    return SettingsSection(
      title: strings.settingsSectionAccount,
      // 契約していない人に状態カードは出さない(出すと売り込みに読める)。
      // 出ないものを `leading` に渡すと、その下に空きだけが残る。
      leading: (entitlement?.isPremium ?? false) ? const SubscriptionStatusCard() : null,
      children: <Widget>[
        if (entitlement?.canManageSubscription ?? false) const ManageSubscriptionButton(),
        const RestorePurchasesButton(),
      ],
    );
  }
}

/// 中学生 / 高校生。
///
/// **学習の制限ではなく、写真から単元を探す範囲**。中学生を選んでも高校の単元が
/// 禁止になるわけではない。ここを持たないと、中学生の写真にも数学I〜Cの52件が
/// 候補として並び、解析器が高校の単元を選べてしまう。
///
/// スイッチではなく2行にしてあるのは、オン/オフではなく**どちらかを選ぶ**もの
/// だから。「中学生オフ = 高校生」は読めない。
class _SchoolStageSection extends ConsumerWidget {
  const _SchoolStageSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final SchoolStage current = ref.watch(schoolStageControllerProvider);

    SettingsTile row(SchoolStage stage, String label) {
      final bool selected = current == stage;
      return SettingsTile(
        title: label,
        selected: selected,
        trailing: selected
            ? const Icon(Icons.check, size: SettingsTile.iconSize, color: AppColors.blue)
            : null,
        onTap: () => ref.read(schoolStageControllerProvider.notifier).select(stage),
      );
    }

    return SettingsSection(
      title: strings.settingsSectionSchoolStage,
      children: <Widget>[
        row(SchoolStage.juniorHigh, strings.settingsSchoolStageJuniorHigh),
        row(SchoolStage.highSchool, strings.settingsSchoolStageHighSchool),
      ],
    );
  }
}

/// 通知のオン/オフ。
///
/// **アプリ側に状態を持たない。** スイッチが出しているのはOSの許可そのもので、
/// 切り替えでやるのは許可を求めることと、設定アプリへ送ることだけ
/// ([setPushNotifications])。二重に持つと
/// 「アプリではオンなのに届かない」が生まれる。
class _NotificationRow extends ConsumerWidget {
  const _NotificationRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final PushPermission permission = ref.watch(pushPermissionControllerProvider);

    return SettingsTile(
      title: strings.settingsNotifications,
      // 「届きます/届きません」は書かない。スイッチが同じことを言っている。
      trailing: const PushToggle(),
      // 当たりを行の幅まで広げる。スイッチだけだと右端の狭い的になる。
      onTap: permission.available
          ? () => setPushNotifications(context, ref, on: !permission.granted)
          : null,
    );
  }
}

/// 先輩の説明・板書・質問がおかしかったときの報告先。
class _ReportRow extends ConsumerWidget {
  const _ReportRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    return SettingsTile(
      title: strings.settingsReport,
      subtitle: strings.settingsReportBody,
      trailing: SettingsTile.icon(Icons.mail_outline),
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
    return SettingsTile(
      title: label,
      trailing: SettingsTile.icon(Icons.open_in_new),
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
        return SettingsTile(
          title: strings.settingsVersion,
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

    return SettingsTile(
      title: strings.settingsDeviceId,
      subtitle: deviceId,
      trailing: SettingsTile.icon(Icons.copy_outlined),
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: deviceId));
        if (!context.mounted) return;
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(strings.settingsCopied)));
      },
    );
  }
}
