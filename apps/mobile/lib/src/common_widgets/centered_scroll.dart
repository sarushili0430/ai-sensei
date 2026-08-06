import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// 収まるときは中央に置き、収まらないときだけスクロールさせる。
///
/// 中央寄せだけにすると、文字を大きくしている人の画面でははみ出す。
/// スクロールだけにすると、余白のある端末で内容が上に貼りついて、
/// 下半分が空いたまま見える。読み物の枚(オンボーディング)は
/// どちらの見え方も避けたいので、両方を satisfy する形にしておく。
class CenteredScroll extends StatelessWidget {
  const CenteredScroll({
    required this.children,
    this.padding = const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
    super.key,
  });

  final List<Widget> children;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double minHeight = constraints.hasBoundedHeight
            ? (constraints.maxHeight - padding.vertical).clamp(0.0, double.infinity)
            : 0.0;

        return SingleChildScrollView(
          padding: padding,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children,
            ),
          ),
        );
      },
    );
  }
}
