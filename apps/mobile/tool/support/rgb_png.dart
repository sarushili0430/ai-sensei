/// アルファチャンネルを持たないPNG(カラータイプ2 = truecolor)を書き出す。
///
/// App Store は 1024x1024 の画像に透過を許さない(ITMS-90717)。中身が
/// 完全に不透明でも、**アルファチャンネルが在るだけで**弾かれることがある。
/// `ui.Image.toByteData(format: png)` は必ずRGBAで吐くので、ここで畳む。
///
/// `image` パッケージを足さないのは、生成物をコミットする都合上、
/// 生成ツールが依存を1つも増やさずに動くほうが安全なため。
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

/// [image] をアルファ抜きのPNGとして [path] に書く。
Future<void> writeOpaquePng(String path, ui.Image image) async {
  final ByteData data = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  final File file = File(path);
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(
    encodeRgbPng(data.buffer.asUint8List(), image.width, image.height),
    flush: true,
  );
}

Uint8List encodeRgbPng(Uint8List rgba, int width, int height) {
  final BytesBuilder raw = BytesBuilder(copy: false);
  for (int y = 0; y < height; y++) {
    raw.addByte(0); // フィルタ: なし
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
  ihdr[9] = 2; // color type: truecolor(アルファなし)
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
