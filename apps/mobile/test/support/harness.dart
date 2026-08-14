import 'dart:convert';

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/parent_report/application/parent_report_controller.dart';
import 'package:ai_sensei/src/features/parent_report/domain/parent_report.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Scaffolding for building screens in tests.
///
/// It passes the same delegates as the production `AiSenseiApp`; removing them
/// fails with "MaterialLocalizations does not support ja".
///
/// `overrides` is `List<Object?>` because Riverpod 3 does not expose the
/// `Override` type publicly; `cast()`'s type is inferred from ProviderScope.
Widget wrapApp(
  Widget child, {
  List<Object?> overrides = const <Object?>[],
  Locale locale = const Locale('ja'),
}) {
  return ProviderScope(
    overrides: overrides.cast(),
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      locale: locale,
      supportedLocales: AppStrings.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppStringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      builder: reduceMotion,
      home: child,
    ),
  );
}

/// Stops decorative animation for the duration of a test.
///
/// It takes the same path (`AppMotion`) as the device's "reduce animations", so
/// entrances are drawn in their finished state and loops like breathing and
/// blinking never start. Goldens stop changing between frames and
/// `pumpAndSettle` returns.
///
/// Conversely, adding an animation that skips this path hangs `pumpAndSettle`
/// and fails the test — which is the detection itself.
Widget reduceMotion(BuildContext context, Widget? child) {
  return MediaQuery(
    data: MediaQuery.of(context).copyWith(disableAnimations: true),
    child: child ?? const SizedBox.shrink(),
  );
}

/// Builds with the real router.
///
/// Used to check what a single screen cannot show: whether you can get back.
/// When `go` vs `push` or route nesting breaks, dead ends fail here.
///
/// The container is created by the caller and passed in so the router can be
/// pulled out first; rebuilding it in `ProviderScope` would put the router's
/// `redirect` and the screen on different containers.
///
/// [locale] exists because the store screenshot tool
/// (`tool/generate_store_screenshots.dart`) shoots the same screens in both
/// languages, tab by tab. Tests keep the Japanese default.
Widget wrapRouter(ProviderContainer container, {Locale locale = const Locale('ja')}) {
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      locale: locale,
      supportedLocales: AppStrings.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppStringsDelegate(),
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      builder: reduceMotion,
      routerConfig: container.read(appRouterProvider),
    ),
  );
}

