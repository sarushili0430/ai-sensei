import 'package:flutter/material.dart';

import 'board_style.dart';

/// A non-formula line (`BoardElement.text`): heading, note or paraphrase.
///
/// This is where the rule against mixing Japanese into LaTeX lands. After
/// measuring `\text{...}` rendering as mojibake in `flutter_math_fork`'s KaTeX
/// fonts (Latin only), Japanese prose is emitted outside LaTeX, as this element.
class TextElementView extends StatelessWidget {
  const TextElementView({required this.body, super.key});

  final String body;

  @override
  Widget build(BuildContext context) {
    return Text(
      body,
      style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: BoardStyle.chalk),
    );
  }
}
