import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';

import '../theme/tokens.dart';

/// アプリマーク —— **後輩の顔そのものが吹き出し**になっている。
///
/// アイコンに「顔」だけを置くと世の中の青い丸顔と見分けがつかないので、
/// 輪郭に吹き出しのしっぽを足して「**きいてくる**」という
/// プロダクトの一行(README冒頭)をシルエットに入れている。
/// 表情は `delighted`(^ ^)。説明が伝わった顔がこのアプリの報酬なので、
/// 看板と報酬を一致させる(handoff §7「最大の報酬はキャラの表情」)。
///
/// **アイコンの絵はここが唯一の正**。iOS/Androidのpngは
/// `tool/generate_brand_assets.dart` がこのコードから書き出すので、
/// 画像ファイルを直接描き直さないこと(アプリ内の顔と二重管理になる)。
abstract final class AppMark {
  /// 顔の中心(キャンバスに対する比)。しっぽの分だけ上に寄せている。
  static const Offset _center = Offset(0.5, 0.475);
  static const double _radius = 0.315;

  /// しっぽの付け根(ラジアン)と先端。短く太く —— 小さいサイズで
  /// 折れて見えないように、付け根を広く取って先端を伸ばしすぎない。
  static const double _tailFrom = 0.60 * math.pi;
  static const double _tailTo = 0.88 * math.pi;
  static const Offset _tailTip = Offset(0.255, 0.835);

  /// `size` 四方に描く。原点は左上。
  ///
  /// [contentScale] は中心を保ったまま絵柄だけを縮める。Androidの
  /// アダプティブアイコンは108dpのうち中央72dpしか見えないので、
  /// 前景レイヤをここで 0.667 に縮めて安全域に収める。
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
      // Androidのモノクロレイヤ / iOSのティント用。塗りは1色しか使えないので、
      // 目と口は「色を変える」のではなく**くり抜いて**表情を出す。
      canvas.saveLayer(Rect.fromLTWH(0, 0, size, size), Paint());
      _paintBubble(canvas, size, skin.face);
      _paintFeatures(canvas, size, Paint()..blendMode = BlendMode.clear);
      canvas.restore();
    } else {
      _paintBubble(canvas, size, skin.face);
      final Color? cheek = skin.cheek;
      if (cheek != null) {
        // 目の弧の下端(0.486)と口(0.515〜)のあいだ。詰めると目に食い込む。
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

  /// 顔の円としっぽを1つの輪郭に合成する。別々に描くと、
  /// 半透明のスキン(ティント)で継ぎ目が線になって出る。
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

  /// 目(^ ^)と口。`base` の blendMode / color をそのまま使う。
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

  /// 1辺 [size] のpngバイト列を作る。生成ツールから使う。
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

/// マークの配色。プラットフォームごとの見え方の違いはここだけで吸収する。
@immutable
class AppMarkSkin {
  const AppMarkSkin({
    required this.face,
    required this.feature,
    this.background,
    this.cheek,
    this.punchOutFeatures = false,
  });

  /// 背景。null で透過(iOSのダーク/ティント、Androidの前景レイヤ)。
  final Color? background;
  final Color face;
  final Color feature;
  final Color? cheek;

  /// 表情を塗りではなく「くり抜き」で出すか。単色レイヤ用。
  final bool punchOutFeatures;

  /// 通常。青ベタにクリームの吹き出し。
  static const AppMarkSkin standard = AppMarkSkin(
    background: AppColors.blue,
    face: Color(0xFFFBFAF7),
    feature: AppColors.ink,
    cheek: Color(0xFFFFC0D4),
  );

  /// iOS 18 のダーク。背景は**システムが敷く**ので透過にする。
  /// 暗い下地の上ではほおの淡いピンクが濁るので落とす。
  static const AppMarkSkin dark = AppMarkSkin(
    face: Color(0xFFF2F6F8),
    feature: AppColors.ink,
  );

  /// iOS 18 のティント。輝度からシステムが色を作るのでグレースケール、
  /// かつ背景は透過。
  static const AppMarkSkin tinted = AppMarkSkin(
    face: Color(0xFFFFFFFF),
    feature: Color(0xFF000000),
    punchOutFeatures: true,
  );

  /// Android のアダプティブアイコン前景。背景は色リソース側で敷く。
  static const AppMarkSkin adaptiveForeground = AppMarkSkin(
    face: Color(0xFFFBFAF7),
    feature: AppColors.ink,
    cheek: Color(0xFFFFC0D4),
  );

  /// Android 13+ のテーマアイコン。アルファだけが使われる。
  static const AppMarkSkin monochrome = AppMarkSkin(
    face: Color(0xFFFFFFFF),
    feature: Color(0xFF000000),
    punchOutFeatures: true,
  );
}

/// アプリ内でマークを出したいとき用(スプラッシュ・オンボーディングの見出しなど)。
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