/// Builds a screen and pumps until rendering settles.
///
/// GlobalMaterialLocalizations' delegates load asynchronously, so the first frame
/// after pumpWidget has no body text yet. Forgetting that fails with "Found 0
/// widgets".
///
/// ## Always pin the surface size
///
/// A widget test defaults to 800x600 — landscape, and no real device. It is over
/// 250pt shorter than a phone, so buttons near the bottom fall outside the
/// viewport. And `tap` on off-screen coordinates does not throw: it silently does
/// nothing, so the test passes while the interaction never lands.
///
/// That happened in onboarding: "I can't explain it" dropped below the fold and
/// three tests stayed green, so nobody noticed the board had grown the screen.
/// With a real device size as the default, the same break fails as "button not
/// found".
///
/// ## Device-stored settings
///
/// `preferencesProvider` is meant to be overridden in `main()`, so tests must
/// always inject it here. Without it, providers that read it (school stage and so
/// on) cannot start, and the screen renders while the requests silently never go
/// out. Each test starts empty, so it renders at the default (senior high).
Future<void> pumpApp(
  WidgetTester tester,
  Widget child, {
  List<Object?> overrides = const <Object?>[],
  Locale locale = const Locale('ja'),
  Size size = phoneSurface,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences preferences = await SharedPreferences.getInstance();
  await setSurface(tester, size: size);
  await tester.pumpWidget(
    wrapApp(
      child,
      // Caller overrides go last, so the same provider wins there.
      overrides: <Object?>[preferencesProvider.overrideWithValue(preferences), ...overrides],
      locale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

/// Default surface size, in logical pixels for an iPhone 15.
///
/// Goldens are shot at this size too (hence its old name `goldenSurface`), but it
/// is not golden-specific: a golden-sounding name removes the motivation to pin
/// the size in ordinary widget tests.
const Size phoneSurface = Size(393, 852);

/// The narrowest real device (iPhone SE class).
///
/// Use it to check that controls have not fallen below the fold. Screens that fit
/// at [phoneSurface] can still overflow here.
const Size smallPhoneSurface = Size(375, 667);

/// Loads the real fonts.
///
/// Widget tests render with Ahem (blank boxes) by default, so goldens shot that
/// way hide broken glyphs. The rounded gothic is part of the brand, so the real
/// file is loaded.
///
/// Fonts come from the FontManifest rather than hard-coded paths so MaterialIcons
/// loads too: with square icons, goldens cannot confirm the back button or the
/// settings icon is present, and a vanished route would go unnoticed.
///
/// Family names are registered as-is, prefix included. We used to keep only the
/// last segment of `packages/foo/MyFont`, which assumed the app's own font
/// (`ZenMaruGothic`, unprefixed). Third-party font packages — the KaTeX fonts in
/// `flutter_math_fork`, for instance — reference their families with the prefix
/// (`'packages/flutter_math_fork/KaTeX_Main'`) in their own code. Stripping it
/// leaves those widgets unable to find the font, which renders as tofu in
/// goldens. Reading `FontManifest.json` confirmed `MaterialIcons` and
/// `ZenMaruGothic` carry no prefix, so keeping it changes no existing golden.
Future<void> loadAppFonts() async {
  final String manifest = await rootBundle.loadString('FontManifest.json');

  for (final dynamic entry in jsonDecode(manifest) as List<dynamic>) {
    final Map<String, dynamic> family = entry as Map<String, dynamic>;
    final String name = family['family'] as String;

    final FontLoader loader = FontLoader(name);
    for (final dynamic font in family['fonts'] as List<dynamic>) {
      loader.addFont(rootBundle.load((font as Map<String, dynamic>)['asset'] as String));
    }
    await loader.load();
  }
}

/// Pins the surface size.
///
/// For goldens it stops device differences shifting the image; for ordinary
/// widget tests it stops them running at the 800x600 landscape default, which
/// matches no device.
Future<void> setSurface(WidgetTester tester, {Size size = phoneSurface}) async {
  await tester.binding.setSurfaceSize(size);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() async {
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

/// Alternates real and fake time until [finder] appears.
///
/// ## How `pumpAndSettle` stops returning
///
/// It hangs when a spinner is on screen while an async operation is pending.
/// `CircularProgressIndicator` animates forever, so `pumpAndSettle` keeps
/// deciding another frame is coming, and the async work behind it does not
/// advance under fake time. Two cases hit this:
///
///   - multipart uploads: `MockClient` actually reads the file while composing
///     the body, which only progresses inside `runAsync` (plain `test()` cases
///     are fine because they are on real time from the start)
///   - `permission_handler` queries: without a channel stub, no response arrives
///     and the spinner keeps turning while permission is awaited — covered by
///     [mockPermissionHandler]
///
/// So instead of `pumpAndSettle`, this alternates real time
/// ([WidgetTester.runAsync]) and fake time ([WidgetTester.pump]) and stops once
/// the marker appears.
Future<void> pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration step = const Duration(milliseconds: 10),
  int maxSteps = 100,
}) async {
  for (int i = 0; i < maxSteps; i++) {
    await tester.runAsync(() => Future<void>.delayed(step));
    await tester.pump(step);
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('${finder.describeMatch(Plurality.one)} が ${step * maxSteps} 待っても現れませんでした');
}

/// Stubs the `permission_handler` channel.
///
/// Without it the query never returns, and if a spinner is on screen while
/// permission is awaited, `pumpAndSettle` hangs (see [pumpUntil]). On device the
/// query always answers, so it answers in tests too.
///
/// [status] follows `PermissionStatus`'s order (0=denied, 1=granted,
/// 2=restricted, 3=limited, 4=permanentlyDenied). Defaults to granted.
void mockPermissionHandler({int status = permissionGranted}) {
  const MethodChannel channel = MethodChannel('flutter.baseflow.com/permissions/methods');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async => status);
  addTearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );
}

/// `PermissionStatus.granted` (second in the enum).
const int permissionGranted = 1;

/// `PermissionStatus.denied` (first in the enum).
const int permissionDenied = 0;

// --- Test data ---

final Karte sampleKarte = Karte(
  id: 'kar_1',
  sessionId: 'ses_1',
  createdAt: DateTime.utc(2026, 8, 3, 13, 24, 7),
  topicIds: const <String>['M2-ZUKEI-ENCHOKU', 'M1-NIJI-HANBETSU'],
  saidWell: const <String>[
    '中心と直線の距離dと半径rを比べて位置関係を判定する方針を、理由つきで説明できた',
    'd < r なら2点で交わる、と対応づけて言えた',
  ],
  holes: <Hole>[
    Hole(
      id: 'hol_1',
      topicId: 'M1-NIJI-HANBETSU',
      description: '判別式を「なぜ」使うのか、で説明が止まった',
      severity: HoleSeverity.medium,
      status: HoleStatus.open,
      createdAt: DateTime.utc(2026, 8, 3, 13, 24, 7),
    ),
  ],
  termNotes: const <String>['「解の公式」と「判別式」が混ざっていた'],
);

const Progress sampleProgress = Progress(
  streakDays: 3,
  filledHoles: 4,
  openHoles: 2,
  lastSessionDate: '2026-08-03',
);

const ProgressSummary sampleSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: true),
);

/// Home on first launch, with nothing yet to count.
const ProgressSummary firstRunSummary = ProgressSummary(
  progress: Progress.empty,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: true),
);

