import 'package:flutter/material.dart';

import '../../../../l10n/strings.dart';
import '../../domain/board.dart';
import 'board_speech.dart';
import 'board_style.dart';
import 'circle_painter.dart';
import 'compare_element_view.dart';
import 'figure_element_view.dart';
import 'latex_element_view.dart';
import 'plot_painter.dart';
import 'sentence_element_view.dart';
import 'text_element_view.dart';
import 'triangle_painter.dart';

/// Dispatches the eight `BoardElement` branches to their views.
///
/// Like the absence of freehand drawing, this is closed over eight branches
/// (`.when`). A new primitive means adding a branch here, always together with
/// `boardElementKinds` on the contract side.
class BoardElementView extends StatelessWidget {
  const BoardElementView({required this.element, super.key});

  final BoardElement element;

  @override
  Widget build(BuildContext context) {
    final Widget drawn = element.when(
      latex: (String tex) => LatexElementView(tex: tex),
      text: (String body) => TextElementView(body: body),
      plot: (String fn, BoardDomain domain, List<PlotMark>? marks) => _GraphicBox(
        painter: PlotPainter(fn: fn, domain: domain, marks: marks ?? const <PlotMark>[]),
      ),
      triangle: (List<BoardPoint> vertices, List<String>? labels, List<AngleMark>? marks) =>
          _GraphicBox(
            painter: TrianglePainter(vertices: vertices, labels: labels, marks: marks),
          ),
      circle: (BoardPoint center, double r, List<String>? labels) =>
          _GraphicBox(painter: CirclePainter(center: center, r: r, labels: labels)),
      sentence: (String text, String? gloss, String? focus) =>
          SentenceElementView(text: text, gloss: gloss, focus: focus),
      compare: (List<String> columns, List<List<String>> rows, String? title) =>
          CompareElementView(columns: columns, rows: rows, title: title),
      // The only branch with no painter: the content is SVG the server solved
      // and drew, so this branch does not change as the figure vocabulary grows.
      // `svg` is always present by the time it reaches the wire
      // (`ensureValidFigure`); it is null only on paths that skipped validation,
      // and then nothing is drawn.
      figure: (List<Map<String, dynamic>> items, String? svg, String? alt) =>
          svg == null ? const SizedBox.shrink() : FigureElementView(svg: svg),
    );

    // One announcement per line.
    //
    // `Math.tex` stacks a widget per symbol, so unwrapped it is read out in
    // fragments — "x", "hat", "2" — and `CustomPaint` figures are not read at
    // all. The fragments are removed with [ExcludeSemantics] and replaced by one
    // sentence.
    //
    // The board is the heart of this product, so without this a blind student
    // has no lesson at all. Announcement happens on device, so it does not affect
    // the TTS cost this design was keeping down.
    return Semantics(
      label: describeElement(element, AppStrings.of(context)),
      // Neither formulas nor figures are interactive.
      readOnly: true,
      child: ExcludeSemantics(child: drawn),
    );
  }
}

/// Shared container for plot / triangle / circle, at a natural height for one
/// board step.
class _GraphicBox extends StatelessWidget {
  const _GraphicBox({required this.painter});

  final CustomPainter painter;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: BoardStyle.graphicHeight,
      child: CustomPaint(painter: painter),
    );
  }
}
