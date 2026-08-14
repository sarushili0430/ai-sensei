import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// Types senpai's line out one character at a time.
///
/// Shown all at once it reads as displayed text; typed out it reads as
/// being asked right now. Senpai is not an examiner, so the question
/// should arrive with a beat rather than drop in.
///
/// Height is reserved for the full string up front, so buttons below do
/// not shift while you read.
class TypingText extends StatefulWidget {
  const TypingText(
    this.text, {
    this.style,
    this.textAlign = TextAlign.start,
    this.onDone,
    super.key,
  });

  final String text;
  final TextStyle? style;
  final TextAlign textAlign;

  /// Fired when typing finishes; cue for revealing the next action.
  final VoidCallback? onDone;

  @override
  State<TypingText> createState() => _TypingTextState();
}

class _TypingTextState extends State<TypingText> with SingleTickerProviderStateMixin {
  late final List<int> _runes = widget.text.runes.toList(growable: false);
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppDurations.typeChar * _runes.length,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      // Start finished. Signal on the next frame — signalling immediately
      // would setState the parent mid-build.
      _controller.value = 1;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onDone?.call();
      });
      return;
    }

    _controller.addStatusListener((AnimationStatus status) {
      if (status == AnimationStatus.completed) widget.onDone?.call();
    });
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) {
        final int shown = (_runes.length * _controller.value).round();

        // Keep untyped text in place but transparent: removing it would
        // reflow on every character and shift the buttons below.
        return Text.rich(
          TextSpan(
            children: <InlineSpan>[
              TextSpan(text: String.fromCharCodes(_runes.take(shown))),
              TextSpan(
                text: String.fromCharCodes(_runes.skip(shown)),
                style: const TextStyle(color: Colors.transparent),
              ),
            ],
          ),
          style: widget.style,
          textAlign: widget.textAlign,
          // a11y does not follow the typing; hand over the full string.
          semanticsLabel: widget.text,
        );
      },
    );
  }
}
