/// Exports store screenshots from the real screens.
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_store_screenshots.dart
/// ```
///
/// Hand-drawn mockups are not used because App Review requires screenshots to
/// represent the actual app (guideline 2.3.3). This renders the real widget tree
/// through the same mechanism as the golden tests.
///
/// Output (`docs/store/screenshots/`):
///   plain/     1179x2556, no device frame. The size required for submission
///   captioned/ 1290x2796, App Store Connect's mandatory 6.9-inch size, captioned
///   play/      1080x1920, Google Play "phone", captioned
///   play-tablet-7/  1200x1920, Google Play "7-inch tablet" (rendered at 600dp)
///   play-tablet-10/ 1600x2560, Google Play "10-inch tablet" (rendered at 800dp)
///
/// Do not reuse captioned for Play: Play restricts the aspect ratio to 16:9-9:16,
/// and 1290x2796 (1:2.17) is taller than 9:16 (1:1.78), so it is rejected.
///
/// The feature graphic (`docs/store/feature-graphic/`, 1024x500) is drawn here
/// too. Play requires it; without it the app cannot be published.
///
/// The order follows the deck: lesson (board), celebration, karte, streak,
/// review. Keep it in sync with the deck, or the store assets and the canonical
/// text drift apart.
library;

import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/application/last_board_controller.dart';
import 'package:ai_sensei/src/features/karte/domain/last_board.dart';
// `SessionLimits` is defined separately in karte and session. What is needed
// here is the session one held by `SessionStart`, so the karte one is hidden.
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

/// The plain screenshot, at iPhone 15 Pro logical size; x3 gives 1179x2556.
const Size _plainLogical = Size(393, 852);

/// The feature graphic, at the one size Play specifies.
const Size _featurePixels = Size(1024, 500);

const double _pixelRatio = 3;

/// A captioned output frame. The screen inside really is rendered at this
/// `logical` size, so tablet shots use the tablet-width layout and never show a
/// picture the device would not.
@immutable
class _Frame {
  const _Frame({
    required this.dir,
    required this.logical,
    required this.pixels,
    required this.topRatio,
  });

  /// Directory name under `docs/store/screenshots/{locale}/`.
  final String dir;
  final Size logical;
  final Size pixels;

  /// Space below the caption, as a fraction of canvas height. Wider canvases get
  /// less.
  final double topRatio;
}

