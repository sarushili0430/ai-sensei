import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// 後輩の表情(handoff §7「最大の報酬はキャラの表情」)。
///
/// 説明が伝わると顔が輝く。ご褒美とプロテジェ効果が一致する場所なので、
/// ここが体験の中心になる。
///
/// v0はCustomPaintの簡素な自作。表情差分3〜5枚から始め、
/// v1.1でRiveのステートマシンに載せ替える(そのとき差し替えるのはこのWidgetだけ)。
enum KohaiMood {
  /// 待機。まだ何も聞いていない。
  neutral,

  /// 聞いている。うなずきの微アニメーション。
  listening,

  /// わかった!(説明が伝わった瞬間の最大の報酬)
  delighted,

  /// うーん、まだピンときていない。**責める顔ではない。**
  puzzled,
}

class KohaiFace extends StatelessWidget {
  const KohaiFace({required this.mood, this.size = 120, super.key});

  final KohaiMood mood;
  final double size;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: AppDurations.reaction,
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: mood == KohaiMood.delighted
            ? AppColors.said.withValues(alpha: 0.25)
            : AppColors.blue.withValues(alpha: 0.12),
        shape: BoxShape.circle,
      ),
      child: Semantics(
        label: switch (mood) {
          KohaiMood.neutral => '後輩が待っています',
          KohaiMood.listening => '後輩が聞いています',
          KohaiMood.delighted => '後輩が納得しています',
          KohaiMood.puzzled => '後輩が考えています',
        },
        child: CustomPaint(painter: _FacePainter(mood)),
      ),
    );
  }
}

class _FacePainter extends CustomPainter {
  const _FacePainter(this.mood);

  final KohaiMood mood;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint stroke = Paint()
      ..color = AppColors.ink
      ..strokeWidth = size.width * 0.045
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    final double eyeY = size.height * 0.42;
    final double eyeDx = size.width * 0.19;
    final double eyeRadius = size.width * 0.045;

    if (mood == KohaiMood.delighted) {
      // ^ ^ の目。輝きは色(背景)と目の形の両方で出す。
      for (final double sign in <double>[-1, 1]) {
        final Path path = Path()
          ..moveTo(size.width / 2 + sign * eyeDx - eyeRadius * 1.6, eyeY + eyeRadius)
          ..lineTo(size.width / 2 + sign * eyeDx, eyeY - eyeRadius)
          ..lineTo(size.width / 2 + sign * eyeDx + eyeRadius * 1.6, eyeY + eyeRadius);
        canvas.drawPath(path, stroke);
      }
    } else {
      final Paint fill = Paint()..color = AppColors.ink;
      for (final double sign in <double>[-1, 1]) {
        canvas.drawCircle(
          Offset(size.width / 2 + sign * eyeDx, eyeY),
          eyeRadius * (mood == KohaiMood.listening ? 1.15 : 1.0),
          fill,
        );
      }
    }

    // 口。困り顔でも口角は下げない(責める顔にしないため)。
    final double mouthY = size.height * 0.63;
    final Rect mouth = Rect.fromCenter(
      center: Offset(size.width / 2, mouthY),
      width: size.width * 0.26,
      height: size.height * (mood == KohaiMood.delighted ? 0.16 : 0.08),
    );
    canvas.drawArc(mouth, 0.15, 2.85, false, stroke);

    if (mood == KohaiMood.puzzled) {
      // 「?」ではなく、小さな汗。疑問符は問い詰める印象になる。
      canvas.drawCircle(
        Offset(size.width * 0.78, size.height * 0.34),
        size.width * 0.035,
        Paint()..color = AppColors.blue.withValues(alpha: 0.6),
      );
    }
  }

  @override
  bool shouldRepaint(_FacePainter oldDelegate) => oldDelegate.mood != mood;
}
