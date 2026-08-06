import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 少し下から浮き上がりながら現れる。画面に入ってくるときの既定の動き。
///
/// [delay] を要素ごとにずらして「段差」を作る。同時に全部が現れると
/// どこから読むのかが消えるので、**読んでほしい順**にずらす。
/// 順序が意味を持たない並び(カードのグリッドなど)には使わない。
class FadeSlideIn extends StatefulWidget {
  const FadeSlideIn({
    required this.child,
    this.delay = Duration.zero,
    this.offset = 14,
    this.duration = AppDurations.enter,
    super.key,
  }) : index = 0;

  /// 上から数えて [index] 番目として、段差ぶんだけ遅らせる。
  const FadeSlideIn.staggered({
    required this.child,
    required this.index,
    this.offset = 14,
    this.duration = AppDurations.enter,
    super.key,
  }) : delay = Duration.zero;

  final Widget child;
  final Duration delay;
  final Duration duration;

  /// 上から何番目か。段差はここから計算する
  /// (`Duration * int` は const にできないので、値ではなく番号で持つ)。
  final int index;

  /// 何ピクセル下から上がってくるか。大きくすると落ち着かなくなる。
  final double offset;

  Duration get _delay => delay + AppDurations.stagger * index;

  @override
  State<FadeSlideIn> createState() => _FadeSlideInState();
}

class _FadeSlideInState extends State<FadeSlideIn> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
  );
  Timer? _timer;
  bool _started = false;

  // MediaQuery は initState では読めないので、開始はここでする。
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    // 動かさない設定なら、終わった状態で置く。タイマーも作らない
    // (残ったタイマーは widget test が「保留中」で落とす)。
    if (AppMotion.isReduced(context)) {
      _controller.value = 1;
      return;
    }
    final Duration delay = widget._delay;
    if (delay == Duration.zero) {
      _controller.forward();
    } else {
      _timer = Timer(delay, () {
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
    final Animation<double> curved = CurvedAnimation(parent: _controller, curve: AppCurves.enter);

    return AnimatedBuilder(
      animation: curved,
      builder: (BuildContext context, Widget? child) => Opacity(
        opacity: curved.value,
        child: Transform.translate(
          offset: Offset(0, widget.offset * (1 - curved.value)),
          child: child,
        ),
      ),
      child: widget.child,
    );
  }
}

/// 数を 0 から数え上げる。
///
/// 数えているのが「連続日数」と「埋めた穴」だけだからこそ、
/// その2つは増えたことが見えたほうがいい(handoff §7)。
/// 正誤や点数には使わない — そもそも出さない。
class CountUpText extends StatelessWidget {
  const CountUpText(this.value, {this.style, this.duration = AppDurations.celebrate, super.key});

  final int value;
  final TextStyle? style;
  final Duration duration;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: value.toDouble()),
      duration: AppMotion.decorative(context, duration),
      curve: AppCurves.enter,
      // 途中の数を読み上げても意味がない。読み上げは呼び出し側の
      // Semantics(label:) に任せる。
      builder: (BuildContext context, double current, Widget? child) =>
          ExcludeSemantics(child: Text('${current.round()}', style: style)),
    );
  }
}
