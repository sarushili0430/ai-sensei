import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// 蛍光マーカー(handoff §7 視覚言語)。
///
/// 高校生のノート文化に接地したオリジナル要素で、Duolingoクローンに見せないための要。
/// 言えたこと = 黄、穴 = ピンク。
enum MarkerColor {
  said(AppColors.said),
  hole(AppColors.hole);

  const MarkerColor(this.color);
  final Color color;
}

class MarkerText extends StatelessWidget {
  const MarkerText(this.text, {required this.marker, super.key});

  final String text;
  final MarkerColor marker;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _MarkerPainter(marker.color),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.xs,
          vertical: AppSpacing.xs / 2,
        ),
        child: Text(text, style: Theme.of(context).textTheme.bodyLarge),
      ),
    );
  }
}

/// 下半分だけを塗る。線をまっすぐ引かず、端を少しずらして手引き感を出す。
class _MarkerPainter extends CustomPainter {
  const _MarkerPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()..color = color.withValues(alpha: 0.55);
    final double top = size.height * 0.45;
    final Path path = Path()
      ..moveTo(1, top + 1)
      ..lineTo(size.width - 2, top)
      ..lineTo(size.width, size.height - 1)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_MarkerPainter oldDelegate) => oldDelegate.color != color;
}