/// A very tall canvas separates caption and device image, absorbed by `topRatio`.
const List<_Frame> _frames = <_Frame>[
  // App Store Connect's mandatory 6.9-inch size.
  _Frame(
    dir: 'captioned',
    logical: Size(430, 932),
    pixels: Size(1290, 2796),
    topRatio: 0.185,
  ),
  // Google Play "phone", exactly 9:16.
  _Frame(
    dir: 'play',
    logical: _plainLogical,
    pixels: Size(1080, 1920),
    topRatio: 0.135,
  ),
  // Google Play "7-inch tablet": 600dp wide, a 7-inch-class layout.
  _Frame(
    dir: 'play-tablet-7',
    logical: Size(600, 960),
    pixels: Size(1200, 1920),
    topRatio: 0.135,
  ),
  // Google Play "10-inch tablet", 800dp wide.
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
        // Rasterizing (toImage) needs real async, so it runs inside runAsync,
        // separate from pump; called in a fake_async zone it never completes.
        final GlobalKey plainKey =
            await _pump(tester, shot, copy.locale, _plainLogical);
        await tester.runAsync(() async {
          _write(
            '$_outDir/${copy.locale}/plain/${shot.slug}.png',
            await _png(await _capture(plainKey)),
          );
        });

        for (final _Frame frame in _frames) {
          final GlobalKey key =
              await _pump(tester, shot, copy.locale, frame.logical);
          await tester.runAsync(() async {
            _write(
              '$_outDir/${copy.locale}/${frame.dir}/${shot.slug}.png',
              await _png(await _compose(
                await _capture(key),
                copy,
                frame.pixels,
                topRatio: frame.topRatio,
              )),
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
}

// --- Rendering the real screens ---

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
  final Widget? screen = shot.screen;
  if (screen != null) {
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child:
            wrapApp(screen, overrides: shot.overrides, locale: Locale(locale)),
      ),
    );
    await tester.pumpAndSettle();
    return key;
  }

  // Screens under the permanent tabs. The container is passed in, as in the
  // goldens' `expectRoutedGolden`, so the router's redirect and the screen share
  // one container.
  final ProviderContainer container = ProviderContainer(
    overrides: <Object?>[..._bootOverrides(), ...shot.overrides].cast(),
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

// --- Captioned composition ---

/// The pale blue canvas, shared by every shot so the five read as one band in
/// the store listing.
const Color _canvasTop = Color(0xFFE6F4FE);
const Color _canvasBottom = Color(0xFFFBFAF7);

/// [topRatio] is the space below the caption as a fraction of canvas height.
/// A different aspect ratio leaves too much room between caption and device
/// image, so Play (9:16) uses less than captioned (1:2.17).
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
      ..shader = ui.Gradient.linear(
          Offset.zero, Offset(0, h), <Color>[_canvasTop, _canvasBottom]),
  );

  final double captionBottom = _drawCaption(
    canvas,
    copy,
    top: h * 0.052,
    maxWidth: w * 0.84,
    centerX: w / 2,
    fontSize: w * 0.052,
  );

  // No device bezel is drawn; the corner radius is the minimum for a crop.
  //
  // [topRatio] is a floor, pushed down by how many lines the caption actually
  // took. A wider canvas fits fewer characters per line, so deciding by ratio
  // alone lets a two-line caption bite into the device image (first seen with
  // Japanese on tablets).
  final double top = math.max(h * topRatio, captionBottom + h * 0.03);
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

/// The caption. The highlighter (yellow = said it, pink = a gap) is the app's
/// signature, so emphasis is a marker rather than bold. It returns the bottom y,
/// which the caller uses to place the device image (height varies with lines).
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
  return origin.dy + painter.height;
}

// --- Feature graphic (1024x500) ---

/// Play's feature graphic, the image at the top of the store page.
///
/// It uses the same pale blue gradient as the five screenshots, so the graphic
/// and the screenshot band read as continuous on the listing. The artwork is the
/// same mark as the icon: no new picture, because the two things seen first in
/// the store must connect.
///
/// Edge-aligned elements get cropped on some devices, so 72px is kept clear.
Future<ui.Image> _featureGraphic(_FeatureCopy copy) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final double w = _featurePixels.width;
  final double h = _featurePixels.height;

  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(
          Offset.zero, Offset(w, h), <Color>[_canvasTop, _canvasBottom]),
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
        // The largest size keeping the Japanese caption to two lines: 14
        // full-width characters at 40 gives 560, inside the usable 592. Any
        // larger and the last word drops to a third line.
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

  // Emphasis is a marker, not bold (as in the captioned headings).
  final int start = copy.headline.indexOf(copy.marker);
  if (start >= 0) {
    for (final TextBox box in headline.getBoxesForSelection(
      TextSelection(baseOffset: start, extentOffset: start + copy.marker.length),
    )) {
      final Rect r = box.toRect().shift(origin);
      canvas.drawRect(
        Rect.fromLTRB(
            r.left, r.top + r.height * 0.52, r.right, r.top + r.height * 0.96),
        Paint()..color = AppColors.said.withValues(alpha: 0.92),
      );
    }
  }

  headline.paint(canvas, origin);
  sub.paint(canvas, Offset(textLeft, origin.dy + headline.height + gap));

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

  /// The substring the marker is drawn under.
  final String marker;
  final String sub;
}

/// The one-liner matches the landing page and Play's short description; the
/// wording does not change per medium.
const List<_FeatureCopy> _featureCopy = <_FeatureCopy>[
  _FeatureCopy(
    locale: 'ja',
    headline: '答えを教える。\nそのあと、教え返してもらう。',
    marker: '教え返してもらう',
    // All four curricula on one line. Listing individual subject names fills the
    // line and English disappears.
    sub: '中学・高校の数学と英語',
  ),
  _FeatureCopy(
    locale: 'en',
    headline: 'We teach you.\nThen you teach it back.',
    marker: 'you teach it back',
    sub: 'High school mathematics',
  ),
];

