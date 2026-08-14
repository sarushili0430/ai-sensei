import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/tokens.dart';

/// Button with depth. Borrows only Duolingo's press-to-sink feel;
/// the colors and wording stay our own.
class ChunkyButton extends StatefulWidget {
  const ChunkyButton({
    required this.label,
    required this.onPressed,
    this.color = AppColors.blue,
    this.foregroundColor = Colors.white,
    this.expanded = true,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final Color color;
  final Color foregroundColor;
  final bool expanded;

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
    final double depth = _pressed ? 0 : AppElevation.chunkyDepth;

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

/// Low-stakes options ("stay on free", "done for today").
/// De-emphasized, but never hidden.
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
