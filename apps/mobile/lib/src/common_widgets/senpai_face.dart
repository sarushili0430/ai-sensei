import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../theme/motion.dart';
import '../theme/tokens.dart';

/// Senpai's face — the app's biggest reward: it lights up the moment a
/// teach-back lands.
///
/// v0 is hand-rolled CustomPaint; v1.1 swaps in a Rive state machine
/// (only this widget changes). Two motion tracks: always-on idle
/// (breathing, blinking, nodding) from a single [AppDurations.breath]
/// controller, and one-shot mood changes from a second one.
enum SenpaiMood {
  /// Idle: not started yet, or simply received. Stays here after
  /// "I can't explain it" too — see [puzzled].
  neutral,

  /// Listening to the teach-back; subtle nodding.
  listening,

  /// "Yes, that's it" — the peak of the experience, the moment the
  /// teach-back lands.
  delighted,

  /// Senpai is the one struggling — never aimed at the student.
  ///
  /// Used only when we failed on our side (senpai could not join or
  /// connect); hence the sweat drop. Never used when the student gets
  /// stuck: that is expected, and staging it as failure would break the
  /// promise. Stay [neutral] there and answer with words and marker.
  puzzled,
}

class SenpaiFace extends StatefulWidget {
  const SenpaiFace({required this.mood, this.size = 120, super.key});

  final SenpaiMood mood;
  final double size;

  @override
  State<SenpaiFace> createState() => _SenpaiFaceState();
}

class _SenpaiFaceState extends State<SenpaiFace> with TickerProviderStateMixin {
  /// Phase behind breathing, blinking and nodding; loops 0 -> 1 forever.
  late final AnimationController _ambient = AnimationController(
    vsync: this,
    duration: AppDurations.breath,
  );

  /// Runs only on a mood change. Starts at 1 (already settled).
  late final AnimationController _mood = AnimationController(
    vsync: this,
    duration: AppDurations.celebrate,
    value: 1,
  );

