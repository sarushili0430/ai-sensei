import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// 「見出し + 行のまとまり」で作る一覧(設定画面)。
///
/// **左端をひとつに決めるためにある。** 素の [ListTile] は左右に 16 の余白を
/// 持っているが、この画面のガター(見出し・本文・カード)は [AppSpacing.lg] = 24
/// で引いてある。混ぜると、見出しとその下の行で文字の始まりが 8px ずれ、
/// さらに行の中に素の [TextButton](余白 8)が混ざると3種類目の左端ができる。
/// 深さの違う字下げが交互に並ぶので、揃っていないことだけが目立つ。
///
/// ここを通した行は、**全部おなじ位置から始まる**。基準線は2本だけ:
///
///   - [_gutter] … 画面の左右。見出し・補足・まとまりの枠の端。
///   - [_gutter] + [_rowInset] … まとまりの中の文字。
///
/// まとまりを面([AppColors.surface])で囲うのは、地([AppColors.background])
/// との差が 1チャンネルあたり 4〜8 しかなく、余白だけでは
/// 「どこからどこまでが一組か」が読めないため。枠があれば、
/// 見出しが枠の左端・行が枠の内側という**段**になり、ずれには見えない。
const double _gutter = AppSpacing.lg;
const double _rowInset = AppSpacing.md;

/// 一覧の1行。
///
/// 文字の大きさをここでしか決めないのが要点。行ごとに `bodyMedium`(14)と
/// 既定(16)が混ざっていると、左端が揃っていても縦に読んだときガタつく。
class SettingsTile extends StatelessWidget {
  const SettingsTile({
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.selected = false,
    super.key,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  /// 選ばれている行(どちらかを選ぶもの)。色だけで示す。
  final bool selected;

  /// 行の右端に置く印の大きさ。
  ///
  /// 18 と 24 を混ぜると、右端が行ごとに動いて見える。開く・外部リンク・
  /// コピーで意味は違っても、**大きさは同じ**にしておく。
  static const double iconSize = 20;

  /// 行の右端の印。色と大きさを揃えるためだけの入れ物。
  static Widget icon(IconData data) =>
      Icon(data, size: iconSize, color: AppColors.inkMuted);

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;

    return ListTile(
      // 縦は足さない。`contentPadding` は [ListTile] の最小の高さ(1行56 / 2行72)の
      // **外側**に付くので、8を入れると1行の行が72になり、字よりも余白が主役になる。
      contentPadding: const EdgeInsets.symmetric(horizontal: _rowInset),
      title: Text(
        title,
        style: text.bodyLarge?.copyWith(
          color: selected ? AppColors.blue : AppColors.ink,
        ),
      ),
      subtitle: subtitle == null
          ? null
          : Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(subtitle!, style: text.bodySmall),
            ),
      trailing: trailing,
      onTap: onTap,
    );
  }
}

/// 行のまとまり。角を丸めた面で囲い、あいだに細い区切りを引く。
///
/// **[Container] ではなく [Material] で塗る。** [ListTile] の押した反応は
/// 「いちばん近い [Material]」に描かれるので、面を [Container] の
/// `decoration` で塗ると、その塗りが反応の上に乗って**押しても何も光らない**
/// 行ができる。ここで [Material] を挟めば、反応はこの面の上に出る。
///
/// 中身は「出ている行」だけを渡すこと。行が自分で消えると(`SizedBox.shrink`)、
/// その行ぶんの区切りだけが残って、枠の中に宙に浮いた線が出る。
class SettingsGroup extends StatelessWidget {
  const SettingsGroup({required this.children, super.key});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    if (children.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: _gutter),
      child: Material(
        color: AppColors.surface,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.card),
          side: const BorderSide(color: AppColors.border),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (int i = 0; i < children.length; i++) ...<Widget>[
              // 区切りは枠の端ではなく**文字の左端**から引く。
              // 端から端まで引くと、行より枠のほうが強く見える。
              if (i > 0)
                const Divider(
                  height: 1,
                  thickness: 1,
                  indent: _rowInset,
                  color: AppColors.border,
                ),
              children[i],
            ],
          ],
        ),
      ),
    );
  }
}

/// 見出し + まとまり。
///
/// 見出しは行より**小さく・淡く**する。行(16)より大きい太字にすると、
/// 見出しのほうが押せるものに見えて、一覧の主役が入れ替わる。
class SettingsSection extends StatelessWidget {
  const SettingsSection({
    required this.title,
    required this.children,
    this.leading,
    super.key,
  });

  final String title;

  /// まとまりの手前に置くもの(契約の状態カードなど)。
  final Widget? leading;

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(_gutter, 0, _gutter, AppSpacing.sm),
            child: Text(
              title,
              style: text.bodyMedium?.copyWith(
                color: AppColors.inkMuted,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.4,
              ),
            ),
          ),
          if (leading != null) ...<Widget>[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _gutter),
              child: leading,
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          SettingsGroup(children: children),
        ],
      ),
    );
  }
}