/// Home on a day senpai has closed out.
///
/// The state with the longest copy on screen, so if anything overflows on a
/// narrow device it overflows here first.
const ProgressSummary exhaustedSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: false),
);

/// Home for a subscriber who can still start a lesson.
const ProgressSummary premiumSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: true,
  limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: true),
);

/// Premium's fair-use cap: it shows the closing line but must not show a billing
/// prompt.
const ProgressSummary premiumExhaustedSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: true,
  limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: false),
);

/// This month's report, as a parent reads it.
///
/// The quotes are the core of checking that the on-screen preview matches the
/// mail body, so they stay as the student phrased them rather than a summary.
final ParentReportResponse sampleParentReportResponse = ParentReportResponse(
  requiresPremium: false,
  report: ParentReport(
    period: ParentReportPeriod(
      startDate: DateTime(2026, 8),
      endDate: DateTime(2026, 8, 11),
    ),
    filledHoles: 4,
    streakDays: 3,
    explainedTopics: const <ParentReportTopic>[
      ParentReportTopic(topicId: 'M2-ZUKEI-ENCHOKU', name: '円と直線'),
      ParentReportTopic(topicId: 'M1-NIJI-HANBETSU', name: '二次方程式の判別式'),
    ],
    quotes: const <String>[
      '中心と直線の距離と半径を比べれば、交点の数が分かると説明できた',
      '判別式は、方程式を解き切る前に共有点の数を判断するために使う',
    ],
  ),
);

/// Subscribed.
///
/// The expiry is a fixed local date-time. `DateTime.utc` would shift the date by
/// a day depending on the runner's timezone and make goldens flap.
final Entitlement premiumEntitlement = Entitlement(
  isPremium: true,
  willRenew: true,
  expiresAt: DateTime(2026, 9, 8),
);

/// Cancelled, but usable until expiry.
final Entitlement cancelledEntitlement = Entitlement(
  isPremium: true,
  expiresAt: DateTime(2026, 9, 8),
);

/// In a free trial, with nothing paid yet.
///
/// Days left count from now, so the expiry is relative to now too — a fixed date
/// would start failing the moment it passed.
Entitlement trialEntitlement({int days = 7}) => Entitlement(
  isPremium: true,
  willRenew: true,
  isTrial: true,
  expiresAt: DateTime.now().add(Duration(days: days)),
);

final FilledHole sampleFilledHole = FilledHole(
  hole: Hole(
    id: 'hol_filled',
    topicId: 'M2-ZUKEI-ENCHOKU',
    description: '中心と直線の距離で判定する理由で説明が止まった',
    severity: HoleSeverity.medium,
    status: HoleStatus.filled,
    createdAt: DateTime.utc(2026, 7, 29, 12, 10),
    filledAt: DateTime.utc(2026, 8, 2, 13, 24, 7),
  ),
  daysSinceFilled: 1,
);

