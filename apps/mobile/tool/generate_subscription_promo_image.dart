/// サブスクリプションの**プロモーション画像**(1024x1024)を書き出す。
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_subscription_promo_image.dart
/// ```
///
/// 出力: `docs/store/review/subscription-promo-1024.png`
///
/// App Store Connect の サブスクリプション > 「画像(任意)」に入れるもの。
/// 再獲得オファー・オファーコードの引き換え画面と、App Storeプロモーションを
/// 有効にしたときのプロダクトページに出る。3プラン(週/月/年)とも同じ
/// Premium なので、**1枚を3商品に使い回す**。
///
/// 絵は `lib/src/brand/app_mark.dart` が正。アイコンと同じ顔を使い、
/// 「Premium」の一語だけを足して、どの商品の画像かが分かるようにしている。
/// 価格・割引率・「今すぐ登録」のような行動喚起は**入れない**
/// (プロモーション画像に入れると審査で外させられる)。
///
/// アイコンと同じく透過は不可なので、アルファを畳んで書き出す。
library;

import 'dart:ui' as ui;

import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/support/harness.dart';
import 'support/rgb_png.dart';

const String _out = '../../docs/store/review/subscription-promo-1024.png';

/// App Store Connect の指定サイズ。ここ以外は受け付けない。
const int _size = 1024;

/// 顔の大きさ(キャンバス比)。下に「Premium」を置くぶんアイコンより小さい。
const double _markScale = 0.78;

/// 顔の中心をどこに置くか(キャンバス比)。[AppMark] は自分の
/// キャンバスの 0.475 に顔の中心を取るので、そのぶんを引いて平行移動する。
const double _markCenterY = 0.40;

/// 「Premium」の行の中心(キャンバス比)。
const double _labelCenterY = 0.80;
const double _labelSize = 0.115;

void main() {
  testWidgets('サブスクリプションのプロモーション画像', (WidgetTester tester) async {
    await loadAppFonts();

    await tester.runAsync(() async {
      await writeOpaquePng(_out, await _render());
    });
  });
}

Future<ui.Image> _render() async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  const double s = _size * 1.0;

  canvas.drawRect(
    const Rect.fromLTWH(0, 0, s, s),
    Paint()..color = AppColors.blue,
  );

  // 地色は上で敷いたので、背景を持たないスキンで顔だけを描く。
  const double mark = s * _markScale;
  canvas.save();
  canvas.translate((s - mark) / 2, s * _markCenterY - mark * 0.475);
  AppMark.paint(canvas, mark, skin: AppMarkSkin.adaptiveForeground);
  canvas.restore();

  final TextPainter label = TextPainter(
    text: const TextSpan(
      text: 'Premium',
      style: TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w700,
        fontSize: s * _labelSize,
        height: 1.2,
        letterSpacing: s * 0.004,
        // 顔と同じクリーム。白にすると顔より前に出てしまう。
        color: Color(0xFFFBFAF7),
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();

  label.paint(
    canvas,
    Offset((s - label.width) / 2, s * _labelCenterY - label.height / 2),
  );

  return recorder.endRecording().toImage(_size, _size);
}
