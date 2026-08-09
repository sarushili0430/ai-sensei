import 'package:flutter/material.dart';

/// 数式にしない一行(`BoardElement.text`)。見出し・注記・言い換え。
///
/// **LaTeXの中に日本語を混ぜない**(計画書§3-6d)の受け皿がこれ。
/// `\text{よって}` が `flutter_math_fork` のKaTeXフォント(欧文専用)で
/// 文字化けする実測を受けて、日本語の一言はLaTeXの外、この要素で出す設計にした。
class TextElementView extends StatelessWidget {
  const TextElementView({required this.body, super.key});

  final String body;

  @override
  Widget build(BuildContext context) {
    return Text(body, style: Theme.of(context).textTheme.bodyLarge);
  }
}