/// Review candidates for home. Older gaps are mixed in so the card is shown
/// picking recent content rather than a count.
final ReviewQueue sampleReviewQueue = ReviewQueue(
  items: <ReviewQueueItem>[
    ReviewQueueItem(
      hole: Hole(
        id: 'hol_old',
        topicId: 'M1-NIJI-GURAFU',
        description: '平方完成を「なぜ」するのか、で説明が止まった',
        severity: HoleSeverity.high,
        status: HoleStatus.open,
        createdAt: DateTime.utc(2026, 8, 1, 12, 10),
      ),
      daysSince: 3,
      prompt: '3日前の「平方完成のなぜ」、いまなら説明できますか?',
      quiz: '平方完成をする理由を説明できる?',
    ),
    ReviewQueueItem(
      hole: sampleKarte.holes.first,
      daysSince: 1,
      prompt: 'きのうの「判別式の意味」、もう一度きいてもいいですか?',
      quiz: '判別式を使うと解の個数がわかる理由を説明できる?',
    ),
  ],
);

// --- Provider overrides ---

class FakeProgressController extends ProgressController {
  FakeProgressController([this._summary = sampleSummary]);

  final ProgressSummary _summary;

  @override
  Future<ProgressSummary> build() async => _summary;
}

class FakeLatestKarteController extends LatestKarteController {
  FakeLatestKarteController([this._karte]);

  final Karte? _karte;

  @override
  Karte? build() => _karte ?? sampleKarte;
}

/// No karte yet; used for the celebration screen right after a conversation,
/// while generation is pending.
class EmptyLatestKarteController extends LatestKarteController {
  @override
  Karte? build() => null;
}

class FakeSessionOutcomeController extends SessionOutcomeController {
  FakeSessionOutcomeController(this._outcome, {this.karteArrives = false});

  final SessionOutcome _outcome;

  /// Whether fetching finds a karte.
  final bool karteArrives;

  @override
  SessionOutcome build() => _outcome;

  /// Stops the fetch here, so tests never reach the network.
  @override
  Future<bool> retrieveKarte() async => karteArrives;
}

class FakeReviewController extends ReviewController {
  FakeReviewController(
    this._queue, {
    this.queueAfterAnswer,
    this.answerSucceeds = true,
  });

  ReviewQueue _queue;

  /// Queue returned after answering; each test swaps in a next question or an
  /// empty state.
  ReviewQueue? queueAfterAnswer;
  bool answerSucceeds;

  /// Self-reports the screen sent; also confirms `notYet` was not sent.
  final List<(String, ReviewOutcome)> answerCalls = <(String, ReviewOutcome)>[];

  @override
  Future<ReviewQueue> build() async => _queue;

  /// Reproduces only the call and the post-answer queue, never hitting the API.
  @override
  Future<bool> answer(String holeId, ReviewOutcome outcome) async {
    answerCalls.add((holeId, outcome));
    if (!answerSucceeds) return false;

    final ReviewQueue? next = queueAfterAnswer;
    if (next != null) {
      _queue = next;
      state = AsyncValue<ReviewQueue>.data(next);
    }
    return true;
  }
}

class FakeParentReportController extends ParentReportController {
  FakeParentReportController(this._response);

  final ParentReportResponse _response;

  /// Pins the shared content so widget tests never reach the network.
  @override
  Future<ParentReportResponse> build() async => _response;
}

/// Overrides subscription state, so Premium screens can be built without the SDK.
class FakeEntitlementController extends EntitlementController {
  FakeEntitlementController(this._entitlement);

  final Entitlement _entitlement;

  @override
  Future<Entitlement> build() async => _entitlement;
}

/// The full set of overrides for building screens as Premium.
List<Object?> premiumOverrides([Entitlement? entitlement]) => <Object?>[
  entitlementControllerProvider.overrideWith(
    () => FakeEntitlementController(entitlement ?? premiumEntitlement),
  ),
];
