/// Exports the app icon from `lib/src/brand/app_mark.dart`.
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_app_icon.dart
/// ```
///
/// Never redraw the image files by hand: the code is the source of the artwork,
/// and this only distributes it in the shapes each platform requires.
///
/// It uses Flutter's rasterizer, so it runs through `flutter test` (`dart run`
/// has no Canvas). The output is committed.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

const String _ios = 'ios/Runner/Assets.xcassets/AppIcon.appiconset';
const String _android = 'android/app/src/main/res';

/// The image for Play Console's "store listing > app icon". It is the store
/// page's artwork rather than the icon installed on a device, so it lives under
/// `docs/store/` alongside the screenshots.
const String _playStore = '../../docs/store/icon';

/// How much of Android's 108dp adaptive icon canvas the artwork occupies. The
/// middle 72dp (0.667) is the guaranteed-visible area, so the outline fits there.
const double _adaptiveContentScale = 0.80;

/// The legacy launcher icon (API 25 and below), baked with rounded corners.
const double _legacyCornerRadius = 0.20;

void main() {
  test('generate app icon', () async {
    TestWidgetsFlutterBinding.ensureInitialized();

    // --- iOS ---
    // The single-size format from Xcode 14 on: only 1024 is needed and the rest
    // is generated at build time. Dark and tinted variants exist only here.
    await _writeOpaquePng(
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

    // The old per-size pngs are unreferenced in the single-size format, and
    // leaving them keeps stale artwork in the repo, so they are removed.
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
    // Adaptive foreground and monochrome are based on 108dp.
    const Map<String, int> adaptiveDp = <String, int>{
      'mdpi': 108,
      'hdpi': 162,
      'xhdpi': 216,
      'xxhdpi': 324,
      'xxxhdpi': 432,
    };
    // Android's notification small icon is based on 24dp. It ships as
    // `ic_stat_onesignal_default`, which OneSignal looks for by default, at a
    // different size from the launcher icon.
    const Map<String, int> notificationDp = <String, int>{
      'mdpi': 24,
      'hdpi': 36,
      'xhdpi': 48,
      'xxhdpi': 72,
      'xxxhdpi': 96,
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

    for (final MapEntry<String, int> entry in notificationDp.entries) {
      final String dir = '$_android/drawable-${entry.key}';
      Directory(dir).createSync(recursive: true);
      await _writePng(
        '$dir/ic_stat_onesignal_default.png',
        await AppMark.rasterize(entry.value, skin: AppMarkSkin.monochrome),
      );
    }

    Directory('$_android/mipmap-anydpi-v26').createSync(recursive: true);
    for (final String name in <String>['ic_launcher', 'ic_launcher_round']) {
      File('$_android/mipmap-anydpi-v26/$name.xml').writeAsStringSync(_adaptiveIconXml);
    }
    File('$_android/values/ic_launcher_background.xml').writeAsStringSync(
      _backgroundColorXml(AppColors.blue),
    );
    File('$_android/values/onesignal_notification.xml').writeAsStringSync(
      _notificationAccentColorXml(AppColors.blue),
    );

    // --- Play Console store listing icon ---
    // 512x512, 32-bit PNG, under 1MB. Google adds the rounded corners and drop
    // shadow, so it is handed over square with corners intact (as with iOS's
    // 1024). Alpha is allowed, so transparency need not be stripped.
    Directory(_playStore).createSync(recursive: true);
    await _writePng('$_playStore/play-store-512.png', await AppMark.rasterize(512));
  });
}

/// Bakes in rounded corners for the legacy launcher; some devices apply no mask.
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

/// Writes with the alpha channel stripped entirely.
///
/// The App Store forbids transparency on the 1024 icon (ITMS-90717), and even
/// fully opaque content can be rejected merely for having an alpha channel.
Future<void> _writeOpaquePng(String path, ui.Image image) async {
  final ByteData data = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  File(path).writeAsBytesSync(
    _encodeRgbPng(data.buffer.asUint8List(), image.width, image.height),
    flush: true,
  );
}

// --- Minimal PNG encoder (color type 2 = RGB, no alpha) ---
//
// The `image` package is not added: since the output is committed, it is safer
// for this tool to run without adding a single dependency.

Uint8List _encodeRgbPng(Uint8List rgba, int width, int height) {
  final BytesBuilder raw = BytesBuilder(copy: false);
  for (int y = 0; y < height; y++) {
    raw.addByte(0); // filter: none
    for (int x = 0; x < width; x++) {
      final int i = (y * width + x) * 4;
      raw.add(<int>[rgba[i], rgba[i + 1], rgba[i + 2]]);
    }
  }

  final BytesBuilder out = BytesBuilder(copy: false)
    ..add(<int>[137, 80, 78, 71, 13, 10, 26, 10]);

  final Uint8List ihdr = Uint8List(13);
  ByteData.view(ihdr.buffer)
    ..setUint32(0, width)
    ..setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (no alpha)
  out.add(_chunk('IHDR', ihdr));
  out.add(_chunk('IDAT', Uint8List.fromList(ZLibCodec(level: 9).encode(raw.takeBytes()))));
  out.add(_chunk('IEND', Uint8List(0)));
  return out.takeBytes();
}

Uint8List _chunk(String type, Uint8List data) {
  final Uint8List typeBytes = Uint8List.fromList(ascii.encode(type));
  final BytesBuilder body = BytesBuilder(copy: false)
    ..add(typeBytes)
    ..add(data);
  final Uint8List payload = body.takeBytes();

  final BytesBuilder out = BytesBuilder(copy: false);
  final Uint8List length = Uint8List(4);
  ByteData.view(length.buffer).setUint32(0, data.length);
  out.add(length);
  out.add(payload);
  final Uint8List crc = Uint8List(4);
  ByteData.view(crc.buffer).setUint32(0, _crc32(payload));
  out.add(crc);
  return out.takeBytes();
}

final List<int> _crcTable = List<int>.generate(256, (int n) {
  int c = n;
  for (int k = 0; k < 8; k++) {
    c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
  }
  return c;
});

int _crc32(Uint8List bytes) {
  int c = 0xFFFFFFFF;
  for (final int byte in bytes) {
    c = _crcTable[(c ^ byte) & 0xFF] ^ (c >> 8);
  }
  return (c ^ 0xFFFFFFFF) & 0xFFFFFFFF;
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

String _notificationAccentColorXml(Color color) {
  final String argb = color.toARGB32().toRadixString(16).padLeft(8, '0');
  return '''
<?xml version="1.0" encoding="utf-8"?>
<!-- tool/generate_app_icon.dart が生成する。手で編集しない。 -->
<resources>
    <string name="onesignal_notification_accent_color">${argb.toUpperCase()}</string>
</resources>
''';
}
