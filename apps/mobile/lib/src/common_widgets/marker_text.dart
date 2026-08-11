import 'dart:async';
import 'dart:math' as math;
// 行ごとの高さを測るのに使う。material 経由では出てこない型。
import 'dart:ui' show BoxHeightStyle;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 蛍光マーカー(視覚言語)。
///
/// 高校生のノート文化に接地したオリジナル要素で、Duolingoクローンに見せないための要。
/// 言えたこと = 黄、穴 = ピンク。
///
/// 線は**左から右へ引かれる**。カルテは会話のあとに「書かれる」ものなので、
/// 出来上がった状態でいきなり置くより、引かれるところを見せたほうが
/// 自分の説明の記録だと分かる。複数行あるときは [delay] をずらして、
/// 上の行から順に引く。
enum MarkerColor {
  said(AppColors.said),
  hole(AppColors.hole);

  const MarkerColor(this.color);
  final Color color;
}

class MarkerText extends StatefulWidget {
  const MarkerText(this.text, {required this.marker, this.delay = Duration.zero, super.key});

  final String text;
  final MarkerColor marker;

  /// 引き始めるまでの待ち。行ごとにずらして順番に引く。
  final Duration delay;

  @override
  State<MarkerText> createState() => _MarkerTextState();
}

class _MarkerTextState extends State<MarkerText> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppDurations.draw,
  );
  Timer? _timer;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    // 動かさない設定なら、引き終わった状態で置く。
    if (AppMotion.isReduced(context)) {
      _controller.value = 1;
      return;
    }
    if (widget.delay == Duration.zero) {
      _controller.forward();
    } else {
      _timer = Timer(widget.delay, () {
        if (mounted) _controller.forward();
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  static const EdgeInsets _padding = EdgeInsets.symmetric(
    horizontal: AppSpacing.xs,
    vertical: AppSpacing.xs / 2,
  );

  @override
  Widget build(BuildContext context) {
    // ペンを走らせる速さ。等速だと機械的なので、終わりで少しだけ緩める。
    final Animation<double> progress = CurvedAnimation(parent: _controller, curve: AppCurves.enter);
    final TextStyle? style = Theme.of(context).textTheme.bodyLarge;

    return AnimatedBuilder(
      animation: progress,
      builder: (BuildContext context, Widget? child) => CustomPaint(
        painter: _MarkerPainter(
          text: widget.text,
          style: style,
          textScaler: MediaQuery.textScalerOf(context),
          textDirection: Directionality.of(context),
          padding: _padding,
          color: widget.marker.color,
          progress: progress.value,
        ),
        child: child,
      ),
      child: Padding(
        padding: _padding,
        child: Text(widget.text, style: style),
      ),
    );
  }
}

/// 文字の下半分だけを塗る。線をまっすぐ引かず、端を少しずらして手引き感を出す。
///
/// **行ごとに引く。** 折り返した文の全体を1枚の帯で塗ると、
/// 1行目が素通しのまま最終行だけ塗られた形になり、
/// 蛍光ペンではなく下線に見える。ペンも行の終わりで一度上がるので、
/// 引かれる順番は 1行目 → 2行目 になる。
///
/// 行の位置は、描く側で同じ文字列をもう一度レイアウトして測る。
/// [Text] と同じ style・textScaler・幅を渡しているので、結果は一致する。
class _MarkerPainter extends CustomPainter {
  const _MarkerPainter({
    required this.text,
    required this.style,
    required this.textScaler,
    required this.textDirection,
    required this.padding,
    required this.color,
    required this.progress,
  });

  final String text;
  final TextStyle? style;
  final TextScaler textScaler;
  final TextDirection textDirection;
  final EdgeInsets padding;
  final Color color;

  /// 0 = まだ引いていない、1 = 引き終わり。
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0 || text.isEmpty) return;

    final List<Rect> lines = _lineRects(size);
    if (lines.isEmpty) return;

    // ペン先は行をまたいで走る。総距離のうち、いまどこまで来たか。
    final double total = lines.fold<double>(0, (double sum, Rect it) => sum + it.width);
    double travelled = progress * total;
    final Paint paint = Paint()..color = color.withValues(alpha: 0.55);

    for (final Rect line in lines) {
      if (travelled <= 0) break;
      final double drawn = math.min(line.width, travelled);
      travelled -= drawn;

      final double top = line.top + line.height * 0.45;
      final double right = line.left + math.max(drawn, 1);
      final Path path = Path()
        ..moveTo(line.left, top + 1)
        ..lineTo(math.max(right - 2, line.left), top)
        ..lineTo(right, line.bottom - 1)
        ..lineTo(line.left - 1, line.bottom)
        ..close();
      canvas.drawPath(path, paint);
    }
  }

  /// 行ごとの矩形。同じ上端のボックスは1行としてまとめる。
  List<Rect> _lineRects(Size size) {
    final TextPainter painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: textDirection,
      textScaler: textScaler,
    )..layout(maxWidth: size.width - padding.horizontal);

    final List<TextBox> boxes = painter.getBoxesForSelection(
      TextSelection(baseOffset: 0, extentOffset: text.length),
      boxHeightStyle: BoxHeightStyle.max,
    );

    final List<Rect> lines = <Rect>[];
    for (final TextBox box in boxes) {
      final Rect rect = box.toRect().shift(Offset(padding.left, padding.top));
      if (lines.isNotEmpty && (lines.last.top - rect.top).abs() < 0.5) {
        lines[lines.length - 1] = lines.last.expandToInclude(rect);
      } else {
        lines.add(rect);
      }
    }
    return lines;
  }

  @override
  bool shouldRepaint(_MarkerPainter oldDelegate) =>
      oldDelegate.color != color ||
      oldDelegate.progress != progress ||
      oldDelegate.text != text ||
      oldDelegate.style != style ||
      oldDelegate.textScaler != textScaler;
}
