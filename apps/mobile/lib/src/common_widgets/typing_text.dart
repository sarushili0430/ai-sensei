import 'package:flutter/material.dart';

import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 先輩のせりふを1文字ずつ出す。
///
/// 一気に出すと「表示された文章」に見えるが、打たれていくと
/// **いま聞かれている**ように見える。先輩は試験官ではないので、
/// 質問が降ってくるのではなく、間をもって出てくるほうがいい。
///
/// 高さは最初から最後の1文字ぶんを確保する。行が増えるたびに
/// 下のボタンが動くと、読んでいる最中に画面が揺れる。
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

  /// 打ち終わったとき。次の操作を出す合図に使う。
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
      // 打ち終わった状態から始める。合図は次のフレームで送る
      // (値を入れた瞬間に呼ぶと、build の最中に親を setState させてしまう)。
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

        // まだ出ていないぶんは、透明にして**置いたまま**にする。
        // 消してしまうと文字が増えるたびに折り返しが変わり、
        // 読んでいる最中に下のボタンが動く。
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
          // 読み上げは打っている途中を追いかけない。全文を一度で渡す。
          semanticsLabel: widget.text,
        );
      },
    );
  }
}
