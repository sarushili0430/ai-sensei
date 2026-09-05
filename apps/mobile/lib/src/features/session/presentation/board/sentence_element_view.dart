import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import 'board_style.dart';

/// 英語の例文1つ(`BoardElement.sentence`)。
///
/// **`focus` に下線を引くのが、この要素が [TextElementView] で代用できない理由。**
/// 英語で教えているのは「この文のどこが現在完了か」であって文そのものではない。
/// 平文を並べるだけだと、生徒はどこを見ればいいか分からないまま読み流す。
///
/// `focus` が `text` に含まれていない場合は **下線を引かずに文だけ描く**。
/// 契約違反ではあるが(`ensureValidSentence` が受信時に落とす)、描画側で
/// 例外にすると**例文そのものが消える** — 板書から1行消えるほうが授業には痛い。
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
    // 例文もチョークで書く(テーマの既定色は板の上では読めない)。
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

  /// `focus` の前・`focus`・後ろの3片に割る。`focus` が無い(または見つからない)なら1片。
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
