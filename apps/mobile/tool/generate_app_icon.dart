/// アプリアイコンを `lib/src/brand/app_mark.dart` から書き出す。
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_app_icon.dart
/// ```
///
/// 画像ファイルを直接描き直さないこと。**絵の正はコード側**で、
/// ここはそれをプラットフォームの要求する形に配るだけ。
///
/// Flutterのラスタライザを使うので、実行は `flutter test` 経由になる
/// (`dart run` にはCanvasが無い)。生成物はコミットする。
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rgb_png.dart';

const String _ios = 'ios/Runner/Assets.xcassets/AppIcon.appiconset';
const String _android = 'android/app/src/main/res';

/// Androidのアダプティブアイコンで、絵柄を108dpキャンバスのどれだけに収めるか。
/// 中央72dp(=0.667)が可視保証なので、輪郭がそこに入る値にする。
const double _adaptiveContentScale = 0.80;

/// legacy(API 25以下)のランチャーアイコン。角丸で焼き込む。
const double _legacyCornerRadius = 0.20;

void main() {
  test('generate app icon', () async {
    TestWidgetsFlutterBinding.ensureInitialized();

    // --- iOS ---
    // Xcode 14以降の単一サイズ形式。1024だけ置けば残りはビルド時に作られる。
    // ダーク/ティントはこの形式でしか指定できない。
    await writeOpaquePng(
      '$_ios/Icon-App-1024x1024@1x.png',
      await AppMark.rasterize(1024),
    );
    await _writePng(
      '$_ios/Icon-App-1024x1024@1x-dark.png',
      await AppMark.rasterize(1024, skin: AppMarkSkin.dark),
    );
    await _writePng(
      '$_ios/Icon-App-1024x1024@1x-tinted.png',
      await AppMark.rasterize(1024, skin: AppMarkSkin.tinted),
    );

    // 旧形式のサイズ別pngは単一サイズ形式では参照されない。残すと
    // 「古い絵のまま」のファイルがリポジトリに居座るので消す。
    for (final FileSystemEntity entity in Directory(_ios).listSync()) {
      final String name = entity.path.split('/').last;
      if (entity is File && name.startsWith('Icon-App-') && !name.startsWith('Icon-App-1024')) {
        entity.deleteSync();
      }
    }
    File('$_ios/Contents.json').writeAsStringSync(_iosContentsJson);

    // --- Android ---
    const Map<String, int> legacyDp = <String, int>{
      'mdpi': 48,
      'hdpi': 72,
      'xhdpi': 96,
      'xxhdpi': 144,
      'xxxhdpi': 192,
    };
    // アダプティブの前景・モノクロは108dp基準。
    const Map<String, int> adaptiveDp = <String, int>{
      'mdpi': 108,
      'hdpi': 162,
      'xhdpi': 216,
      'xxhdpi': 324,
      'xxxhdpi': 432,
    };

    for (final MapEntry<String, int> entry in legacyDp.entries) {
      final String dir = '$_android/mipmap-${entry.key}';
      Directory(dir).createSync(recursive: true);
      await _writePng(
        '$dir/ic_launcher.png',
        await _rasterizeClipped(entry.value, radius: _legacyCornerRadius),
      );
      await _writePng(
        '$dir/ic_launcher_round.png',
        await _rasterizeClipped(entry.value, radius: 0.5),
      );
    }

    for (final MapEntry<String, int> entry in adaptiveDp.entries) {
      final String dir = '$_android/mipmap-${entry.key}';
      await _writePng(
        '$dir/ic_launcher_foreground.png',
        await AppMark.rasterize(
          entry.value,
          skin: AppMarkSkin.adaptiveForeground,
          contentScale: _adaptiveContentScale,
        ),
      );
      await _writePng(
        '$dir/ic_launcher_monochrome.png',
        await AppMark.rasterize(
          entry.value,
          skin: AppMarkSkin.monochrome,
          contentScale: _adaptiveContentScale,
        ),
      );
    }

    Directory('$_android/mipmap-anydpi-v26').createSync(recursive: true);
    for (final String name in <String>['ic_launcher', 'ic_launcher_round']) {
      File('$_android/mipmap-anydpi-v26/$name.xml').writeAsStringSync(_adaptiveIconXml);
    }
    File('$_android/values/ic_launcher_background.xml').writeAsStringSync(
      _backgroundColorXml(AppColors.blue),
    );
  });
}

/// 角を落として焼き込む(legacyランチャー用。マスクが掛からない端末がある)。
Future<ui.Image> _rasterizeClipped(int size, {required double radius}) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double s = size.toDouble();
  canvas.clipRRect(
    RRect.fromRectAndRadius(Rect.fromLTWH(0, 0, s, s), Radius.circular(s * radius)),
  );
  AppMark.paint(canvas, s);
  return recorder.endRecording().toImage(size, size);
}

Future<void> _writePng(String path, ui.Image image) async {
  final ByteData data = (await image.toByteData(format: ui.ImageByteFormat.png))!;
  File(path).writeAsBytesSync(data.buffer.asUint8List(), flush: true);
}

const String _iosContentsJson = '''
{
  "images" : [
    {
      "filename" : "Icon-App-1024x1024@1x.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "Icon-App-1024x1024@1x-dark.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "tinted"
        }
      ],
      "filename" : "Icon-App-1024x1024@1x-tinted.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
''';

const String _adaptiveIconXml = '''
<?xml version="1.0" encoding="utf-8"?>
<!-- tool/generate_app_icon.dart が生成する。手で編集しない。 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
''';

String _backgroundColorXml(Color color) {
  final String hex = (color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0');
  return '''
<?xml version="1.0" encoding="utf-8"?>
<!-- tool/generate_app_icon.dart が生成する。手で編集しない。 -->
<resources>
    <color name="ic_launcher_background">#${hex.toUpperCase()}</color>
</resources>
''';
}
