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
  const ConfettiBurst({this.pieces = 26, this.looping = false, super.key});

  final int pieces;

  /// 降り続けるかどうか。
  ///
  /// 一度きりの紙吹雪は数秒で**画面の下から抜けきって**終わる。そのあとも
  /// 何かを待たせる画面では、紙が消えたところで祝いが終わって見えるので、
  /// 待っているあいだは降り続け、待ちが終わったところで最後にもう一降りして止まる。
  final bool looping;

  @override
  State<ConfettiBurst> createState() => _ConfettiBurstState();
}

class _ConfettiBurstState extends State<ConfettiBurst> with SingleTickerProviderStateMixin {
  /// 一度きりの紙吹雪。**最後の1枚が画面の下へ抜けきるまでの長さ**。
  ///
  /// 以前は 2.2秒で、いちばん遅い紙は画面の半ばまでしか降りていなかった。
  /// `forward()` はそこで止まって値を保つので、**紙が空中に貼りついたまま
  /// 残る**(実機で確認)。降り方の速さは変えず、[_burstSpan] のぶんだけ
  /// 時間を伸ばして、全部を下から出しきる。
  static const Duration _burst = Duration(milliseconds: 3600);

  /// 降り続けるときの一周。急かさない速さにする(待たせている画面なので)。
  static const Duration _loop = Duration(milliseconds: 4200);

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.looping ? _loop : _burst,
  );
  late final List<_Piece> _confetti = _buildPieces(widget.pieces);
  bool _started = false;

  /// 動かさない設定のときに描く時刻。
  ///
  /// 何も描かないのではなく、紙が散らばりきった瞬間で止める。
  /// 動きが苦手なだけで、祝われたい気持ちは同じなので。
  ///
  /// 止める場所は**降り具合で決める**([_scatterFall])。進み具合の生の値で
  /// 持つと、[_burstSpan] を触るたびに絵が動いてしまう。
  static const double _stillFrame = _scatterFall / _burstSpan;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = _stillFrame;
      return;
    }
    if (widget.looping) {
      _controller.repeat();
    } else {
      _controller.forward();
    }
  }

  @override
  void didUpdateWidget(ConfettiBurst oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.looping == widget.looping) return;
    if (AppMotion.isReduced(context)) return;

    // `repeat()` は今の duration で回るので、先に入れ替える。
    if (widget.looping) {
      _controller
        ..duration = _loop
        ..repeat();
    } else {
      // 待っていたものが届いた。降り続けるのをやめて、最後にもう一降りする。
      _controller
        ..duration = _burst
        ..forward(from: 0);
    }
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
              painter: _ConfettiPainter(
                pieces: _confetti,
                progress: _controller.value,
                looping: widget.looping,
              ),
              size: Size.infinite,
            ),
          ),
        ),
      ),
    );
  }
}

/// 降り始めがいちばん遅い紙の待ち(進み具合)。
const double _maxDelay = 0.35;

/// いちばん遅い紙の速さと、速さの幅。
const double _minSpeed = 0.75;
const double _speedSpread = 0.5;

/// 画面の上のどこから降らせるか(画面の高さぶん。負 = 画面の外)。
const double _startFall = -0.15;

/// 降り具合 1 が、画面の高さの何ぶんにあたるか。
const double _fallRate = 1.25;

/// 薄くなり始める降り具合と、消す降り具合。
const double _fadeFall = 0.85;
const double _exitFall = 1.2;

/// 散らばりきった絵と見なす降り具合([_ConfettiBurstState._stillFrame])。
const double _scatterFall = 0.35;

/// 一度きりのとき、進み具合の 1 をどこまで伸ばして読むか。
///
/// **いちばん遅く降り始めた、いちばん遅い紙が、下から抜けきるところ**に
/// 合わせてある。ここが足りないと、まだ空にいる紙が終わりでそのまま止まり、
/// 画面の途中に紙が貼りついたまま残る —— 紙吹雪が「固まった」に見えるのは
/// これが原因だった。速さの上限や待ちを触ったら、この式が追いかける。
const double _burstSpan = _maxDelay + _exitFall / (_minSpeed * _fallRate);

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
      delay: random.nextDouble() * _maxDelay,
      speed: _minSpeed + random.nextDouble() * _speedSpread,
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
  const _ConfettiPainter({
    required this.pieces,
    required this.progress,
    this.looping = false,
  });

  final List<_Piece> pieces;
  final double progress;
  final bool looping;

  @override
  void paint(Canvas canvas, Size size) {
    for (final _Piece piece in pieces) {
      // 一度きりのときは、紙ごとの速さの差がそのまま散らばりになる。
      // 進み具合は [_burstSpan] 倍して読む —— 1 で終わる時計のまま
      // 最後まで降らせると、いちばん遅い紙が空中で止まる。
      //
      // 降り続けるときは**同じ速さで位相だけずらす**。速さを紙ごとに変えると
      // 一周するたびに位相が寄っていき、「どっと降って、しばらく空」の
      // 繰り返しになる。位相をずらして回せば、継ぎ目のないひとつづきに見える。
      final double local = looping
          ? (progress + piece.delay + piece.x) % 1.0
          : (progress * _burstSpan - piece.delay) * piece.speed;
      if (local <= 0) continue;

      // 落ちきったら消す。溜まった紙を床に描くと、画面の下が重くなる。
      final double fall = local * _fallRate;
      if (fall > _exitFall) continue;

      final double dy = _startFall + fall;
      final double dx = piece.x + piece.drift * math.sin(local * math.pi * 2);
      final double fade = fall > _fadeFall ? (_exitFall - fall) / (_exitFall - _fadeFall) : 1.0;

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
  bool shouldRepaint(_ConfettiPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.looping != looping;
}
