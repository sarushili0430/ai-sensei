import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';

import '../theme/tokens.dart';

/// App mark: senpai's face is itself a speech bubble.
///
/// A face alone would be indistinguishable from every other blue round icon, so
/// the outline grows a bubble tail, putting the product's one-liner — it asks
/// you things — into the silhouette. The expression is `delighted` (^ ^): the
/// face of an explanation landing is this app's reward, so the sign matches it.
///
/// This code is the only source for the icon artwork.
/// `tool/generate_brand_assets.dart` exports the iOS/Android pngs from it, so
/// never redraw the image files by hand — that would mean maintaining the
/// in-app face twice.
abstract final class AppMark {
  /// Face centre as a fraction of the canvas, nudged up to fit the tail.
  static const Offset _center = Offset(0.5, 0.475);
  static const double _radius = 0.315;

  /// Tail base (radians) and tip. Short and thick — a wide base and a modest
  /// tip keep it from looking broken at small sizes.
  static const double _tailFrom = 0.60 * math.pi;
  static const double _tailTo = 0.88 * math.pi;
  static const Offset _tailTip = Offset(0.255, 0.835);

  /// Draws into a `size` square, origin top left.
  ///
  /// [contentScale] shrinks the artwork while keeping it centred. Android's
  /// adaptive icon shows only the middle 72dp of 108dp, so the foreground layer
  /// is scaled to 0.667 here to stay inside the safe area.
  static void paint(
    Canvas canvas,
    double size, {
    AppMarkSkin skin = AppMarkSkin.standard,
    double contentScale = 1,
  }) {
    final Color? background = skin.background;
    if (background != null) {
      canvas.drawRect(Rect.fromLTWH(0, 0, size, size), Paint()..color = background);
    }

    if (contentScale != 1) {
      canvas.save();
      canvas.translate(size / 2, size / 2);
      canvas.scale(contentScale);
      canvas.translate(-size / 2, -size / 2);
    }

    if (skin.punchOutFeatures) {
      // For Android's monochrome layer and iOS tinting. Only one fill color is
      // available, so eyes and mouth are punched out rather than recolored.
      canvas.saveLayer(Rect.fromLTWH(0, 0, size, size), Paint());
      _paintBubble(canvas, size, skin.face);
      _paintFeatures(canvas, size, Paint()..blendMode = BlendMode.clear);
      canvas.restore();
    } else {
      _paintBubble(canvas, size, skin.face);
      final Color? cheek = skin.cheek;
      if (cheek != null) {
        // Between the eye arcs' bottom (0.486) and the mouth (0.515+); any
        // tighter and it cuts into the eyes.
        for (final double sign in <double>[-1, 1]) {
          canvas.drawCircle(
            Offset(size * (0.5 + sign * 0.205), size * 0.535),
            size * 0.042,
            Paint()..color = cheek,
          );
        }
      }
      _paintFeatures(canvas, size, Paint()..color = skin.feature);
    }

    if (contentScale != 1) {
      canvas.restore();
    }
  }

  /// Merges the face circle and tail into one outline. Drawn separately, the
  /// seam shows as a line under semi-transparent (tinted) skins.
  static void _paintBubble(Canvas canvas, double size, Color color) {
    final Offset center = Offset(_center.dx * size, _center.dy * size);
    final double r = _radius * size;

    final Path tail = Path()
      ..moveTo(center.dx + r * math.cos(_tailFrom), center.dy + r * math.sin(_tailFrom))
      ..lineTo(_tailTip.dx * size, _tailTip.dy * size)
      ..lineTo(center.dx + r * math.cos(_tailTo), center.dy + r * math.sin(_tailTo))
      ..close();
    final Path circle = Path()..addOval(Rect.fromCircle(center: center, radius: r));

    canvas.drawPath(Path.combine(PathOperation.union, circle, tail), Paint()..color = color);
  }

