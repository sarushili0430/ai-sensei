import 'package:flutter/material.dart';

/// 何も選んでいないときに出る入口。
///
/// widgetbook の既定の入口(部品数を数えて出すだけのもの)を置き換えている。
/// **このカタログが何を受け持っていて、何を受け持っていないか**を先に
/// 読ませたいため。ここが曖昧だと、画面まるごとの確認をカタログでやろうとして、
/// Riverpod のプロバイダを差し替える足場をここに作りはじめてしまう
/// (それは `test/` の担当)。
///
/// この widget は appBuilder もアドオンも通らない(widgetbook の仕様)ので、
/// アプリのテーマは効かない。凝った見た目にしない。
class CatalogHome extends StatelessWidget {
  const CatalogHome({super.key});

  @override
  Widget build(BuildContext context) {
    final TextTheme text = Theme.of(context).textTheme;

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text('カタルテの部品カタログ', style: text.headlineSmall),
            const SizedBox(height: 16),
            Text(
              '左から部品を選ぶ。並びは本体の lib/src/ の構造そのまま。\n'
              '右のパネルで、端末の寸法・日本語/英語・文字サイズ・'
              'アニメーションを減らす設定・読み上げの当たり判定を切り替えられる。',
              style: text.bodyMedium,
            ),
            const SizedBox(height: 16),
            Text(
              'ここが見るのは部品ひとつぶん。画面まるごとの回帰は '
              'apps/mobile/test/golden/ が見ている。',
              style: text.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}
