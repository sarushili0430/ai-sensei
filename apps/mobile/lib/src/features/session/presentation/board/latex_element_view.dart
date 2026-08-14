import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';

import '../../../../telemetry/telemetry.dart';
import '../../../../theme/tokens.dart';
import 'board_style.dart';

/// Draws a LaTeX formula (`BoardElement.latex`).
///
/// Some formulas do not fit the effective width. A character limit alone cannot
/// guarantee display width, so this measures and reacts:
///
///   1. measure the intrinsic width (unconstrained) once
///   2. if it fits the available width, place it at 1:1
///   3. if not, but [BoardStyle.latexMinScale] (70%) or more is enough, shrink
///      with `FittedBox`
///   4. below 70%, stop shrinking: pin 70% and fall back to horizontal scrolling
///
/// On step 4: such a formula should have arrived already split across two steps
/// by the agent, so reaching here is close to a contract violation. The best
/// mobile can do is not "shrink until unreadable" but "at least make all of it
/// reachable". Measured with deliberately long formulas (intrinsic 624pt), 54%
/// into a 340pt box was "just readable" and 32% into a 200pt box was "hard";
/// anything under 70% is longer still, so unconditional shrinking would almost
/// certainly become unreadable. Horizontal scrolling is undesirable on a board
/// (it lost the measured comparison), but "scroll and read it all" beats "pinned
/// and unreadable". It should never happen, so it is recorded to stay visible in
/// production (`Degradation.latexScaleFloor`; it previously reached only
/// `debugPrint`, so a broken agent-side split was invisible forever).
///
/// Falling back to horizontal scrolling alone would revive the very reason that
/// option lost: a still frame gives no cue that more follows. So
/// [_ScrollWithEdgeFade] overlays a right-edge fade, guaranteeing not that
/// scrolling is possible but that it is visibly possible. The fade disappears
/// once the end is visible, since a cue over nothing hidden is unnatural.
class LatexElementView extends StatefulWidget {
  const LatexElementView({required this.tex, super.key});

  final String tex;

  @override
  State<LatexElementView> createState() => _LatexElementViewState();
}

class _LatexElementViewState extends State<LatexElementView> {
  final GlobalKey _measureKey = GlobalKey();
  double? _naturalWidth;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
  }

  void _measure() {
    final RenderBox? box = _measureKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final double width = box.size.width;
    if (!mounted || width == _naturalWidth) return;
    setState(() => _naturalWidth = width);
  }

  /// Records a narrowed width once.
  ///
  /// `LayoutBuilder` runs on every rebuild, so without a guard here one screen
  /// would report many times. [Telemetry]'s throttle is per kind and key and
  /// would drop the duplicates anyway, but the wasted calls stop earlier.
  bool _reportedNarrow = false;

  void _reportIfTooNarrow(BuildContext context, double available) {
    // Compared against the width this device should afford. Using 340pt as the
    // threshold would trip on every iPhone SE (327pt effective), every time.
    final double expected = BoardStyle.expectedWidth(MediaQuery.sizeOf(context).width);
    if (_reportedNarrow || available >= expected) return;
    _reportedNarrow = true;
    Telemetry.report(
      DegradationEvent.boardTooNarrow(availableWidth: available, assumedWidth: expected),
    );
  }

  Widget _math({Key? key, double fontSize = BoardStyle.latexFontSize}) => Math.tex(
    widget.tex,
    key: key,
    mathStyle: MathStyle.display,
    textStyle: TextStyle(fontSize: fontSize, color: BoardStyle.chalk),
    onErrorFallback: (FlutterMathException error) => Text(
      '数式を表示できません',
      style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.hole),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double available = constraints.maxWidth;
        final double? natural = _naturalWidth;

        // Compare the board's available width against what this device should
        // afford.
        //
        // The 70% floor was chosen against a width, so a narrowed one pushes
        // formulas verified to fit into horizontal scrolling. It happened: a
        // board shown outside a lesson dropped to 311pt once wrapped in a card
        // (see `_BoardSection` in the karte). That is invisible by eye, so we
        // watch the width itself.
        _reportIfTooNarrow(context, available);

        // Measurement only: invisible (opacity 0) and unconstrained via
        // `OverflowBox`, purely to find the intrinsic width in pt.
        final Widget measurer = Positioned.fill(
          child: IgnorePointer(
            child: ExcludeSemantics(
              child: Opacity(
                opacity: 0,
                child: OverflowBox(
                  minWidth: 0,
                  maxWidth: double.infinity,
                  alignment: Alignment.centerLeft,
                  child: _math(key: _measureKey),
                ),
              ),
            ),
          ),
        );

        if (natural == null) {
          // Reserve only the height until measurement finishes, so stacking
          // positions do not jitter.
          return SizedBox(
            height: BoardStyle.latexFontSize * 1.6,
            child: Stack(children: <Widget>[measurer]),
          );
        }

        if (natural <= available) {
          return Stack(children: <Widget>[_math(), measurer]);
        }

        final double scale = available / natural;
        if (scale >= BoardStyle.latexMinScale) {
          return SizedBox(
            width: available,
            child: Stack(
              children: <Widget>[
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: _math(),
                ),
                measurer,
              ],
            ),
          );
        }

        // Below 70%; see the class comment.
        //
        // This signals that the agent-side split is not working. It previously
        // reached only `debugPrint`, so in production a broken split was
        // invisible forever.
        //
        // Throttled per formula (this layer does not know `board_id`): one report
        // however often the same formula is redrawn, separate ones for different
        // formulas. `tex` is truncated inside `DegradationEvent`, so the full
        // string may be passed.
        Telemetry.report(
          DegradationEvent.latexScaleFloor(
            tex: widget.tex,
            scale: scale,
            minScale: BoardStyle.latexMinScale,
            availableWidth: available,
            naturalWidth: natural,
          ),
        );
        // Redraw at 70% font size rather than Transform.scale. Transform shrinks
        // only the painting and leaves the layout width, so the scroll extent
        // keeps the shrunken-away blank space. Changing the font size directly
        // makes the scroll extent match what is drawn.
        return SizedBox(
          width: available,
          child: Stack(
            children: <Widget>[
              _ScrollWithEdgeFade(
                child: _math(fontSize: BoardStyle.latexFontSize * BoardStyle.latexMinScale),
              ),
              measurer,
            ],
          ),
        );
      },
    );
  }
}

