import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/tokens.dart';

/// 厚みのあるボタン。
///
/// Duolingoから借りるのは「文法」であって「語彙」ではない。
/// 押すと沈み込む触感だけを借り、色と言葉はこのアプリのものにする。
class ChunkyButton extends StatefulWidget {
  const ChunkyButton({
    required this.label,
    required this.onPressed,
    this.color = AppColors.blue,
    this.foregroundColor = Colors.white,
    this.expanded = true,
    this.sunkWhenDisabled = false,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final Color color;
  final Color foregroundColor;
  final bool expanded;
  final bool sunkWhenDisabled;

  @override
  State<ChunkyButton> createState() => _ChunkyButtonState();
}

class _ChunkyButtonState extends State<ChunkyButton> {
  bool _pressed = false;

  bool get _enabled => widget.onPressed != null;

  void _setPressed(bool value) {
    if (!_enabled) return;
    setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) {
    // 到達宣言のように「もう受け取った」無効状態だけは、押し込まれた位置へ
    // 残す。待機中など別理由の無効ボタンまで動かすと、既存画面の高さが変わる。
    final bool sunk = _pressed || (!_enabled && widget.sunkWhenDisabled);
    final double depth = sunk ? 0 : AppElevation.chunkyDepth;

    return Semantics(
      button: true,
      enabled: _enabled,
      label: widget.label,
      child: GestureDetector(
        onTapDown: (_) => _setPressed(true),
        onTapCancel: () => _setPressed(false),
        onTapUp: (_) => _setPressed(false),
        onTap: _enabled
            ? () {
                HapticFeedback.lightImpact();
                widget.onPressed!();
              }
            : null,
        child: AnimatedContainer(
          duration: AppDurations.tap,
          width: widget.expanded ? double.infinity : null,
          padding: EdgeInsets.only(top: AppElevation.chunkyDepth - depth),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 24),
            decoration: BoxDecoration(
              color: _enabled ? widget.color : AppColors.border,
              borderRadius: BorderRadius.circular(AppRadius.button),
              boxShadow: <BoxShadow>[
                if (_enabled)
                  BoxShadow(
                    color: Color.alphaBlend(Colors.black26, widget.color),
                    offset: Offset(0, depth),
                  ),
              ],
            ),
            child: Text(
              widget.label,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: _enabled ? widget.foregroundColor : AppColors.inkMuted,
                  ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 「無料のまま続ける」「今日はここまで」など、選んでも損しない選択肢。
/// 目立たせないが、隠さない(HAMMは誠実さを見る)。
class GhostButton extends StatelessWidget {
  const GhostButton({required this.label, required this.onPressed, super.key});

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        foregroundColor: AppColors.inkMuted,
      ),
      child: Text(label, style: Theme.of(context).textTheme.bodyMedium),
    );
  }
}