  /// Eyes (^ ^) and mouth, using `base`'s blendMode and color as given.
  static void _paintFeatures(Canvas canvas, double size, Paint base) {
    final Paint stroke = Paint()
      ..color = base.color
      ..blendMode = base.blendMode
      ..strokeWidth = size * 0.052
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    for (final double sign in <double>[-1, 1]) {
      final double cx = size * (0.5 + sign * 0.125);
      final double cy = size * 0.425;
      canvas.drawPath(
        Path()
          ..moveTo(cx - size * 0.075, cy + size * 0.035)
          ..quadraticBezierTo(cx, cy - size * 0.055, cx + size * 0.075, cy + size * 0.035),
        stroke,
      );
    }

    canvas.drawArc(
      Rect.fromCenter(
        center: Offset(size * 0.5, size * 0.565),
        width: size * 0.17,
        height: size * 0.10,
      ),
      0.15,
      2.85,
      false,
      stroke,
    );
  }

  /// Produces png bytes [size] on a side; used by the generator tool.
  static Future<ui.Image> rasterize(
    int size, {
    AppMarkSkin skin = AppMarkSkin.standard,
    double contentScale = 1,
  }) async {
    final ui.PictureRecorder recorder = ui.PictureRecorder();
    paint(Canvas(recorder), size.toDouble(), skin: skin, contentScale: contentScale);
    return recorder.endRecording().toImage(size, size);
  }
}

/// The mark's palette. Per-platform rendering differences are absorbed here only.
@immutable
class AppMarkSkin {
  const AppMarkSkin({
    required this.face,
    required this.feature,
    this.background,
    this.cheek,
    this.punchOutFeatures = false,
  });

  /// Background; null means transparent (iOS dark/tint, Android foreground).
  final Color? background;
  final Color face;
  final Color feature;
  final Color? cheek;

  /// Whether to punch the features out instead of filling them; for
  /// single-color layers.
  final bool punchOutFeatures;

  /// Standard: a cream bubble on solid blue.
  static const AppMarkSkin standard = AppMarkSkin(
    background: AppColors.blue,
    face: Color(0xFFFBFAF7),
    feature: AppColors.ink,
    cheek: Color(0xFFFFC0D4),
  );

  /// iOS 18 dark. The system paints the background, so this stays transparent;
  /// the pale pink cheeks muddy on a dark ground and are dropped.
  static const AppMarkSkin dark = AppMarkSkin(
    face: Color(0xFFF2F6F8),
    feature: AppColors.ink,
  );

  /// iOS 18 tinted: greyscale, since the system derives color from luminance,
  /// and transparent behind.
  static const AppMarkSkin tinted = AppMarkSkin(
    face: Color(0xFFFFFFFF),
    feature: Color(0xFF000000),
    punchOutFeatures: true,
  );

  /// Android adaptive icon foreground; the background comes from a color
  /// resource.
  static const AppMarkSkin adaptiveForeground = AppMarkSkin(
    face: Color(0xFFFBFAF7),
    feature: AppColors.ink,
    cheek: Color(0xFFFFC0D4),
  );

  /// Android 13+ themed icon; only the alpha channel is used.
  static const AppMarkSkin monochrome = AppMarkSkin(
    face: Color(0xFFFFFFFF),
    feature: Color(0xFF000000),
    punchOutFeatures: true,
  );
}

/// For showing the mark in-app (splash, onboarding headings and the like).
class AppMarkView extends StatelessWidget {
  const AppMarkView({this.size = 96, this.skin = AppMarkSkin.standard, super.key});

  final double size;
  final AppMarkSkin skin;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _AppMarkPainter(skin)),
    );
  }
}

class _AppMarkPainter extends CustomPainter {
  const _AppMarkPainter(this.skin);

  final AppMarkSkin skin;

  @override
  void paint(Canvas canvas, Size size) =>
      AppMark.paint(canvas, size.shortestSide, skin: skin);

  @override
  bool shouldRepaint(_AppMarkPainter oldDelegate) => oldDelegate.skin != skin;
}