/// Horizontal scrolling with a right-edge "more to come" fade.
///
/// The criterion is not that scrolling is possible but that it is visibly
/// possible. The fade disappears once the end is visible, so it never claims
/// there is more when there is not.
class _ScrollWithEdgeFade extends StatefulWidget {
  const _ScrollWithEdgeFade({required this.child});

  final Widget child;

  @override
  State<_ScrollWithEdgeFade> createState() => _ScrollWithEdgeFadeState();
}

class _ScrollWithEdgeFadeState extends State<_ScrollWithEdgeFade> {
  final ScrollController _controller = ScrollController();

  // Before measuring, default to "there might be more": an extra cue is safer
  // than the failure mode this fade exists to prevent.
  bool _hasMore = true;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_updateHasMore);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateHasMore());
  }

  void _updateHasMore() {
    if (!_controller.hasClients) return;
    final bool hasMore = _controller.position.maxScrollExtent - _controller.position.pixels > 1;
    if (hasMore == _hasMore || !mounted) return;
    setState(() => _hasMore = hasMore);
  }

  @override
  void dispose() {
    _controller.removeListener(_updateHasMore);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        SingleChildScrollView(
          controller: _controller,
          scrollDirection: Axis.horizontal,
          child: widget.child,
        ),
        if (_hasMore)
          const Positioned(
            top: 0,
            bottom: 0,
            right: 0,
            child: IgnorePointer(child: _EdgeFade()),
          ),
      ],
    );
  }
}

/// The right-edge fade itself.
///
/// Colors stay within existing tokens (`AppColors.background`, transparent to
/// opaque). The last few characters dim under the band, but actively showing
/// "this is cut off" is safer than being misread as "that's all".
///
/// The color assumes the board sits directly on `AppColors.background` (the
/// Scaffold's ground). Recorded here as a known premise: putting the board on a
/// card later means matching this to `AppColors.surface` or similar.
class _EdgeFade extends StatelessWidget {
  const _EdgeFade();

  static const double _width = 28;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: _width,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            // Built from AppColors.background; no new color is defined.
            // alpha:0 is that color made transparent, not a different color.
            colors: <Color>[BoardStyle.surface.withValues(alpha: 0), BoardStyle.surface],
          ),
        ),
      ),
    );
  }
}
