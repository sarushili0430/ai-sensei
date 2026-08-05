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
///   plain/          1179x2556 端末フレームなしの素のまま。Shipaton提出用の指定サイズ
///   captioned-6.9/  1290x2796 App Store Connect「6.9インチディスプレイ」枠。見出し付き
///   captioned-6.5/  1284x2778 同「6.5インチディスプレイ」枠。見出し付き
///
/// **枠ごとに受け付ける寸法が違う**。6.9インチ枠に入るのは 1290x2796 か
/// 1320x2868、6.5インチ枠は 1242x2688 か 1284x2778 だけで、
/// 6.9用を6.5枠へ入れると「寸法が正しくありません」で弾かれる。
/// どちらも 19.5:9 なので、同じ絵を解像度違いで出せば足りる。
///
/// 並び順は inception-deck §3。①会話 ②祝福 ③カルテ ④連続日数 ⑤復習。
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
// `SessionLimits` は karte / session の両方に別々の定義がある。ここで要るのは
// `SessionStart` が持つ session 側なので、karte 側を隠す。
import 'package:ai_sensei/src/features/karte/domain/karte.dart' hide SessionLimits;
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/support/harness.dart';

const String _outDir = '../../docs/store/screenshots';

/// 素のスクショ。iPhone 15 Pro の論理サイズ。×3で 1179x2556 になる。
const Size _plainLogical = Size(393, 852);

const double _pixelRatio = 3;

/// 見出し付きの出力先。App Store Connect の枠ごとに1つ。
///
/// `logical` は**その枠の端末の論理サイズ**にしてある。×3が `pixels` に
/// 一致するので、実画面のレイアウトが伸び縮みせずそのまま入る。
@immutable
class _Frame {
  const _Frame({required this.dir, required this.logical, required this.pixels});

  final String dir;
  final Size logical;
  final Size pixels;
}

const List<_Frame> _frames = <_Frame>[
  // 6.9インチ枠(iPhone 16 Pro Max 相当)。いま必須なのはこちら。
  _Frame(dir: 'captioned-6.9', logical: Size(430, 932), pixels: Size(1290, 2796)),
  // 6.5インチ枠(iPhone 12 Pro Max 相当)。枠が残っているあいだは埋めておく。
  _Frame(dir: 'captioned-6.5', logical: Size(428, 926), pixels: Size(1284, 2778)),
];

void main() {
  setUpAll(loadAppFonts);

  for (final _Shot shot in _shots) {
    for (final _Copy copy in shot.copy) {
      testWidgets('${copy.locale} ${shot.slug}', (WidgetTester tester) async {
        // ラスタライズ(toImage)は本物の非同期を要るので、pumpと分けて
        // runAsync の中で回す。fake_async のゾーンで呼ぶと完了しない。
        final GlobalKey plainKey = await _pump(tester, shot, copy.locale, _plainLogical);
        await tester.runAsync(() async {
          _write(
            '$_outDir/${copy.locale}/plain/${shot.slug}.png',
            await _png(await _capture(plainKey)),
          );
        });

        for (final _Frame frame in _frames) {
          final GlobalKey key = await _pump(tester, shot, copy.locale, frame.logical);
          await tester.runAsync(() async {
            _write(
              '$_outDir/${copy.locale}/${frame.dir}/${shot.slug}.png',
              await _png(await _compose(await _capture(key), copy, frame)),
            );
          });
        }
      });
    }
  }
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
  await tester.pumpWidget(
    RepaintBoundary(
      key: key,
      child: wrapApp(shot.screen, overrides: shot.overrides, locale: Locale(locale)),
    ),
  );
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

Future<ui.Image> _compose(ui.Image screen, _Copy copy, _Frame frame) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double w = frame.pixels.width;
  final double h = frame.pixels.height;

  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(
        Offset.zero,
        Offset(0, h),
        <Color>[_canvasTop, _canvasBottom],
      ),
  );

  _drawCaption(
    canvas,
    copy,
    top: h * 0.052,
    maxWidth: w * 0.84,
    centerX: w / 2,
    fontSize: w * 0.052,
  );

  // 端末フレーム(ベゼル)は描かない。角丸は写真の切り抜きとして最小限。
  final double top = h * 0.185;
  final double bottomPad = h * 0.024;
  double height = h - top - bottomPad;
  double width = height * (screen.width / screen.height);
  if (width > w * 0.88) {
    width = w * 0.88;
    height = width * (screen.height / screen.width);
  }
  final Rect dst = Rect.fromLTWH((w - width) / 2, top, width, height);
  final RRect clip = RRect.fromRectAndRadius(dst, Radius.circular(width * 0.045));

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
/// 強調はboldではなくマーカーで引く。
void _drawCaption(
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

  final int start = copy.marker == null ? -1 : copy.headline.indexOf(copy.marker!);
  if (start >= 0) {
    final List<TextBox> boxes = painter.getBoxesForSelection(
      TextSelection(baseOffset: start, extentOffset: start + copy.marker!.length),
    );
    for (final TextBox box in boxes) {
      final Rect r = box.toRect().shift(origin);
      canvas.drawRect(
        Rect.fromLTRB(r.left, r.top + r.height * 0.52, r.right, r.top + r.height * 0.96),
        Paint()..color = copy.markerColor.withValues(alpha: 0.92),
      );
    }
  }

  painter.paint(canvas, origin);
}

