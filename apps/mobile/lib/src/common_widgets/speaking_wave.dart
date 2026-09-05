import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 「聞いています」を表す波形。
///
/// **本物の音量には連動させない。** マイクの値を取りに行かないので、
/// まだ録音していないオンボーディングのリハーサルでも同じ部品が使える。
/// ここで示したいのは声の大きさではなく「先輩が聞いている状態」なので、
/// 実測値である必要がない。
class SpeakingWave extends StatefulWidget {
  const SpeakingWave({
    required this.active,
    this.color = AppColors.blue,
    this.bars = 5,
    this.height = 26,
    super.key,
  });

  final bool active;
  final Color color;
  final int bars;
  final double height;

  @override
  State<SpeakingWave> createState() => _SpeakingWaveState();
}

class _SpeakingWaveState extends State<SpeakingWave> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  bool _configured = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_configured) return;
    _configured = true;
    _sync();
  }

  @override
  void didUpdateWidget(SpeakingWave oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _sync();
  }

  void _sync() {
    if (widget.active && !AppMotion.isReduced(context)) {
      _controller.repeat();
    } else {
      _controller.stop();
      _controller.value = 0;
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
      // 会話中はずっと動く。字幕やボタンを巻き込んで塗り直さない。
      child: RepaintBoundary(
        child: AnimatedBuilder(
          animation: _controller,
          builder: (BuildContext context, Widget? child) => Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              for (int i = 0; i < widget.bars; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: Container(
                    width: 5,
                    height: _barHeight(i),
                    decoration: BoxDecoration(
                      color: widget.color.withValues(alpha: widget.active ? 0.9 : 0.3),
                      borderRadius: BorderRadius.circular(AppRadius.chip),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  double _barHeight(int index) {
    // 聞いていないときは、低いまま静かに並ぶ。消さないのは
    // 「マイクはここ」という置き場所を保つため。
    if (!widget.active) return widget.height * 0.22;

    // 隣とずらして波にする。中央を高くして、口元のように見せる。
    final double phase = _controller.value * 2 * math.pi + index * 1.1;
    final double center = 1 - (index - (widget.bars - 1) / 2).abs() / widget.bars;
    return widget.height * (0.25 + 0.75 * center * (0.5 + 0.5 * math.sin(phase)));
  }
}