  bool _configured = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_configured) return;
    _configured = true;

    // Reduced motion: hold the phase at 0 — sin(0) is the pre-inhale still.
    if (!AppMotion.isReduced(context)) _ambient.repeat();
  }

  @override
  void didUpdateWidget(SenpaiFace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.mood == widget.mood) return;

    _mood
      ..duration = AppMotion.decorative(
        context,
        // Linger on the delighted beat: that one is the reward.
        widget.mood == SenpaiMood.delighted ? AppDurations.celebrate : AppDurations.reaction,
      )
      ..forward(from: 0);
  }

  @override
  void dispose() {
    _ambient.dispose();
    _mood.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Resolve the a11y label once, outside the builder.
    final AppStrings strings = AppStrings.of(context);

    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[_ambient, _mood]),
      builder: (BuildContext context, Widget? child) {
        final double phase = _ambient.value;
        final double wave = math.sin(phase * 2 * math.pi);
        final double moodT = _mood.value;

        // Breathing. Keep the swell tiny, or an idle screen feels restless.
        double scale = 1 + 0.022 * wave;

        // Delighted bounce: overshoot, then settle.
        if (widget.mood == SenpaiMood.delighted) {
          scale += 0.13 * math.sin(moodT * math.pi);
        }

        // Nod: three times the breathing rate, dips and returns.
        double dy = 0;
        if (widget.mood == SenpaiMood.listening) {
          final double nod = (phase * 3) % 1;
          dy = widget.size * 0.022 * (1 - math.cos(nod * 2 * math.pi)) / 2;
        }

        // Joy outlasts the first bounce: the celebration screen can keep
        // you waiting, and a one-shot bounce then looks frozen. Driven off
        // the breathing phase, so no extra timer and no extra repaint.
        if (widget.mood == SenpaiMood.delighted) {
          dy -= widget.size * 0.018 * math.max(0, math.sin(phase * 4 * math.pi));
        }

        // Head tilt: we are the ones struggling, not blaming the student.
        final double tilt = widget.mood == SenpaiMood.puzzled ? 0.05 + 0.015 * wave : 0;

        return AnimatedContainer(
          duration: AppDurations.reaction,
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: widget.mood == SenpaiMood.delighted
                ? AppColors.said.withValues(alpha: 0.25)
                : AppColors.blue.withValues(alpha: 0.12),
            shape: BoxShape.circle,
          ),
          child: Semantics(
            label: switch (widget.mood) {
              SenpaiMood.neutral => strings.senpaiWaiting,
              SenpaiMood.listening => strings.senpaiListening,
              SenpaiMood.delighted => strings.senpaiDelighted,
              SenpaiMood.puzzled => strings.senpaiPuzzled,
            },
            child: Transform.translate(
              offset: Offset(0, dy),
              child: Transform.rotate(
                angle: tilt,
                child: Transform.scale(
                  scale: scale,
                  // The face always moves; isolate it from sibling repaints.
                  child: RepaintBoundary(
                    child: CustomPaint(
                      painter: _FacePainter(
                        mood: widget.mood,
                        phase: phase,
                        moodT: moodT,
                        eyeOpenness: _eyeOpenness(phase),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  /// Blink: closes once near the end of the cycle. Built from the
  /// breathing phase, so it needs no extra timer.
  double _eyeOpenness(double phase) {
    const double start = 0.90;
    const double end = 0.96;
    if (phase < start || phase > end) return 1;
    return 1 - math.sin((phase - start) / (end - start) * math.pi);
  }
}

class _FacePainter extends CustomPainter {
  const _FacePainter({
    required this.mood,
    required this.phase,
    required this.moodT,
    required this.eyeOpenness,
  });

  final SenpaiMood mood;
  final double phase;
  final double moodT;
  final double eyeOpenness;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint stroke = Paint()
      ..color = AppColors.ink
      ..strokeWidth = size.width * 0.045
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    final double eyeY = size.height * 0.42;
    final double eyeDx = size.width * 0.19;
    final double eyeRadius = size.width * 0.045;

    if (mood == SenpaiMood.delighted) {
      // ^ ^ eyes. Delight shows in both the color and the eye shape.
      for (final double sign in <double>[-1, 1]) {
        final Path path = Path()
          ..moveTo(size.width / 2 + sign * eyeDx - eyeRadius * 1.6, eyeY + eyeRadius)
          ..lineTo(size.width / 2 + sign * eyeDx, eyeY - eyeRadius)
          ..lineTo(size.width / 2 + sign * eyeDx + eyeRadius * 1.6, eyeY + eyeRadius);
        canvas.drawPath(path, stroke);
      }
      _paintSparkles(canvas, size);
    } else {
      final Paint fill = Paint()..color = AppColors.ink;
      final double radius = eyeRadius * (mood == SenpaiMood.listening ? 1.15 : 1.0);

      for (final double sign in <double>[-1, 1]) {
        final Offset center = Offset(size.width / 2 + sign * eyeDx, eyeY);
        if (eyeOpenness > 0.15) {
          // Lids drop from above; squashing the circle reads as closed.
          canvas.drawOval(
            Rect.fromCenter(center: center, width: radius * 2, height: radius * 2 * eyeOpenness),
            fill,
          );
        } else {
          canvas.drawLine(
            Offset(center.dx - radius, center.dy),
            Offset(center.dx + radius, center.dy),
            stroke,
          );
        }
      }
    }

    // Mouth. Corners never turn down, even when puzzled — no blame.
    // Only delight adds a slight wobble, off the breathing phase, so the
    // frame never sits perfectly still.
    final double mouthY = size.height * 0.63;
    final double smile = mood == SenpaiMood.delighted
        ? 0.16 * (1 + 0.10 * math.sin(phase * 2 * math.pi))
        : 0.08;
    final Rect mouth = Rect.fromCenter(
      center: Offset(size.width / 2, mouthY),
      width: size.width * 0.26,
      height: size.height * smile,
    );
    canvas.drawArc(mouth, 0.15, 2.85, false, stroke);

    if (mood == SenpaiMood.puzzled) _paintSweat(canvas, size);
  }

  /// A bead of sweat, not a "?" — a question mark reads as interrogation.
  /// It marks our failure, not the student's; see [SenpaiMood.puzzled].
  void _paintSweat(Canvas canvas, Size size) {
    final double drip = (phase * 2) % 1;
    final Offset center = Offset(size.width * 0.78, size.height * (0.30 + 0.12 * drip));
    canvas.drawCircle(
      center,
      size.width * 0.035,
      Paint()..color = AppColors.blue.withValues(alpha: 0.6 * (1 - drip)),
    );
  }

  /// Sparkles on delight. Positions are fixed rather than random, so
  /// goldens stay stable.
  void _paintSparkles(Canvas canvas, Size size) {
    const List<Offset> spots = <Offset>[
      Offset(0.12, 0.20),
      Offset(0.88, 0.16),
      Offset(0.94, 0.62),
      Offset(0.06, 0.60),
    ];

    final Paint paint = Paint()..color = AppColors.streak.withValues(alpha: 0.9 * moodT);
    // They stay lit rather than flashing; only the size breathes.
    final double twinkle = 1 + 0.15 * math.sin(phase * 2 * math.pi);

    for (int i = 0; i < spots.length; i++) {
      final Offset spot = spots[i];
      final double radius = size.width * (i.isEven ? 0.045 : 0.033) * moodT * twinkle;
      final Offset center = Offset(spot.dx * size.width, spot.dy * size.height);

      // Four-pointed star — reads more like a sparkle than a circle.
      final Path path = Path()
        ..moveTo(center.dx, center.dy - radius)
        ..quadraticBezierTo(center.dx, center.dy, center.dx + radius, center.dy)
        ..quadraticBezierTo(center.dx, center.dy, center.dx, center.dy + radius)
        ..quadraticBezierTo(center.dx, center.dy, center.dx - radius, center.dy)
        ..quadraticBezierTo(center.dx, center.dy, center.dx, center.dy - radius)
        ..close();
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(_FacePainter oldDelegate) =>
      oldDelegate.mood != mood ||
      oldDelegate.phase != phase ||
      oldDelegate.moodT != moodT ||
      oldDelegate.eyeOpenness != eyeOpenness;
}
