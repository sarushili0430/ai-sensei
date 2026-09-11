/// ストア掲載用のスクリーンショットを**実画面から**書き出す。
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_store_screenshots.dart
/// ```
///
/// 手描きのモックを出さないのは、App Review が「スクリーンショットは
/// 実際のアプリを表していること」を要求するため(Guideline 2.3.3)。
/// golden test と同じ仕組みで本物のWidgetツリーを描いている。
///
/// 出力(`docs/store/screenshots/`):
///   plain/     1179x2556 端末フレームなしの素のまま。Shipaton提出用の指定サイズ
///   captioned/ 1290x2796 App Store Connect の 6.9インチ必須サイズ。見出し付き
///   captioned-65/ 1284x2778 App Store Connect の 6.5インチ。見出し付き(428pt幅で描画)
///   ipad-13/   2064x2752 App Store Connect の iPad 13インチ必須サイズ。見出し付き(1032pt幅で描画)
///   play/      1080x1920 Google Play の「スマートフォン」。見出し付き
///   play-tablet-7/  1200x1920 Google Play の「7インチ タブレット」(600dp幅で描画)
///   play-tablet-10/ 1600x2560 Google Play の「10インチ タブレット」(800dp幅で描画)
///
/// **Play に captioned を流用しないこと。** Play は縦横比を 16:9〜9:16 に
/// 制限していて、1290x2796(1:2.17)は 9:16(1:1.78)より縦長なので弾かれる。
///
/// あわせてフィーチャーグラフィック(`docs/store/feature-graphic/`・1024x500)も
/// ここで描く。Playでは**必須**で、これが無いと公開できない。
///
/// Devpost(Shipaton)の Thumbnail(`docs/store/devpost/`・1200x800)も同じ場所で描く。
/// 画像を手で作らないのはストア素材と同じ理由で、**絵の正はコード**にしておくため
/// (`docs/shipaton_submission.md` §1)。
///
/// 並び順は inception-deck §3。①授業(板書)②祝福 ③復習問題 ④連続日数 ⑤復習。
/// **デッキ §3 と同期していること。**片方だけ直すと、ストア素材と正文がずれる。
library;

import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
// `SessionLimits` は karte / session の両方に別々の定義がある。ここで要るのは
// `SessionStart` が持つ session 側なので、karte 側を隠す。
import 'package:ai_sensei/src/features/karte/domain/karte.dart'
    hide SessionLimits;
import 'package:ai_sensei/src/features/session/application/board_inbox.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/support/harness.dart';

const String _outDir = '../../docs/store/screenshots';
const String _featureDir = '../../docs/store/feature-graphic';
const String _devpostDir = '../../docs/store/devpost';

/// 素のスクショ。iPhone 15 Pro の論理サイズ。×3で 1179x2556 になる。
const Size _plainLogical = Size(393, 852);

/// フィーチャーグラフィック。Playが指定する唯一のサイズ。
const Size _featurePixels = Size(1024, 500);

/// Devpost の Thumbnail。推奨の 3:2。
const Size _thumbPixels = Size(1200, 800);

const double _pixelRatio = 3;

/// 見出しつきで書き出す枠。**中の画面はこの `logical` で本当に描く**ので、
/// タブレットの絵はタブレット幅のレイアウトになる(実機と違う絵を出さない)。
@immutable
class _Frame {
  const _Frame({
    required this.dir,
    required this.logical,
    required this.pixels,
    required this.topRatio,
  });

  /// `docs/store/screenshots/{locale}/` の下のディレクトリ名。
  final String dir;
  final Size logical;
  final Size pixels;

  /// 見出しの下に空ける量(地の高さに対する比)。地が横長になるほど詰める。
  final double topRatio;
}

