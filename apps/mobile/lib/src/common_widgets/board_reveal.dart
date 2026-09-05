import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 板書の1行が「書かれる」動き。
///
/// [MarkerText]([marker_text.dart])の「進捗値でペン先を走らせる`CustomPainter`」と
/// 同じ設計を、文字の下線だけでなく任意のウィジェット(数式・図形)に一般化した。
/// 左から右へクリップ境界が動くことで、ペン先が通り過ぎた分だけ見えるようになる。
/// アニメーションのライフサイクル(`AnimationController` → `Timer`での遅延開始 →
/// `AppMotion.isReduced`での即終了 → `dispose`)は `MarkerText` と同じ形にしてある。
///
/// 板書は**前の行を消さない**(計画書§3-2)。だから同じ`AppDurations.draw`
/// (=420ms。マーカーを引く速さと同じ)を使うことで、板書とカルテのマーカーが
/// 同じモーション言語で揃う(現地調査 §4「板書とカルテが同じ筆致になる」)。
class BoardReveal extends StatefulWidget {
  const BoardReveal({required this.child, this.delay = Duration.zero, super.key});

  final Widget child;

  /// 引き始めるまでの待ち。複数行を意図的にずらして見せたいときに使う
  /// (通常の受信では、行が1つずつ届いた時点で描けばよいのでゼロのままでよい)。
  final Duration delay;

  @override
  State<BoardReveal> createState() => _BoardRevealState();
}

class _BoardRevealState extends State<BoardReveal> with SingleTickerProviderStateMixin {
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

  @override
  Widget build(BuildContext context) {
    final Animation<double> progress = CurvedAnimation(parent: _controller, curve: AppCurves.enter);

    return AnimatedBuilder(
      animation: progress,
      builder: (BuildContext context, Widget? child) =>
          ClipRect(clipper: _LeftToRightClipper(progress.value), child: child),
      child: widget.child,
    );
  }
}

class _LeftToRightClipper extends CustomClipper<Rect> {
  const _LeftToRightClipper(this.progress);

  /// 0 = まだ何も見えていない、1 = 全部見えている。
  final double progress;

  @override
  Rect getClip(Size size) => Rect.fromLTWH(0, 0, size.width * progress, size.height);

  @override
  bool shouldReclip(covariant _LeftToRightClipper oldClipper) => oldClipper.progress != progress;
}
