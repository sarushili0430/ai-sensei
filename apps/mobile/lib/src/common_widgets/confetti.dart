import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 祝福の紙吹雪。祝福画面の背景に一度だけ降る。
///
/// にぎやかさは色と紙で出す。**点数・星・XPでは出さない**(§0 の約束2)。
/// 紙の色もアプリの語彙から取る — 黄(言えた)・ピンク(穴)・オレンジ(連続日数)。
/// 埋めた穴が祝われているのだと、色だけで分かるように。
class ConfettiBurst extends StatefulWidget {
  const ConfettiBurst({this.pieces = 26, super.key});

  final int pieces;

  @override
  State<ConfettiBurst> createState() => _ConfettiBurstState();
}

class _ConfettiBurstState extends State<ConfettiBurst> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2200),
  );
  late final List<_Piece> _confetti = _buildPieces(widget.pieces);
  bool _started = false;

  /// 動かさない設定のときに描く時刻。
  ///
  /// 何も描かないのではなく、紙が散らばりきった瞬間で止める。
  /// 動きが苦手なだけで、祝われたい気持ちは同じなので。
  static const double _stillFrame = 0.35;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = _stillFrame;
      return;
    }
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: IgnorePointer(
        // 背面で降り続ける。前に載っている文字まで塗り直させない。
        child: RepaintBoundary(
          child: AnimatedBuilder(
            animation: _controller,
            builder: (BuildContext context, Widget? child) => CustomPaint(
              painter: _ConfettiPainter(pieces: _confetti, progress: _controller.value),
              size: Size.infinite,
            ),
          ),
        ),
      ),
    );
  }
}

/// 紙1枚ぶん。位置も回転も**固定の種**から作る。
/// 毎回違う絵にすると golden が撮れないし、違う必要もない。
List<_Piece> _buildPieces(int count) {
  final math.Random random = math.Random(20260930);
  const List<Color> palette = <Color>[
    AppColors.said,
    AppColors.hole,
    AppColors.streak,
    AppColors.blue,
  ];

  return List<_Piece>.generate(count, (int i) {
    return _Piece(
      x: random.nextDouble(),
      delay: random.nextDouble() * 0.35,
      speed: 0.75 + random.nextDouble() * 0.5,
      drift: (random.nextDouble() - 0.5) * 0.22,
      spin: (random.nextDouble() - 0.5) * 8,
      width: 5 + random.nextDouble() * 5,
      height: 8 + random.nextDouble() * 6,
      color: palette[i % palette.length],
    );
  }, growable: false);
}

@immutable
class _Piece {
  const _Piece({
    required this.x,
    required this.delay,
    required this.speed,
    required this.drift,
    required this.spin,
    required this.width,
    required this.height,
    required this.color,
  });

  final double x;
  final double delay;
  final double speed;
  final double drift;
  final double spin;
  final double width;
  final double height;
  final Color color;
}

class _ConfettiPainter extends CustomPainter {
  const _ConfettiPainter({required this.pieces, required this.progress});

  final List<_Piece> pieces;
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    for (final _Piece piece in pieces) {
      final double local = (progress - piece.delay) * piece.speed;
      if (local <= 0) continue;

      // 落ちきったら消す。溜まった紙を床に描くと、画面の下が重くなる。
      final double fall = local * 1.25;
      if (fall > 1.2) continue;

      final double dy = -0.15 + fall;
      final double dx = piece.x + piece.drift * math.sin(local * math.pi * 2);
      final double fade = fall > 0.85 ? (1.2 - fall) / 0.35 : 1.0;

      canvas.save();
      canvas.translate(dx * size.width, dy * size.height);
      canvas.rotate(local * piece.spin);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: Offset.zero,
            width: piece.width,
            // ひらひらさせる。厚みが無いものが回っている感じ。
            height: piece.height * math.cos(local * piece.spin).abs().clamp(0.25, 1.0),
          ),
          const Radius.circular(2),
        ),
        Paint()..color = piece.color.withValues(alpha: 0.85 * fade.clamp(0.0, 1.0)),
      );
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_ConfettiPainter oldDelegate) => oldDelegate.progress != progress;
}