/// 縦長すぎる地は見出しと端末画像が離れるので `topRatio` で吸収する。
const List<_Frame> _frames = <_Frame>[
  // App Store Connect の 6.9インチ必須サイズ。
  _Frame(
    dir: 'captioned',
    logical: Size(430, 932),
    pixels: Size(1290, 2796),
    topRatio: 0.185,
  ),
  // App Store Connect の 6.5インチ(1284x2778 か 1242x2688)。6.9インチを入れて
  // いれば任意だが、**6.5インチのタブに 1290x2796 を落とすと寸法エラー**になる
  // ("Screenshots dimensions should be: 1242 × 2688px, ... 1284 × 2778px")ので、
  // 専用の枚を持つ。論理 428x926 = iPhone 14 Pro Max の点数。×3 でちょうど。
  _Frame(
    dir: 'captioned-65',
    logical: Size(428, 926),
    pixels: Size(1284, 2778),
    topRatio: 0.185,
  ),
  // App Store Connect の iPad 13インチ必須サイズ(iPad Pro 13" M4。12.9インチの
  // 2048x2732 でも通るが、ASC が最初に求めるのはこちら)。アプリは iPad にも
  // 入る(TARGETED_DEVICE_FAMILY = 1,2)ので、この枠が無いと提出できない。
  // 論理 1032x1376 = ちょうど @2x。タブレット幅のレイアウトで本当に描く
  // (play-tablet-10 と同じ理由。iPhone の絵を引き伸ばさない)。
  _Frame(
    dir: 'ipad-13',
    logical: Size(1032, 1376),
    pixels: Size(2064, 2752),
    topRatio: 0.135,
  ),
  // Google Play「スマートフォン」。9:16 ちょうど。
  _Frame(
    dir: 'play',
    logical: _plainLogical,
    pixels: Size(1080, 1920),
    topRatio: 0.135,
  ),
  // Google Play「7インチ タブレット」。600dp幅 = 7インチ級のレイアウト。
  _Frame(
    dir: 'play-tablet-7',
    logical: Size(600, 960),
    pixels: Size(1200, 1920),
    topRatio: 0.135,
  ),
  // Google Play「10インチ タブレット」。800dp幅。
  _Frame(
    dir: 'play-tablet-10',
    logical: Size(800, 1280),
    pixels: Size(1600, 2560),
    topRatio: 0.135,
  ),
];

void main() {
  setUpAll(loadAppFonts);

  for (final _Shot shot in _shots) {
    for (final _Copy copy in shot.copy) {
      testWidgets('${copy.locale} ${shot.slug}', (WidgetTester tester) async {
        // ラスタライズ(toImage)は本物の非同期を要るので、pumpと分けて
        // runAsync の中で回す。fake_async のゾーンで呼ぶと完了しない。
        final GlobalKey plainKey = await _pump(
          tester,
          shot,
          copy.locale,
          _plainLogical,
        );
        await tester.runAsync(() async {
          _write(
            '$_outDir/${copy.locale}/plain/${shot.slug}.png',
            await _png(await _capture(plainKey)),
          );
        });

        for (final _Frame frame in _frames) {
          final GlobalKey key = await _pump(
            tester,
            shot,
            copy.locale,
            frame.logical,
          );
          await tester.runAsync(() async {
            _write(
              '$_outDir/${copy.locale}/${frame.dir}/${shot.slug}.png',
              await _png(
                await _compose(
                  await _capture(key),
                  copy,
                  frame.pixels,
                  topRatio: frame.topRatio,
                ),
              ),
            );
          });
        }
      });
    }
  }

  for (final _FeatureCopy copy in _featureCopy) {
    testWidgets('${copy.locale} feature graphic', (WidgetTester tester) async {
      await tester.runAsync(() async {
        _write(
          '$_featureDir/${copy.locale}-1024x500.png',
          await _png(await _featureGraphic(copy)),
        );
      });
    });
  }

  testWidgets('devpost thumbnail', (WidgetTester tester) async {
    final GlobalKey key = await _pump(
      tester,
      _thumbnailShot(),
      'en',
      _plainLogical,
    );
    await tester.runAsync(() async {
      _write(
        '$_devpostDir/thumbnail-1200x800.png',
        await _png(await _devpostThumbnail(await _capture(key))),
      );
    });
  });
}

// --- 実画面のレンダリング ---

