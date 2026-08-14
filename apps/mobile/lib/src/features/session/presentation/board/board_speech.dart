import '../../../../l10n/strings.dart';
import '../../domain/board.dart';

/// Turns the board into a sentence for screen readers.
///
/// ## Why it is needed
///
/// The board is drawn with `Math.tex` and `CustomPaint`, which left it entirely
/// invisible to VoiceOver. The board is the heart of this product (formulas,
/// working and figures all live there), so missing it means a blind student has
/// no lesson at all.
///
/// ## It does not conflict with "do not read formulas aloud"
///
/// That rule was about TTS cost. A screen reader speaks on device, so the cost
/// here is zero: "do not read aloud" is about TTS, not semantics. For a blind
/// student audio is the only channel, so losing everything we moved onto the
/// board would work against the very goal (comprehensibility) that rule serves.
///
/// ## `math-speech.ts` in `packages/guardrail` cannot be reused
///
/// That one goes speech -> formula (STT normalisation); this needs the reverse.
/// Same name, different thing.
///
/// ## How far it goes
///
/// Perfect narration is not the aim. `tex` is constrained by a command
/// whitelist, so the input space is narrow. Only structure (fractions, roots,
/// exponents, subscripts) and symbols become words; Latin letters stay as they
/// are, since a screen reader reads a single letter per its locale and spelling
/// it out here would double it up or break under an English voice.
///
/// For figures, "what is drawn" is enough — exact narration is not required.

/// Narration vocabulary; it varies by locale, so it comes from [AppStrings].
String describeElement(BoardElement element, AppStrings strings) {
  return element.when(
    latex: (String tex) => describeTex(tex, strings),
    // Prose already, so it reads as is.
    text: (String body) => body,
    plot: (String fn, BoardDomain domain, List<PlotMark>? marks) => strings.boardSpeechPlot(
      describeTex(fn, strings),
      _number(domain.min),
      _number(domain.max),
      (marks ?? const <PlotMark>[])
          .map((PlotMark m) => m.label ?? '(${_number(m.at.x)}, ${_number(m.at.y)})')
          .join('、'),
    ),
    triangle: (List<BoardPoint> vertices, List<String>? labels, List<AngleMark>? marks) =>
        strings.boardSpeechTriangle(
          (labels ?? const <String>[]).join(''),
          (marks ?? const <AngleMark>[])
              .map(
                (AngleMark m) => switch (m.kind) {
                  AngleMarkKind.rightAngle => strings.boardSpeechRightAngle(_vertexName(labels, m.vertex)),
                  AngleMarkKind.angle =>
                    strings.boardSpeechAngle(_vertexName(labels, m.vertex), m.label ?? ''),
                },
              )
              .join('、'),
        ),
    circle: (BoardPoint center, double r, List<String>? labels) =>
        strings.boardSpeechCircle(_number(r), (labels ?? const <String>[]).join('、')),
    // The server owns the construction declaration and writes the narration too.
    // Rebuilding it from items here would mean maintaining that wording twice.
    figure: (List<Map<String, dynamic>> items, String? svg, String? alt) =>
        (alt == null || alt.isEmpty) ? strings.boardSpeechFigure : alt,
    // English sentences are read as they are (this is a screen reader, not TTS,
    // so an English voice handles them). Gloss and focus are appended when
    // present: an underline makes no sound, so "look here" has to be said in
    // words to reach a blind student.
    sentence: (String text, String? gloss, String? focus) =>
        strings.boardSpeechSentence(text, gloss ?? '', focus ?? ''),
    compare: (List<String> columns, List<List<String>> rows, String? title) =>
        strings.boardSpeechCompare(
          title ?? '',
          columns.join(strings.boardSpeechCompareSeparator),
          rows.map((List<String> row) => row.join(strings.boardSpeechCompareSeparator)).join('、'),
        ),
  );
}

String _vertexName(List<String>? labels, int index) =>
    labels != null && index < labels.length ? labels[index] : '${index + 1}';

/// Reads `5.0` as "5", keeping decimals only when they are meaningful.
String _number(double value) =>
    value == value.roundToDouble() ? value.round().toString() : value.toString();

/// Turns LaTeX into a sentence for narration.
///
/// Structure is replaced with words from the inside out; nesting is folded by
/// repetition, since the same structure can appear inside itself (as in
/// `\frac{\frac{a}{b}}{c}`).
String describeTex(String tex, AppStrings strings) {
  String out = tex;

  // Fold from the innermost group, the one with no `{}` inside. The iteration
  // count is capped so unexpected input cannot loop forever (`tex` is one line
  // of up to 200 characters, so this depth suffices).
  for (int i = 0; i < 12; i++) {
    final String before = out;
    out = _foldOnce(out, strings);
    if (out == before) break;
  }

  // Turn the remaining symbols and commands into words.
  strings.boardSpeechSymbols.forEach((String from, String to) {
    out = out.replaceAll(from, to);
  });

  // Braces only mark structure, so drop them from the narration.
  out = out.replaceAll(RegExp(r'[{}]'), ' ');
  // Leftovers such as `\,` (thin space).
  out = out.replaceAll(RegExp(r'\\[a-zA-Z]+'), ' ');
  return out.replaceAll(RegExp(r'\s+'), ' ').trim();
}

/// Peels one layer of structure. It only targets groups with no `{}` inside, so
/// repeating it folds from the innermost outwards.
String _foldOnce(String tex, AppStrings strings) {
  String out = tex;
  const String inner = r'([^{}]*)';

  // Fractions. Japanese says the denominator first, reversing the order.
  out = out.replaceAllMapped(
    RegExp(r'\\c?frac\{' '$inner' r'\}\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechFraction(m[1]!, m[2]!)} ',
  );

  // nth roots before square roots, since `\sqrt[3]{}` also matches `\sqrt{}`.
  out = out.replaceAllMapped(
    RegExp(r'\\sqrt\[' '$inner' r'\]\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechNthRoot(m[1]!, m[2]!)} ',
  );
  out = out.replaceAllMapped(
    RegExp(r'\\sqrt\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechSquareRoot(m[1]!)} ',
  );

  // Exponents and subscripts, matching both `^{12}` and `^2`.
  out = out.replaceAllMapped(
    RegExp(r'\^\{' '$inner' r'\}|\^(\w)'),
    (Match m) => ' ${strings.boardSpeechPower(m[1] ?? m[2]!)} ',
  );
  out = out.replaceAllMapped(
    RegExp(r'_\{' '$inner' r'\}|_(\w)'),
    (Match m) => ' ${strings.boardSpeechSubscript(m[1] ?? m[2]!)} ',
  );

  // Font selection is irrelevant to narration (`\mathrm{P}` is just "P").
  out = out.replaceAllMapped(
    RegExp(r'\\(?:mathrm|mathbf|text)\{' '$inner' r'\}'),
    (Match m) => ' ${m[1]!} ',
  );

  // Vectors.
  out = out.replaceAllMapped(
    RegExp(r'\\(?:vec|overrightarrow)\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechVector(m[1]!)} ',
  );

  // Overlines (segments, conjugates, means). Unfolded, `\overline` vanishes into
  // whitespace in the final cleanup and `\overline{AB}` narrates the same as
  // `AB`.
  out = out.replaceAllMapped(
    RegExp(r'\\(?:overline|bar)\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechOverline(m[1]!)} ',
  );

  return out;
}
