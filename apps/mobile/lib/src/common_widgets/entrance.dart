import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// Default entrance: floats up from slightly below.
///
/// Stagger [delay] per element in reading order — everything appearing at
/// once erases where to start. Skip it for unordered layouts like grids.
class FadeSlideIn extends StatefulWidget {
  const FadeSlideIn({
    required this.child,
    this.delay = Duration.zero,
    this.offset = 14,
    this.duration = AppDurations.enter,
    super.key,
  }) : index = 0;

  /// Delays by one step per [index], counting from the top.
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

  /// Position from the top; the stagger is derived from it
  /// (`Duration * int` cannot be const, so hold the index, not the value).
  final int index;

  /// How far below it starts, in pixels. Larger values feel restless.
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

  // MediaQuery is unavailable in initState, so start here.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    // Reduced motion: land in the finished state and create no timer
    // (a leftover timer fails widget tests as "pending").
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

/// Pops in from slightly smaller. The overshoot ([AppCurves.pop]) belongs
/// on lively screens only — on karte and review it makes the record look
/// flippant.
class PopIn extends StatelessWidget {
  const PopIn({required this.child, this.duration = AppDurations.celebrate, super.key});

  final Widget child;
  final Duration duration;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0.7, end: 1),
      duration: AppMotion.decorative(context, duration),
      curve: AppCurves.pop,
      builder: (BuildContext context, double scale, Widget? child) =>
          Transform.scale(scale: scale, child: child),
      child: child,
    );
  }
}

/// Counts up from 0. Only streak days and filled gaps are counted, so
/// those two are worth animating. Never used for scores or correctness —
/// we do not show those at all.
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
      // Reading out intermediate numbers is noise; leave a11y to the
      // caller's Semantics(label:).
      builder: (BuildContext context, double current, Widget? child) =>
          ExcludeSemantics(child: Text('${current.round()}', style: style)),
    );
  }
}
