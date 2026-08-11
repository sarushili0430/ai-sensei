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
///
/// 並び順は inception-deck §3。①授業(板書)②祝福 ③カルテ ④連続日数 ⑤復習。
/// **デッキ §3 と同期していること。**片方だけ直すと、ストア素材と正文がずれる。
library;

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
// `SessionLimits` は karte / session の両方に別々の定義がある。ここで要るのは
// `SessionStart` が持つ session 側なので、karte 側を隠す。
import 'package:ai_sensei/src/features/karte/domain/karte.dart'
    hide SessionLimits;
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/karte_screen.dart';
import 'package:ai_sensei/src/features/karte/presentation/review_screen.dart';
import 'package:ai_sensei/src/features/session/application/board_inbox.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
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

/// 見出し付き。App Store Connect の 6.9インチ必須サイズ。
const Size _captionedLogical = Size(430, 932);
const Size _captionedPixels = Size(1290, 2796);

const double _pixelRatio = 3;

void main() {
  setUpAll(loadAppFonts);

  for (final _Shot shot in _shots) {
    for (final _Copy copy in shot.copy) {
      testWidgets('${copy.locale} ${shot.slug}', (WidgetTester tester) async {
        // ラスタライズ(toImage)は本物の非同期を要るので、pumpと分けて
        // runAsync の中で回す。fake_async のゾーンで呼ぶと完了しない。
        final GlobalKey plainKey =
            await _pump(tester, shot, copy.locale, _plainLogical);
        await tester.runAsync(() async {
          _write(
            '$_outDir/${copy.locale}/plain/${shot.slug}.png',
            await _png(await _capture(plainKey)),
          );
        });

        final GlobalKey key =
            await _pump(tester, shot, copy.locale, _captionedLogical);
        await tester.runAsync(() async {
          _write(
            '$_outDir/${copy.locale}/captioned/${shot.slug}.png',
            await _png(await _compose(await _capture(key), copy)),
          );
        });
      });
    }
  }
}

// --- 実画面のレンダリング ---

Future<GlobalKey> _pump(
    WidgetTester tester, _Shot shot, String locale, Size logical) async {
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
      child: wrapApp(shot.screen,
          overrides: shot.overrides, locale: Locale(locale)),
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

Future<ui.Image> _compose(ui.Image screen, _Copy copy) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double w = _captionedPixels.width;
  final double h = _captionedPixels.height;

  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(
          Offset.zero, Offset(0, h), <Color>[_canvasTop, _canvasBottom]),
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
  final RRect clip =
      RRect.fromRectAndRadius(dst, Radius.circular(width * 0.045));

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

  final int start =
      copy.marker == null ? -1 : copy.headline.indexOf(copy.marker!);
  if (start >= 0) {
    final List<TextBox> boxes = painter.getBoxesForSelection(
      TextSelection(
          baseOffset: start, extentOffset: start + copy.marker!.length),
    );
    for (final TextBox box in boxes) {
      final Rect r = box.toRect().shift(origin);
      canvas.drawRect(
        Rect.fromLTRB(
            r.left, r.top + r.height * 0.52, r.right, r.top + r.height * 0.96),
        Paint()..color = copy.markerColor.withValues(alpha: 0.92),
      );
    }
  }

  painter.paint(canvas, origin);
}

Future<Uint8List> _png(ui.Image image) async =>
    (await image.toByteData(format: ui.ImageByteFormat.png))!
        .buffer
        .asUint8List();

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
  livekit:
      LiveKitConnection(url: 'wss://example', token: 'token', room: 'room'),
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
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: true),
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
  CaptureState build() => const CaptureState(session: _sampleSessionStart);
}

final List<_Shot> _shots = <_Shot>[
  // 1枚目は**授業モード(板書つき)**。ピボット前は「後輩が答えを知らないまま
  // 聞いてくる」画面だったが、それは改正前の約束1(答えを教えない)そのもので、
  // いまのプロダクトではない。板書が残っている画面は静止画でいちばん映える
  // (計画書§4-2)ので、ストアの1枚目もここに変える。
  _Shot(
    slug: '01-lesson',
    screen: const SessionScreen(),
    overrides: <Object?>[
      captureControllerProvider.overrideWith(_FakeCaptureController.new),
      sessionControllerProvider.overrideWith(
        () => _FakeSessionController(
          const SessionState(
            phase: SessionPhase.senpaiTeaching,
            remainingSeconds: 214,
            // 数式は板書、声は問いかけだけ(計画書§3-1)。
            // 見出しの言葉と同じものを喋らせない。
            lastSenpaiText: 'ここ、D を見てほしいんだけど — プラスだよね。だから?',
            board: BoardSnapshot(
              title: '判別式で解の個数を見る',
              steps: <BoardStep>[
                BoardStep(
                  index: 0,
                  speech: 'まず、式をそのまま書くね。',
                  board: BoardElement.latex(tex: 'x^2 - 3x + 2 = 0'),
                ),
                BoardStep(
                  index: 1,
                  speech: 'a、b、c がどれか、言える?',
                  board: BoardElement.text(body: 'a = 1, b = -3, c = 2'),
                ),
                BoardStep(
                  index: 2,
                  speech: '判別式は、この形だったよね。',
                  board: BoardElement.latex(
                      tex: 'D = (-3)^2 - 4 \\cdot 1 \\cdot 2 = 1'),
                ),
              ],
            ),
          ),
        ),
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
    overrides: <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
    ],
    copy: const <_Copy>[
      _Copy(locale: 'ja', headline: '教え返せると、先輩の顔が輝く。', marker: '先輩の顔が輝く'),
      _Copy(
        locale: 'en',
        headline: 'Teach it back well and your senpai lights up.',
        marker: 'your senpai lights up',
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
      progressControllerProvider.overrideWith(FakeProgressController.new)
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
            items: <ReviewQueueItem>[
              ReviewQueueItem(
                hole: sampleKarte.holes.first,
                daysSince: 3,
                prompt: '3日前の「判別式のなぜ」、いまなら説明できますか?',
                quiz: '判別式を使うと解の個数がわかる理由を説明できる?',
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
          marker: '翌日・3日後・7日後'),
      _Copy(
        locale: 'en',
        headline: 'Your senpai asks again after 1, 3 and 7 days.',
        marker: 'after 1, 3 and 7 days',
      ),
    ],
  ),
];
