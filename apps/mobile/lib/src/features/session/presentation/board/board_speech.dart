import '../../../../l10n/strings.dart';
import '../../domain/board.dart';

/// 板書を**読み上げ用の一文**に直す。
///
/// ## なぜ要るか
///
/// 板書は `Math.tex` と `CustomPaint` で描かれていて、そのままでは
/// **VoiceOver から完全に不可視**だった。板書はこのプロダクトの中心
/// (計画書 §3-1「数式・計算・図は板書」)なので、そこが読み上げから
/// 欠けると、目が見えない生徒には**授業が存在しないのと同じ**になる。
///
/// ## §3-1 と衝突しない
///
/// §3-1 は「**数式を音声で読み上げない**」と定めている。ただしあれが減らしたのは
/// **TTSの原価**で、スクリーンリーダーは端末側で読むので**こちらの原価はゼロ**。
/// つまり「読み上げない」はTTSの話であって、セマンティクスの話ではない。
/// 目が見えない生徒にとっては**音声が唯一の経路**なので、板書に追い出した情報が
/// まるごと届かなくなる —— そちらのほうが §3-1 の目的(理解しやすさ)に反する。
///
/// ## `packages/guardrail` の `math-speech.ts` は使えない
///
/// あれは **発話 → 数式**(STTの正規化。「エックスのにじょう」→ `x^2`)で、
/// ここで要るのは**逆方向**。同じ名前だが別物なので、移植しても意味がない。
///
/// ## どこまでやるか
///
/// **完璧な読み上げは狙わない。** `tex` は許可コマンドのホワイトリスト
/// (計画書 §3-6 ②)で縛られているので入力の幅は狭い。構造(分数・根号・
/// 指数・添字)と記号だけを言葉にして、**英字はそのまま残す** ——
/// 1文字の英字はスクリーンリーダーがロケールなりに読んでくれるので、
/// こちらで「エックス」と書くと二重に読まれたり、英語音声で崩れたりする。
///
/// 図形は「厳密な読み上げ」より「**何が描かれているか**」で足りる。

/// 読み上げに使う語。ロケールで変わるので [AppStrings] から引く。
String describeElement(BoardElement element, AppStrings strings) {
  return element.when(
    latex: (String tex) => describeTex(tex, strings),
    // 日本語の一行なので、そのまま読める。
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
    // 作図の宣言はサーバが持っているので、読み上げ文も向こうで書いてある。
    // ここで items から組み立て直すと、サーバの文言と二重管理になる。
    figure: (List<Map<String, dynamic>> items, String? svg, String? alt) =>
        (alt == null || alt.isEmpty) ? strings.boardSpeechFigure : alt,
    // 英文はそのまま読ませる(TTSではなく画面読み上げなので、英語の音声で読まれる)。
    // 訳と焦点は付いていれば足す — **下線は音にならない**ので、
    // 「どこを見てほしいか」は言葉にしないと目の見えない生徒には届かない。
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

/// `5.0` を「5」と読ませる。小数のときだけ小数のまま。
String _number(double value) =>
    value == value.roundToDouble() ? value.round().toString() : value.toString();

/// LaTeX を読み上げ用の文に直す。
///
/// 内側から外へ、構造を言葉に置き換えていく。**入れ子は繰り返しで畳む**
/// (`\frac{\frac{a}{b}}{c}` のように、中に同じ構造が入りうるため)。
String describeTex(String tex, AppStrings strings) {
  String out = tex;

  // 中身に `{}` を含まない、いちばん内側から畳む。
  // 回数を切ってあるのは、想定外の入力で回り続けないため
  // (`tex` は1行・200字までなので、この深さで足りる)。
  for (int i = 0; i < 12; i++) {
    final String before = out;
    out = _foldOnce(out, strings);
    if (out == before) break;
  }

  // 残った記号とコマンドを言葉にする。
  strings.boardSpeechSymbols.forEach((String from, String to) {
    out = out.replaceAll(from, to);
  });

  // 中括弧は構造の印でしかないので、読み上げからは落とす。
  out = out.replaceAll(RegExp(r'[{}]'), ' ');
  // `\,`(細い空白)などの残りかす。
  out = out.replaceAll(RegExp(r'\\[a-zA-Z]+'), ' ');
  return out.replaceAll(RegExp(r'\s+'), ' ').trim();
}

/// 構造をひと皮むく。**中身に `{}` を持たないものだけを対象にする**ので、
/// 繰り返すと内側から順に畳まれる。
String _foldOnce(String tex, AppStrings strings) {
  String out = tex;
  const String inner = r'([^{}]*)';

  // 分数。日本語は「B分のA」で**順序が逆**になる。
  out = out.replaceAllMapped(
    RegExp(r'\\c?frac\{' '$inner' r'\}\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechFraction(m[1]!, m[2]!)} ',
  );

  // n乗根 → 平方根の順に見る(`\sqrt[3]{}` は `\sqrt{}` にも当たるため)。
  out = out.replaceAllMapped(
    RegExp(r'\\sqrt\[' '$inner' r'\]\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechNthRoot(m[1]!, m[2]!)} ',
  );
  out = out.replaceAllMapped(
    RegExp(r'\\sqrt\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechSquareRoot(m[1]!)} ',
  );

  // 指数・添字。`^{12}` と `^2` の両方に当てる。
  out = out.replaceAllMapped(
    RegExp(r'\^\{' '$inner' r'\}|\^(\w)'),
    (Match m) => ' ${strings.boardSpeechPower(m[1] ?? m[2]!)} ',
  );
  out = out.replaceAllMapped(
    RegExp(r'_\{' '$inner' r'\}|_(\w)'),
    (Match m) => ' ${strings.boardSpeechSubscript(m[1] ?? m[2]!)} ',
  );

  // 書体の指定は読み上げに関係ない(`\mathrm{P}` は「P」)。
  out = out.replaceAllMapped(
    RegExp(r'\\(?:mathrm|mathbf|text)\{' '$inner' r'\}'),
    (Match m) => ' ${m[1]!} ',
  );

  // ベクトル。
  out = out.replaceAllMapped(
    RegExp(r'\\(?:vec|overrightarrow)\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechVector(m[1]!)} ',
  );

  // 上線(線分・共役複素数・平均)。畳まないと `\overline` は最後の掃除で
  // 空白に消え、`\overline{AB}` と `AB` が**同じ読み上げになる**。
  out = out.replaceAllMapped(
    RegExp(r'\\(?:overline|bar)\{' '$inner' r'\}'),
    (Match m) => ' ${strings.boardSpeechOverline(m[1]!)} ',
  );

  return out;
}
