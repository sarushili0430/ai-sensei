import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import 'board_style.dart';

/// One English example sentence (`BoardElement.sentence`).
///
/// Underlining `focus` is why [TextElementView] cannot stand in for this. What
/// is being taught is which part of the sentence is the present perfect, not the
/// sentence itself; plain text leaves students skimming with no idea where to
/// look.
///
/// When `focus` is not found in `text`, the sentence is drawn without an
/// underline. That is a contract violation (`ensureValidSentence` rejects it on
/// receipt), but throwing at render time would erase the example entirely, and
/// losing a board line costs the lesson more.
class SentenceElementView extends StatelessWidget {
  const SentenceElementView({
    required this.text,
    this.gloss,
    this.focus,
    super.key,
  });

  final String text;
  final String? gloss;
  final String? focus;

  @override
  Widget build(BuildContext context) {
    final TextTheme textTheme = Theme.of(context).textTheme;
    // Examples are chalk too; the theme default is unreadable on the board.
    final TextStyle base =
        textTheme.bodyLarge?.copyWith(
              fontSize: BoardStyle.sentenceFontSize,
              color: BoardStyle.chalk,
            ) ??
            const TextStyle(fontSize: BoardStyle.sentenceFontSize, color: BoardStyle.chalk);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text.rich(TextSpan(children: _spans(base))),
        if (gloss != null) ...<Widget>[
          const SizedBox(height: AppSpacing.xs),
          Text(gloss!, style: textTheme.bodyMedium?.copyWith(color: BoardStyle.chalkMuted)),
        ],
      ],
    );
  }

  /// Splits into three spans around `focus`; one span when `focus` is absent or
  /// not found.
  List<TextSpan> _spans(TextStyle base) {
    final String? needle = focus;
    if (needle == null) return <TextSpan>[TextSpan(text: text, style: base)];

    final int at = text.indexOf(needle);
    if (at < 0) return <TextSpan>[TextSpan(text: text, style: base)];

    return <TextSpan>[
      if (at > 0) TextSpan(text: text.substring(0, at), style: base),
      TextSpan(
        text: needle,
        style: base.copyWith(
          decoration: TextDecoration.underline,
          decorationColor: BoardStyle.chalkKey,
          decorationThickness: BoardStyle.focusUnderlineThickness,
          fontWeight: FontWeight.w700,
        ),
      ),
      if (at + needle.length < text.length)
        TextSpan(text: text.substring(at + needle.length), style: base),
    ];
  }
}