Future<GlobalKey> _pump(
  WidgetTester tester,
  _Shot shot,
  String locale,
  Size logical,
) async {
  await tester.binding.setSurfaceSize(logical);
  tester.view.physicalSize = logical;
  tester.view.devicePixelRatio = 1;
  addTearDown(() async {
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });

  final GlobalKey key = GlobalKey();
  final Widget? screen = shot.screen;
  if (screen != null) {
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: wrapApp(
          screen,
          overrides: shot.overrides(locale),
          locale: Locale(locale),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return key;
  }

  // 常設タブの下の画面。ルータの redirect と画面が同じコンテナを見るよう、
  // golden の `expectRoutedGolden` と同じ形でコンテナを外から渡す。
  final ProviderContainer container = ProviderContainer(
    overrides: <Object?>[..._bootOverrides(), ...shot.overrides(locale)].cast(),
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    RepaintBoundary(
      key: key,
      child: wrapRouter(container, locale: Locale(locale)),
    ),
  );
  await tester.pumpAndSettle();
  container.read(appRouterProvider).go(shot.location!);
  await tester.pumpAndSettle();
  return key;
}

Future<ui.Image> _capture(GlobalKey key) {
  final RenderRepaintBoundary boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  return boundary.toImage(pixelRatio: _pixelRatio);
}

// --- 見出しつきの合成 ---

/// 淡い青の地。ストアの一覧で5枚が1つの帯に見えるように全枚数で共通。
const Color _canvasTop = Color(0xFFE6F4FE);
const Color _canvasBottom = Color(0xFFFBFAF7);

/// [topRatio] は見出しの下に空ける量(地の高さに対する比)。
/// 地の縦横比が変わると見出しと端末画像のあいだが空きすぎるので、
/// **Play(9:16)は captioned(1:2.17)より詰める**。
Future<ui.Image> _compose(
  ui.Image screen,
  _Copy copy,
  Size pixels, {
  double topRatio = 0.185,
}) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double w = pixels.width;
  final double h = pixels.height;

  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, Offset(0, h), <Color>[
        _canvasTop,
        _canvasBottom,
      ]),
  );

  final double captionBottom = _drawCaption(
    canvas,
    copy,
    top: h * 0.052,
    maxWidth: w * 0.84,
    centerX: w / 2,
    fontSize: w * 0.052,
  );

  // 端末フレーム(ベゼル)は描かない。角丸は写真の切り抜きとして最小限。
  //
  // [topRatio] は下限で、**見出しが実際に何行になったか**で押し下げる。
  // 地が横長になるほど1行に入る字数が減り、比だけで決めると2行の見出しが
  // 端末画像に食い込む(タブレットの日本語で最初に出た)。
  final double top = math.max(h * topRatio, captionBottom + h * 0.03);
  final double bottomPad = h * 0.024;
  double height = h - top - bottomPad;
  double width = height * (screen.width / screen.height);
  if (width > w * 0.88) {
    width = w * 0.88;
    height = width * (screen.height / screen.width);
  }
  final Rect dst = Rect.fromLTWH((w - width) / 2, top, width, height);
  final RRect clip = RRect.fromRectAndRadius(
    dst,
    Radius.circular(width * 0.045),
  );

  canvas.drawRRect(
    clip.shift(const Offset(0, 10)),
    Paint()
      ..color = const Color(0x1A33323D)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 24),
  );
  canvas.save();
  canvas.clipRRect(clip);
  canvas.drawImageRect(
    screen,
    Rect.fromLTWH(0, 0, screen.width.toDouble(), screen.height.toDouble()),
    dst,
    Paint()..filterQuality = FilterQuality.high,
  );
  canvas.restore();

  return recorder.endRecording().toImage(w.toInt(), h.toInt());
}

/// 見出し。蛍光マーカー(黄=言えた / ピンク=穴)がこのアプリの署名なので、
/// 強調はboldではなくマーカーで引く。**下端のyを返す** —— 呼び側は
/// これを見て端末画像の位置を決める(行数で高さが変わる)。
double _drawCaption(
  Canvas canvas,
  _Copy copy, {
  required double top,
  required double maxWidth,
  required double centerX,
  required double fontSize,
}) {
  final TextPainter painter = TextPainter(
    text: TextSpan(
      text: copy.headline,
      style: TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w700,
        fontSize: fontSize,
        height: 1.45,
        color: AppColors.ink,
      ),
    ),
    textAlign: TextAlign.center,
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: maxWidth);

  final Offset origin = Offset(centerX - painter.width / 2, top);

  final int start = copy.marker == null
      ? -1
      : copy.headline.indexOf(copy.marker!);
  if (start >= 0) {
    final List<TextBox> boxes = painter.getBoxesForSelection(
      TextSelection(
        baseOffset: start,
        extentOffset: start + copy.marker!.length,
      ),
    );
    for (final TextBox box in boxes) {
      final Rect r = box.toRect().shift(origin);
      canvas.drawRect(
        Rect.fromLTRB(
          r.left,
          r.top + r.height * 0.52,
          r.right,
          r.top + r.height * 0.96,
        ),
        Paint()..color = copy.markerColor.withValues(alpha: 0.92),
      );
    }
  }

  painter.paint(canvas, origin);
  return origin.dy + painter.height;
}

// --- フィーチャーグラフィック(1024x500) ---