Future<Uint8List> _png(ui.Image image) async =>
    (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();

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

@immutable
class _Shot {
  const _Shot({
    required this.slug,
    required this.screen,
    required this.copy,
    this.overrides = const <Object?>[],
  });

  final String slug;
  final Widget screen;
  final List<_Copy> copy;
  final List<Object?> overrides;
}

/// 会話画面は撮影から渡されたセッションが無いとホームへ戻る。
/// スクショでは通信しないので、繋がった体の状態を差し込む。
const SessionStart _sampleSessionStart = SessionStart(
  sessionId: 'ses_1',
  kind: 'realtime',
  livekit: LiveKitConnection(url: 'wss://example', token: 'token', room: 'room'),
  detectedTopics: <DetectedTopic>[
    DetectedTopic(
      topicId: 'M1-NIJI-HANBETSU',
      course: '数I',
      unit: '2次関数',
      topic: '判別式',
      confidence: 0.9,
    ),
  ],
  limits: SessionLimits(maxSeconds: 300, remainingSessionsToday: 1),
);

class _FakeSessionController extends SessionController {
  _FakeSessionController(this._state);

  final SessionState _state;

  @override
  SessionState build() => _state;

  @override
  Future<void> connect(SessionStart session) async {}
}

class _FakeCaptureController extends CaptureController {
  @override
  CaptureState build() => const CaptureState(session: _sampleSessionStart);
}

final List<_Shot> _shots = <_Shot>[
  _Shot(
    slug: '01-session',
    screen: const SessionScreen(),
    overrides: <Object?>[
      captureControllerProvider.overrideWith(_FakeCaptureController.new),
      sessionControllerProvider.overrideWith(
        () => _FakeSessionController(
          const SessionState(
            phase: SessionPhase.kohaiSpeaking,
            remainingSeconds: 214,
            lastKohaiText: 'え、(2)っていきなり判別式ですけど、なんでですか?',
          ),
        ),
      ),
    ],
    copy: const <_Copy>[
      _Copy(
        locale: 'ja',
        headline: '後輩が、答えを知らないまま聞いてくる。',
        marker: '答えを知らないまま',
      ),
      _Copy(
        locale: 'en',
        headline: 'A junior asks you — and never knows the answer.',
        marker: 'never knows the answer',
      ),
    ],
  ),
  _Shot(
    slug: '02-celebration',
    screen: const CelebrationScreen(),
    overrides: <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
    ],
    copy: const <_Copy>[
      _Copy(
        locale: 'ja',
        headline: '説明が伝わると、後輩の顔が輝く。',
        marker: '後輩の顔が輝く',
      ),
      _Copy(
        locale: 'en',
        headline: 'Explain it well and your kohai lights up.',
        marker: 'your kohai lights up',
      ),
    ],
  ),
  _Shot(
    slug: '03-karte',
    screen: const KarteScreen(),
    overrides: <Object?>[
      latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
    ],
    copy: <_Copy>[
      const _Copy(
        locale: 'ja',
        headline: '説明が止まった場所が、そのまま「理解の穴」に。',
        marker: '理解の穴',
        markerColor: AppColors.hole,
      ),
      const _Copy(
        locale: 'en',
        headline: 'Where you stalled becomes a gap on your karte.',
        marker: 'a gap',
        markerColor: AppColors.hole,
      ),
    ],
  ),
  _Shot(
    slug: '04-progress',
    screen: const HomeScreen(),
    overrides: <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
    ],
    copy: const <_Copy>[
      _Copy(
        locale: 'ja',
        headline: '数えるのは点数ではなく、続けた日数と埋めた穴。',
        marker: '続けた日数と埋めた穴',
        markerColor: AppColors.streak,
      ),
      _Copy(
        locale: 'en',
        headline: 'We count days and gaps filled. Never a score.',
        marker: 'days and gaps filled',
        markerColor: AppColors.streak,
      ),
    ],
  ),
  _Shot(
    slug: '05-review',
    screen: const ReviewScreen(),
    overrides: <Object?>[
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(
          ReviewQueue(
            requiresPremium: false,
            items: <ReviewQueueItem>[
              ReviewQueueItem(
                hole: sampleKarte.holes.first,
                daysSince: 3,
                prompt: '3日前の「判別式のなぜ」、いまなら説明できますか?',
              ),
            ],
            filled: <FilledHole>[sampleFilledHole],
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
        headline: 'Your kohai asks again after 1, 3 and 7 days.',
        marker: 'after 1, 3 and 7 days',
      ),
    ],
  ),
];