Future<Uint8List> _png(ui.Image image) async =>
    (await image.toByteData(format: ui.ImageByteFormat.png))!
        .buffer
        .asUint8List();

void _write(String path, Uint8List bytes) {
  final File file = File(path);
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(bytes, flush: true);
}

// --- The five shots ---

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

  /// The substring the marker is drawn under.
  final String? marker;
  final Color markerColor;
}

/// One screenshot. Pass exactly one of [screen] or [location].
///
/// - Screens under the permanent tabs use [location] and go through the router,
///   so the bottom tabs are captured
/// - Placed in `MaterialApp.home` the tabs are missing, giving a picture the
///   device never shows (2.3.3)
/// - The lesson line (capture, conversation, celebration) sits outside the shell,
///   and has no tabs on device either
@immutable
class _Shot {
  const _Shot({
    required this.slug,
    required this.copy,
    this.screen,
    this.location,
    this.overrides = const <Object?>[],
  }) : assert(
          (screen == null) != (location == null),
          'screen か location のどちらか一方だけを渡すこと',
        );

  final String slug;

  /// A screen outside the shell, placed directly in `MaterialApp.home`.
  final Widget? screen;

  /// The route of a screen under the permanent tabs; shot with the navigation.
  final String? location;

  final List<_Copy> copy;
  final List<Object?> overrides;
}

/// Startup values for router-based shots. Without them it looks like a first
/// launch and onboarding appears.
List<Object?> _bootOverrides() => <Object?>[
      onboardedProvider.overrideWithValue(true),
      deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
    ];

/// The conversation screen returns home without a session passed from capture.
/// Screenshots make no requests, so a connected-looking state is injected.
const SessionStart _sampleSessionStart = SessionStart(
  sessionId: 'ses_1',
  kind: 'realtime',
  livekit:
      LiveKitConnection(url: 'wss://example', token: 'token', room: 'room'),
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: true),
);

/// The analysis result passed from capture (topic and problem text); separate
/// from the conversation start.
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

/// The board kept in the karte, filling the third shot's evidence section.
class _FakeLastBoardController extends LastBoardController {
  @override
  LastBoard build() => const LastBoard(
        steps: <BoardStep>[
          BoardStep(
            index: 0,
            speech: 'まず、式をそのまま書くね。',
            board: BoardElement.latex(tex: 'x^2 - 3x + 2 = 0'),
          ),
          BoardStep(
            index: 1,
            speech: '判別式は、この形だったよね。',
            board: BoardElement.latex(tex: 'D = (-3)^2 - 4 \\cdot 1 \\cdot 2 = 1'),
          ),
        ],
      );
}

final List<_Shot> _shots = <_Shot>[
  // The first shot is lesson mode, with the board. Before the pivot it was a
  // junior asking without knowing the answer, which was the old promise not to
  // give the answer and is no longer the product. A screen with a board also
  // reads best as a still, so it leads the store listing (ADR 0006 defines it as
  // the core loop's centre).
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
            // Formulas on the board, voice for questions only, and never the
            // same words as the caption.
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
  // The next three sit under the permanent tabs, shot through the router so the
  // bottom navigation appears.
  _Shot(
    slug: '03-karte',
    location: AppRoute.karte.path,
    overrides: <Object?>[
      latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
      // The "what senpai wrote" section (ADR 0006): the karte's evidence, so it
      // is never dropped.
      lastBoardControllerProvider.overrideWith(_FakeLastBoardController.new),
      progressControllerProvider.overrideWith(FakeProgressController.new),
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(const ReviewQueue(items: <ReviewQueueItem>[])),
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
    location: AppRoute.home.path,
    overrides: <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      // So the "yesterday's thread" card shows topic content rather than a count.
      reviewControllerProvider.overrideWith(
        () => FakeReviewController(sampleReviewQueue),
      ),
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
    location: AppRoute.review.path,
    overrides: <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
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