/// Playの「フィーチャーグラフィック」。ストアページの一番上に出る1枚。
///
/// 地はスクショ5枚と同じ淡い青のグラデーションにする(掲載ページで
/// フィーチャーグラフィックとスクショの帯が地続きに見えるように)。
/// 絵柄はアイコンと同じマーク。**別の絵を新しく描かない** —— ストアで
/// 最初に目に入る2つ(アイコンとこの1枚)が違う絵だと結びつかない。
///
/// 端に寄せた要素はデバイスによって切られるので、内側 72px は空ける。
Future<ui.Image> _featureGraphic(_FeatureCopy copy) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double w = _featurePixels.width;
  final double h = _featurePixels.height;

  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, Offset(w, h), <Color>[
        _canvasTop,
        _canvasBottom,
      ]),
  );

  const double margin = 72;
  const double mark = 240;
  canvas.save();
  canvas.translate(margin, (h - mark) / 2);
  canvas.clipRRect(
    RRect.fromRectAndRadius(
      const Rect.fromLTWH(0, 0, mark, mark),
      const Radius.circular(mark * 0.22),
    ),
  );
  AppMark.paint(canvas, mark);
  canvas.restore();

  const double textLeft = margin + mark + 48;
  final double textWidth = w - textLeft - margin;

  final TextPainter headline = TextPainter(
    text: TextSpan(
      text: copy.headline,
      style: const TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w700,
        // 日本語の見出しが2行に収まる上限。全角14字 × 40 = 560 で、
        // 使える幅(592)に収まる。上げると「もらう。」だけが3行目に落ちる。
        fontSize: 40,
        height: 1.4,
        color: AppColors.ink,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: textWidth);

  final TextPainter sub = TextPainter(
    text: TextSpan(
      text: copy.sub,
      style: const TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w500,
        fontSize: 23,
        height: 1.4,
        color: AppColors.inkMuted,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: textWidth);

  const double gap = 24;
  final double blockHeight = headline.height + gap + sub.height;
  final Offset origin = Offset(textLeft, (h - blockHeight) / 2);

  // 強調はboldではなくマーカー(captioned の見出しと同じ作法)。
  final int start = copy.headline.indexOf(copy.marker);
  if (start >= 0) {
    for (final TextBox box in headline.getBoxesForSelection(
      TextSelection(
        baseOffset: start,
        extentOffset: start + copy.marker.length,
      ),
    )) {
      final Rect r = box.toRect().shift(origin);
      canvas.drawRect(
        Rect.fromLTRB(
          r.left,
          r.top + r.height * 0.52,
          r.right,
          r.top + r.height * 0.96,
        ),
        Paint()..color = AppColors.said.withValues(alpha: 0.92),
      );
    }
  }

  headline.paint(canvas, origin);
  sub.paint(canvas, Offset(textLeft, origin.dy + headline.height + gap));

  return recorder.endRecording().toImage(w.toInt(), h.toInt());
}

// --- Devpost のサムネイル(1200x800) ---

/// Devpost の Thumbnail 欄(3:2 推奨・JPG/PNG/GIF・5MB以下)。
///
/// 地と絵柄はフィーチャーグラフィックに揃える。ストアとDevpostで別の絵を出すと、
/// App Store を引きに行った審査員が同じアプリだと分からない。
///
/// **ギャラリーでは幅 350px 前後まで縮む**ので、読ませるのは見出しだけにして、
/// 板書は「数式が積まれている絵」として効かせる。文字を増やすほど、縮んだときに
/// 何も読めない灰色の板になる。
Future<ui.Image> _devpostThumbnail(ui.Image screen) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double w = _thumbPixels.width;
  final double h = _thumbPixels.height;

  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, Offset(w, h), <Color>[
        _canvasTop,
        _canvasBottom,
      ]),
  );

  // 右に授業の画面。**板書の途中で切る**ように下へ大きく出す。
  // 画面を丸ごと入れると、板の下半分の空きと「わかった」のボタンまで写って、
  // 縮んだときに黒い帯にしか見えない。
  const double margin = 72;
  const double shotTop = 56;
  const double shotHeight = 1000;
  final double shotWidth = shotHeight * (screen.width / screen.height);
  final Rect dst = Rect.fromLTWH(
    w - margin - shotWidth,
    shotTop,
    shotWidth,
    shotHeight,
  );
  final RRect clip = RRect.fromRectAndRadius(
    dst,
    Radius.circular(shotWidth * 0.075),
  );
  canvas.drawRRect(
    clip.shift(const Offset(0, 14)),
    Paint()
      ..color = const Color(0x2233323D)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 30),
  );
  canvas.save();
  canvas.clipRRect(clip);
  canvas.drawImageRect(
    screen,
    Rect.fromLTWH(0, 0, screen.width.toDouble(), screen.height.toDouble()),
    dst,
    Paint()..filterQuality = FilterQuality.high,
  );
  canvas.restore();

  // 左にアプリ名と見出し。
  const double textLeft = margin;
  final double textWidth = dst.left - margin - 56;

  final TextPainter name = TextPainter(
    text: const TextSpan(
      text: 'Katarute',
      style: TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w700,
        fontSize: 42,
        height: 1.2,
        color: AppColors.ink,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: textWidth);

  const String headlineText = 'Taught on a board.\nAsked again in 3 days.';
  const String headlineMarker = 'Asked again in 3 days';
  final TextPainter headline = TextPainter(
    text: const TextSpan(
      text: headlineText,
      style: TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w700,
        fontSize: 52,
        height: 1.34,
        color: AppColors.ink,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: textWidth);

  final TextPainter sub = TextPainter(
    text: const TextSpan(
      text: 'Every tutor teaches.\nAlmost none come back.',
      style: TextStyle(
        fontFamily: 'ZenMaruGothic',
        fontWeight: FontWeight.w500,
        fontSize: 29,
        height: 1.45,
        color: AppColors.inkMuted,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: textWidth);

  const double markSize = 76;
  const double gapLockup = 44;
  const double gapHeadline = 30;
  final double blockHeight =
      markSize + gapLockup + headline.height + gapHeadline + sub.height;
  final double top = (h - blockHeight) / 2;

  canvas.save();
  canvas.translate(textLeft, top);
  canvas.clipRRect(
    RRect.fromRectAndRadius(
      const Rect.fromLTWH(0, 0, markSize, markSize),
      const Radius.circular(markSize * 0.22),
    ),
  );
  AppMark.paint(canvas, markSize);
  canvas.restore();
  name.paint(
    canvas,
    Offset(textLeft + markSize + 24, top + (markSize - name.height) / 2),
  );

  final Offset headlineOrigin = Offset(textLeft, top + markSize + gapLockup);

  // 強調はboldではなくマーカー(スクショの見出し・フィーチャーグラフィックと同じ作法)。
  final int markerStart = headlineText.indexOf(headlineMarker);
  for (final TextBox box in headline.getBoxesForSelection(
    TextSelection(
      baseOffset: markerStart,
      extentOffset: markerStart + headlineMarker.length,
    ),
  )) {
    final Rect r = box.toRect().shift(headlineOrigin);
    canvas.drawRect(
      Rect.fromLTRB(
        r.left,
        r.top + r.height * 0.54,
        r.right,
        r.top + r.height * 0.95,
      ),
      Paint()..color = AppColors.said.withValues(alpha: 0.92),
    );
  }

  headline.paint(canvas, headlineOrigin);
  sub.paint(
    canvas,
    Offset(textLeft, headlineOrigin.dy + headline.height + gapHeadline),
  );

  return recorder.endRecording().toImage(w.toInt(), h.toInt());
}

@immutable
class _FeatureCopy {
  const _FeatureCopy({
    required this.locale,
    required this.headline,
    required this.marker,
    required this.sub,
  });

  final String locale;
  final String headline;

  /// マーカーを引く部分文字列。
  final String marker;
  final String sub;
}

/// 一行はLPとPlayの短い説明と同じ言葉にする(媒体ごとに言い方を変えない)。
const List<_FeatureCopy> _featureCopy = <_FeatureCopy>[
  _FeatureCopy(
    locale: 'ja',
    headline: '答えを教える。\nそのあと、教え返してもらう。',
    marker: '教え返してもらう',
    // 4課程(中学数学・高校数学・中学英語・高校英語)を1行で。
    // 「数I・A…」まで並べると科目名だけで行が埋まって英語が消える。
    sub: '中学・高校の数学と英語',
  ),
  _FeatureCopy(
    locale: 'en',
    headline: 'We teach you.\nThen you teach it back.',
    marker: 'you teach it back',
    sub: 'High school mathematics',
  ),
];

Future<Uint8List> _png(ui.Image image) async => (await image.toByteData(
  format: ui.ImageByteFormat.png,
))!.buffer.asUint8List();

void _write(String path, Uint8List bytes) {
  final File file = File(path);
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(bytes, flush: true);
}

// --- 5枚の中身 ---

@immutable
class _Copy {
  const _Copy({
    required this.locale,
    required this.headline,
    this.marker,
    this.markerColor = AppColors.said,
  });

  final String locale;
  final String headline;

  /// マーカーを引く部分文字列。
  final String? marker;
  final Color markerColor;
}

/// スクショ1枚ぶん。[screen] か [location] のどちらか一方だけを渡す。
///
/// - 常設タブの下の画面は [location] でルータ経由。下部タブごと撮る
/// - `MaterialApp.home` に置くとタブが写らず、実機と違う絵になる(2.3.3)
/// - 授業の線(撮影 → 会話 → 祝福)はシェルの外。実機にもタブが無い
@immutable
class _Shot {
  const _Shot({
    required this.slug,
    required this.copy,
    this.screen,
    this.location,
    this.overrides = _noOverrides,
  }) : assert(
         (screen == null) != (location == null),
         'screen か location のどちらか一方だけを渡すこと',
       );

  final String slug;

  /// シェルの外の画面。そのまま `MaterialApp.home` に置く。
  final Widget? screen;

  /// 常設タブの下にある画面のルート。下部ナビゲーションごと撮る。
  final String? location;

  final List<_Copy> copy;

  /// 差し替えるものは**ロケールで変わる**。板書も復習問題も、言葉だけでなく
  /// 課程ごと切り替わるため([ADR 0005](../../../docs/adr.md))。日本語の板書に
  /// 英語の見出しを付けた絵は、英語の掲載でも Shipaton の提出物でも通らない
  /// (提出物は英語、というのが Shipaton の要件。`docs/shipaton_submission.md` §0-1)。
  final List<Object?> Function(String locale) overrides;
}

List<Object?> _noOverrides(String locale) => const <Object?>[];

/// ルータ経由で撮るときの起動時の値。
/// 渡さないと初回起動と見なされ、オンボーディングが出る。
List<Object?> _bootOverrides() => <Object?>[
  onboardedProvider.overrideWithValue(true),
  deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
];

/// 会話画面は撮影から渡されたセッションが無いとホームへ戻る。
/// スクショでは通信しないので、繋がった体の状態を差し込む。
const SessionStart _sampleSessionStart = SessionStart(
  sessionId: 'ses_1',
  kind: 'realtime',
  livekit: LiveKitConnection(
    url: 'wss://example',
    token: 'token',
    room: 'room',
  ),
  limits: SessionLimits(
    maxSeconds: 300,
    remainingSecondsToday: 900,
    lessonAllowedToday: true,
  ),
);

/// 撮影から渡される解析の結果(単元と問題文)。会話の開始とは別の値。
const SessionAnalysis _sampleSessionAnalysis = SessionAnalysis(
  sessionId: 'ses_1',
  kind: 'realtime',
  detectedTopics: <DetectedTopic>[
    DetectedTopic(
      topicId: 'M1-NIJI-HANBETSU',
      course: '数I',
      unit: '2次関数',
      topic: '判別式',
      label: '数学I',
      confidence: 0.9,
    ),
  ],
);

// --- ロケールごとの中身 ---
//
// **言葉だけでなく課程も切り替わる**(ADR 0005)。英語の板書・復習問題は日本の
// 課程からの翻訳ではなく、`packages/curriculum` の intl 側の topic_id とラベルで作る。
// ここを1つにまとめてあるのは、日本語の中身に英語の見出しを付けた絵を
// 二度と出さないため(en の掲載でも Shipaton の提出物でも、それは英語の素材にならない)。

/// 授業中の板書。[extended] は Devpost のサムネイル用で、手順を最後まで積む
/// (3つだと板の下半分が空いたまま写り、縮めると黒い帯にしか見えない)。
SessionState _lessonState(String locale, {bool extended = false}) {
  final bool en = locale == 'en';
  return SessionState(
    phase: SessionPhase.senpaiTeaching,
    remainingSeconds: 214,
    // 数式は板書、声は問いかけだけ(計画書§3-1)。
    // 見出しの言葉と同じものを喋らせない。
    lastSenpaiText: en
        ? "Look at D here. It's positive, right? So?"
        : 'ここ、D を見てほしいんだけど — プラスだよね。だから?',
    board: BoardSnapshot(
      title: en
          ? 'Counting the solutions with the discriminant'
          : '判別式で解の個数を見る',
      steps: <BoardStep>[
        BoardStep(
          index: 0,
          speech: en ? 'Let me write it down as it is.' : 'まず、式をそのまま書くね。',
          board: const BoardElement.latex(tex: 'x^2 - 3x + 2 = 0'),
        ),
        BoardStep(
          index: 1,
          speech: en ? 'Which one is a, b and c?' : 'a、b、c がどれか、言える?',
          board: const BoardElement.text(body: 'a = 1, b = -3, c = 2'),
        ),
        BoardStep(
          index: 2,
          speech: en
              ? 'The discriminant had this shape, remember?'
              : '判別式は、この形だったよね。',
          board: const BoardElement.latex(
            tex: 'D = (-3)^2 - 4 \\cdot 1 \\cdot 2 = 1',
          ),
        ),
        if (extended) ...<BoardStep>[
          BoardStep(
            index: 3,
            speech: en ? 'So how many solutions does it have?' : 'で、解は何個?',
            board: BoardElement.text(
              body: en ? 'D > 0, so there are two.' : 'D > 0 だから、2個。',
            ),
          ),
          BoardStep(
            index: 4,
            speech: en
                ? 'Then the formula gives us both.'
                : 'あとは解の公式で、両方出る。',
            board: const BoardElement.latex(tex: 'x = \\frac{3 \\pm 1}{2}'),
          ),
          BoardStep(
            index: 5,
            speech: en ? 'Which comes out as?' : '計算すると?',
            board: BoardElement.text(
              body: en ? 'x = 2, x = 1' : 'x = 2, x = 1',
            ),
          ),
          BoardStep(
            index: 6,
            speech: en ? 'This one factors, too.' : 'これ、因数分解でもいける。',
            board: const BoardElement.latex(tex: '(x - 1)(x - 2) = 0'),
          ),
          BoardStep(
            index: 7,
            speech: en ? 'Same two answers, faster.' : '同じ答えが、もっと速く出る。',
            board: BoardElement.text(
              body: en ? 'Same two answers, faster.' : '同じ答えが、もっと速い。',
            ),
          ),
          BoardStep(
            index: 8,
            speech: en ? 'Let me check one of them.' : '片方、代入して確かめよう。',
            board: const BoardElement.latex(tex: '2^2 - 3 \\cdot 2 + 2 = 0'),
          ),
        ],
      ],
    ),
  );
}

/// ホームと復習に出す復習問題。
PracticeQueue _practiceQueue(String locale) {
  if (locale != 'en') return samplePracticeQueue;
  return PracticeQueue(
    items: <PracticeQueueItem>[
      PracticeQueueItem(
        problem: PracticeProblem(
          id: 'prb_discriminant',
          sessionId: 'ses_1',
          boardId: 'brd_1',
          topicId: 'A1-QUAD-SOLVE',
          question: 'How many solutions does x² − 6x + 5 = 0 have?',
          createdAt: DateTime.utc(2026, 8, 3, 13, 24, 7),
        ),
        daysSince: 3,
        topicLabel: 'The quadratic formula and the discriminant',
        lastVerdict: null,
      ),
      PracticeQueueItem(
        problem: PracticeProblem(
          id: 'prb_circle_line',
          sessionId: 'ses_2',
          boardId: 'brd_2',
          topicId: 'A2-COORD-CIRCLE',
          question: 'In how many points do x² + y² = 9 and y = x + 1 meet?',
          createdAt: DateTime.utc(2026, 8, 1, 12, 2, 44),
        ),
        daysSince: 5,
        topicLabel: 'Lines and circles',
        lastVerdict: PracticeVerdict.unclear,
      ),
    ],
    solved: <SolvedPractice>[_solvedPractice(locale)],
  );
}

/// 解けた問題(復習の下に積まれるほう)。
SolvedPractice _solvedPractice(String locale) {
  if (locale != 'en') return sampleSolvedPractice;
  return SolvedPractice(
    problem: PracticeProblem(
      id: 'prb_vertex',
      sessionId: 'ses_solved',
      boardId: 'brd_solved',
      topicId: 'A1-QUAD-GRAPH',
      question: 'What is the vertex of y = x² + 4x + 1?',
      createdAt: DateTime.utc(2026, 7, 29, 11, 15, 3),
    ),
    topicLabel: 'Parabolas and completing the square',
    daysSinceSolved: 1,
  );
}

/// Devpost のサムネイルに写す授業画面。`_shots` には入れない
/// (ストアの5枚は増やさない)。
_Shot _thumbnailShot() => _Shot(
  slug: 'devpost-thumbnail',
  screen: const SessionScreen(),
  overrides: (String locale) => <Object?>[
    captureControllerProvider.overrideWith(_FakeCaptureController.new),
    sessionControllerProvider.overrideWith(
      () => _FakeSessionController(_lessonState(locale, extended: true)),
    ),
  ],
  copy: const <_Copy>[_Copy(locale: 'en', headline: '')],
);

class _FakeSessionController extends SessionController {
  _FakeSessionController(this._state);

  final SessionState _state;

  @override
  SessionState build() => _state;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}
}

class _FakeCaptureController extends CaptureController {
  @override
  CaptureState build() => const CaptureState(
    analysis: _sampleSessionAnalysis,
    session: _sampleSessionStart,
  );
}

final List<_Shot> _shots = <_Shot>[
  // 1枚目は**授業モード(板書つき)**。ピボット前は「後輩が答えを知らないまま
  // 聞いてくる」画面だったが、それは改正前の約束1(答えを教えない)そのもので、
  // いまのプロダクトではない。板書が出ている画面は静止画でいちばん映えるので、
  // ストアの1枚目もここに変える(ADR 0006 でコアループの中心と定義した画面)。
  _Shot(
    slug: '01-lesson',
    screen: const SessionScreen(),
    overrides: (String locale) => <Object?>[
      captureControllerProvider.overrideWith(_FakeCaptureController.new),
      sessionControllerProvider.overrideWith(
        () => _FakeSessionController(_lessonState(locale)),
      ),
    ],
    copy: const <_Copy>[
      _Copy(locale: 'ja', headline: '先輩が、板書つきで教えてくれる。', marker: '板書つきで'),
      _Copy(
        locale: 'en',
        headline: 'Your senpai teaches you — on the board.',
        marker: 'on the board',
      ),
    ],
  ),
  _Shot(
    slug: '02-celebration',
    screen: const CelebrationScreen(),
    overrides: (String locale) => <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
    ],
    copy: const <_Copy>[
      _Copy(locale: 'ja', headline: '「わかった」の3日後、復習問題が届く。', marker: '復習問題が届く'),
      _Copy(
        locale: 'en',
        headline: 'Tap “Got it.” Review it again in 3 days.',
        marker: 'again in 3 days',
      ),
    ],
  ),
  // ここから3枚は常設タブの下。ルータ経由で撮って、下部ナビゲーションを写す。
  _Shot(
    slug: '03-practice',
    location: AppRoute.review.path,
    overrides: (String locale) => <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(
          PracticeQueue(
            items: <PracticeQueueItem>[_practiceQueue(locale).items.first],
          ),
        ),
      ),
    ],
    copy: <_Copy>[
      const _Copy(
        locale: 'ja',
        headline: '先輩の板書から、復習問題を1問。',
        marker: '復習問題を1問',
        markerColor: AppColors.hole,
      ),
      const _Copy(
        locale: 'en',
        headline: 'One review question, straight from the lesson board.',
        marker: 'One review question',
        markerColor: AppColors.hole,
      ),
    ],
  ),
  _Shot(
    slug: '04-progress',
    location: AppRoute.home.path,
    overrides: (String locale) => <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      // 「きのうの続き」のカードに、件数ではなく単元の中身を出すため。
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(_practiceQueue(locale)),
      ),
    ],
    copy: const <_Copy>[
      _Copy(
        locale: 'ja',
        headline: '数えるのは点数ではなく、続けた日数と解けた問題。',
        marker: '続けた日数と解けた問題',
        markerColor: AppColors.streak,
      ),
      _Copy(
        locale: 'en',
        headline: 'We count days and solved problems. Never a score.',
        marker: 'days and solved problems',
        markerColor: AppColors.streak,
      ),
    ],
  ),
  _Shot(
    slug: '05-review',
    location: AppRoute.review.path,
    overrides: (String locale) => <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(
          PracticeQueue(
            items: <PracticeQueueItem>[_practiceQueue(locale).items.first],
            solved: <SolvedPractice>[_solvedPractice(locale)],
          ),
        ),
      ),
    ],
    copy: const <_Copy>[
      _Copy(
        locale: 'ja',
        headline: '埋まるまで、翌日・3日後・7日後にまた聞いてくる。',
        marker: '翌日・3日後・7日後',
      ),
      _Copy(
        locale: 'en',
        headline: 'Your senpai asks again after 1, 3 and 7 days.',
        marker: 'after 1, 3 and 7 days',
      ),
    ],
  ),
];
