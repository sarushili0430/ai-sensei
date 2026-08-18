/// いまのUIを**実画面から**書き出して、一覧HTMLの材料にする。
///
/// ```bash
/// cd apps/mobile
/// fvm flutter test tool/generate_ui_overview.dart
/// node ../../scripts/build-ui-overview.mjs
/// ```
///
/// 出力(`docs/ui/screens/`):
///   *.png          1枚1状態。論理 393x852(iPhone 15 相当)を×2で焼く
///   manifest.json  並び順・ルート・実装ファイル・その状態を撮った理由
///
/// ストア素材(`generate_store_screenshots.dart`)と違い、**端末サイズを1つに
/// 絞る**。ここが見たいのは掲載映えではなく「いまアプリに何の画面があるか」で、
/// 同じ画面をサイズ違いで並べると一覧が読めなくなる。
///
/// golden(`test/golden/`)とも役割が違う。golden は差分検知なので撮る状態を
/// 増やしにくいが、ここは**人が眺めるため**なので、失敗・空・上限といった
/// 普段は見えない状態も並べる。撮り方(本物のWidgetツリーを描く)は同じ。
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/application/last_board_controller.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart' hide SessionLimits;
import 'package:ai_sensei/src/features/karte/domain/last_board.dart';
import 'package:ai_sensei/src/features/onboarding/presentation/onboarding_screen.dart';
import 'package:ai_sensei/src/features/parent_report/application/parent_report_controller.dart';
import 'package:ai_sensei/src/features/parent_report/domain/parent_report.dart';
import 'package:ai_sensei/src/features/plan/application/plan_controller.dart';
import 'package:ai_sensei/src/features/plan/domain/study_plan.dart';
import 'package:ai_sensei/src/features/session/application/board_inbox.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_style.dart';
import 'package:ai_sensei/src/features/session/presentation/celebration_screen.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/features/capture/presentation/capture_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/routing/routes.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/support/harness.dart';

const String _outDir = '../../docs/ui/screens';

/// 一覧の1枚。iPhone 15 の論理サイズ。
const Size _phone = Size(393, 852);

/// 板書パーツは画面ではないので、要素が読める最小の板で撮る。
const Size _boardTile = Size(360, 220);

const double _pixelRatio = 2;

const AppStrings _ja = AppStrings(Locale('ja'));

/// 撮る場所。**パスは直書きせず [AppRoute] から取る。**
/// 直書きすると、ルートを変えたときに一覧だけが古いパスを指したまま残る。
final String _home = AppRoute.home.path;
final String _plan = AppRoute.plan.path;
final String _settings = AppRoute.settings.path;
final String _karte = AppRoute.karte.path;
final String _review = AppRoute.review.path;
final String _parentReport = AppRoute.parentReport.path;
final String _paywall = AppRoute.paywall.path;
final String _thanks = AppRoute.thanks.path;

void main() {
  setUpAll(loadAppFonts);

  final List<Map<String, Object?>> manifest = <Map<String, Object?>>[];

  for (final _Shot shot in _shots) {
    testWidgets(shot.slug, (WidgetTester tester) async {
      final GlobalKey key = await _pump(tester, shot);
      await tester.runAsync(() async {
        final ui.Image image = await _capture(key);
        _write('$_outDir/${shot.slug}.png', await _png(image));
        manifest.add(<String, Object?>{
          'slug': shot.slug,
          'group': shot.group,
          'title': shot.title,
          'route': shot.route,
          'source': shot.source,
          'note': shot.note,
          'width': image.width,
          'height': image.height,
        });
      });
    });
  }

  // すべて撮り終わってから索引を書く。テストの実行順は宣言順なので、
  // manifest の並びがそのまま一覧の並びになる。
  tearDownAll(() {
    _write(
      '$_outDir/manifest.json',
      // 末尾に改行を入れる。biome(リポジトリのフォーマッタ)が
      // 改行なしのJSONを差分として出すので、入れないとlintが赤くなる。
      utf8.encode('${const JsonEncoder.withIndent('  ').convert(manifest)}\n'),
    );
  });
}

// --- レンダリング ---

Future<GlobalKey> _pump(WidgetTester tester, _Shot shot) async {
  final Size size = shot.size;
  await tester.binding.setSurfaceSize(size);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(() async {
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });

  // 端末に保存する設定を空から始める。test/ の外なので「テスト専用」の警告が
  // 出るが、これは widget test と同じ仕組みで画面を描く道具なので想定どおり。
  // ignore: invalid_use_of_visible_for_testing_member
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences preferences = await SharedPreferences.getInstance();
  final GlobalKey key = GlobalKey();

  final Widget? screen = shot.screen;
  if (screen != null) {
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: wrapApp(
          screen,
          overrides: <Object?>[
            preferencesProvider.overrideWithValue(preferences),
            ...shot.overrides,
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();
    await shot.act?.call(tester);
    await tester.pumpAndSettle();
    return key;
  }

  // 常設タブの下の画面は、**下部ナビゲーションごと**撮る。
  // 画面だけを home に置くと、実機に無い絵になる。
  final ProviderContainer container = ProviderContainer(
    overrides: <Object?>[
      preferencesProvider.overrideWithValue(preferences),
      onboardedProvider.overrideWithValue(true),
      deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
      // 既定の2つは**ここでしか渡さない。** Riverpod 3 は同じコンテナで
      // 同じプロバイダを二度差し替えると落ちるので、状態を変えたい shot は
      // `overrides` ではなく [_Shot.progress] / [_Shot.reviews] を書き換える。
      progressControllerProvider.overrideWith(() => FakeProgressController(shot.progress)),
      reviewControllerProvider.overrideWith(() => FakeReviewController(shot.reviews)),
      ...shot.overrides,
    ].cast(),
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(RepaintBoundary(key: key, child: wrapRouter(container)));
  await tester.pumpAndSettle();
  container.read(appRouterProvider).go(shot.route!);
  await tester.pumpAndSettle();
  await shot.act?.call(tester);
  await tester.pumpAndSettle();
  return key;
}

Future<ui.Image> _capture(GlobalKey key) {
  final RenderRepaintBoundary boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  return boundary.toImage(pixelRatio: _pixelRatio);
}

Future<Uint8List> _png(ui.Image image) async {
  final ByteData? data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

void _write(String path, List<int> bytes) {
  final File file = File(path);
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(bytes);
}

// --- 撮る状態の定義 ---

@immutable
class _Shot {
  const _Shot({
    required this.slug,
    required this.group,
    required this.title,
    required this.source,
    required this.note,
    this.screen,
    this.route,
    this.overrides = const <Object?>[],
    this.progress = firstRunSummary,
    this.reviews = const ReviewQueue(items: <ReviewQueueItem>[]),
    this.act,
    this.size = _phone,
  }) : assert(screen == null || route == null || true, 'シェル外の画面は screen、常設タブの下は route');

  final String slug;

  /// 一覧の見出し。線(オンボーディング/授業/常設/課金/板書)で束ねる。
  final String group;
  final String title;

  /// 実装ファイル。一覧から実物へ辿れるように必ず入れる。
  final String source;

  /// **なぜこの状態を撮るか。** 見た目の説明ではなく、画面が守っている約束。
  final String note;

  /// シェルの外の画面。`MaterialApp.home` に置く。
  final Widget? screen;

  /// 常設タブの下の画面。ルータ経由で撮る。[screen] と排他。
  final String? route;

  final List<Object?> overrides;

  /// ルータ経由で撮るときの進捗。**ここで渡す**(overrides に書くと二重差し替えで落ちる)。
  final ProgressSummary progress;

  /// 同じく復習キュー。
  final ReviewQueue reviews;

  /// 撮る前の操作(オンボーディングの2枚目以降など)。
  final Future<void> Function(WidgetTester tester)? act;

  final Size size;
}

// --- 差し替え ---

class _FakeSessionController extends SessionController {
  _FakeSessionController(this._state);

  final SessionState _state;

  @override
  SessionState build() => _state;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}
}

class _FakeCaptureController extends CaptureController {
  _FakeCaptureController([this._state = const CaptureState()]);

  final CaptureState _state;

  @override
  CaptureState build() => _state;

  /// 画面に入るたびに白紙へ戻す本物の [CaptureController.reset] を止める。
  /// 止めないと、解析済みの状態を渡しても撮影前の絵しか出てこない。
  @override
  void reset() {}
}

class _FakePlanController extends PlanController {
  _FakePlanController(this._state);

  final PlanState _state;

  @override
  PlanState build() => _state;

  @override
  Future<void> load() async {}
}

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

const SessionStart _sampleSessionStart = SessionStart(
  sessionId: 'ses_1',
  kind: 'realtime',
  livekit: LiveKitConnection(url: 'wss://example', token: 'token', room: 'room'),
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: true),
);

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
  problem: SessionProblem(
    text: 'x^2 - 3x + 2 = 0 の実数解の個数を求めよ。',
    source: ProblemSource.problemPhoto,
  ),
);

const BoardSnapshot _sampleBoard = BoardSnapshot(
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
      board: BoardElement.latex(tex: 'D = (-3)^2 - 4 \\cdot 1 \\cdot 2 = 1'),
    ),
  ],
);

/// 復習画面。埋めにいく穴が1つと、埋めた穴が1つ。両方が同じ画面に並ぶ。
final ReviewQueue _sampleReviewScreenQueue = ReviewQueue(
  items: <ReviewQueueItem>[
    ReviewQueueItem(
      hole: sampleKarte.holes.first,
      daysSince: 3,
      prompt: '3日前の「判別式のなぜ」、いまなら説明できますか?',
      quiz: '判別式を使うと解の個数がわかる理由を説明できる?',
    ),
  ],
  filled: <FilledHole>[sampleFilledHole],
);

const StudyPlan _samplePlan = StudyPlan(
  id: 'pln_1',
  createdAt: '2026-08-24T12:05:31.000Z',
  source: PlanSource.senpai,
  intake: PlanIntake(
    examName: '2学期の中間',
    examDate: '2026-09-10',
    scope: PlanScope(topicIds: <String>['M2-SANKAKU-KAHO'], said: '数IIの三角関数'),
    materials: <String>['4STEP'],
  ),
  days: <PlanDay>[
    PlanDay(
      date: '2026-09-06',
      items: <PlanItem>[
        PlanItem(
          topicId: 'M2-SANKAKU-KAHO',
          what: '加法定理の例題を一周',
          material: 0,
          minutes: 40,
          status: PlanItemStatus.done,
        ),
        PlanItem(
          topicId: 'M2-SANKAKU-KAHO',
          what: '間違えたところだけ、もう一度',
          material: 0,
          minutes: 20,
          status: PlanItemStatus.todo,
        ),
      ],
    ),
    PlanDay(date: '2026-09-07', items: <PlanItem>[]),
  ],
  revisions: <PlanRevision>[
    PlanRevision(
      at: '2026-09-05T20:14:02.000Z',
      reason: PlanRevisionReason.behind,
      said: '風邪ひいて3日できなかった',
    ),
  ],
);

/// 板書パーツ1つを、板の上に置いて撮る。
Widget _boardTileOf(BoardElement element) => ColoredBox(
  color: BoardStyle.surface,
  child: Padding(
    padding: const EdgeInsets.all(16),
    child: BoardElementView(element: element),
  ),
);

Future<void> _tapNext(WidgetTester tester) async {
  await tester.tap(find.text(_ja.onboardingNext));
  await tester.pumpAndSettle();
}

final List<_Shot> _shots = <_Shot>[
  // --- はじめて開いたとき ---
  const _Shot(
    slug: '01-onboarding-promise',
    group: 'はじめて開いたとき',
    title: 'オンボーディング(約束)',
    route: null,
    source: 'lib/src/features/onboarding/presentation/onboarding_screen.dart',
    note: '最初に伝えるのは機能ではなく約束。答えを教えないことを、使い始める前に置く。',
    screen: OnboardingScreen(),
  ),
  _Shot(
    slug: '02-onboarding-rehearsal',
    group: 'はじめて開いたとき',
    title: 'オンボーディング(リハーサル)',
    source: 'lib/src/features/onboarding/presentation/onboarding_rehearsal.dart',
    note: '答えは1文字も出ていない。出るのは問いと、説明する / 言えない の2つの道だけ。',
    screen: const OnboardingScreen(),
    act: (WidgetTester tester) async {
      await _tapNext(tester);
      await _tapNext(tester);
    },
  ),
  _Shot(
    slug: '03-onboarding-karte',
    group: 'はじめて開いたとき',
    title: 'オンボーディング(カルテの見本)',
    source: 'lib/src/features/onboarding/presentation/onboarding_karte_preview.dart',
    note: '止まった場所がピンクの穴として残る。責める言葉を置かず、また来ることを線で見せる。',
    screen: const OnboardingScreen(),
    act: (WidgetTester tester) async {
      await _tapNext(tester);
      await _tapNext(tester);
      await tester.tap(find.text(_ja.sessionPass));
      await tester.pumpAndSettle();
      await _tapNext(tester);
    },
  ),

  // --- 常設タブ ---
  _Shot(
    slug: '04-home-first-run',
    group: '常設タブ',
    title: 'ホーム(初回起動)',
    route: _home,
    source: 'lib/src/features/karte/presentation/home_screen.dart',
    note: '数えるものが何も無い日。空白にせず、次の一歩(撮る)だけを出す。',
  ),
  _Shot(
    slug: '05-home',
    group: '常設タブ',
    title: 'ホーム(続きがある)',
    route: _home,
    source: 'lib/src/features/karte/presentation/home_screen.dart',
    note: '数えるのは点数ではなく、続けた日数と埋めた穴。復習カードは件数ではなく単元の中身を出す。',
    progress: sampleSummary,
    reviews: sampleReviewQueue,
  ),
  _Shot(
    slug: '06-home-premium',
    group: '常設タブ',
    title: 'ホーム(Premium)',
    route: _home,
    source: 'lib/src/features/karte/presentation/home_screen.dart',
    note: '契約の印は右上に小さく。数えている2つ(連続日数・埋めた穴)を押し出さない。',
    progress: premiumSummary,
    reviews: sampleReviewQueue,
    overrides: <Object?>[...premiumOverrides()],
  ),
  _Shot(
    slug: '07-home-exhausted',
    group: '常設タブ',
    title: 'ホーム(今日はここまで)',
    route: _home,
    source: 'lib/src/features/karte/presentation/home_screen.dart',
    note: '今日の授業が終わった日。締めの言葉はいちばん長い文になるので、溢れるならまずここ。',
    progress: exhaustedSummary,
    reviews: sampleReviewQueue,
  ),
  _Shot(
    slug: '08-plan-empty',
    group: '常設タブ',
    title: '計画(まだ無い)',
    route: _plan,
    source: 'lib/src/features/plan/presentation/plan_screen.dart',
    note: 'フォームを置かない。計画は入力ではなく、声で作り始める。',
    overrides: <Object?>[
      planControllerProvider.overrideWith(
        () => _FakePlanController(const PlanState(phase: PlanPhase.ready)),
      ),
    ],
  ),
  _Shot(
    slug: '09-plan',
    group: '常設タブ',
    title: '計画(作成済み)',
    route: _plan,
    source: 'lib/src/features/plan/presentation/plan_screen.dart',
    note: '日付・科目・分数と、口頭で組み直す入口。終わった項目は事実として出すが、割合や点数は作らない。',
    overrides: <Object?>[
      planControllerProvider.overrideWith(
        () => _FakePlanController(const PlanState(phase: PlanPhase.ready, plan: _samplePlan)),
      ),
    ],
  ),
  _Shot(
    slug: '10-settings',
    group: '常設タブ',
    title: '設定',
    route: _settings,
    source: 'lib/src/features/settings/presentation/settings_screen.dart',
    note: '学校段階の切り替えと、契約の管理・復元、問い合わせ先。増やさないことが仕事の画面。',
  ),

  // --- 授業の線 ---
  _Shot(
    slug: '11-capture',
    group: '授業の線',
    title: '撮影(何を撮るか選ぶ)',
    source: 'lib/src/features/capture/presentation/capture_screen.dart',
    note: '入った瞬間にカメラを開かない。「ノートは無い」をシャッターの前に言える場所がここしかない。',
    screen: const CaptureScreen(),
    overrides: <Object?>[captureControllerProvider.overrideWith(_FakeCaptureController.new)],
  ),
  _Shot(
    slug: '12-capture-analyzed',
    group: '授業の線',
    title: '撮影(単元と問題文の確認)',
    source: 'lib/src/features/capture/presentation/capture_screen.dart',
    note: '解析の結果は確定ではない。検出した単元はチップで出し、外せるようにしてから始める。',
    screen: const CaptureScreen(),
    overrides: <Object?>[
      captureControllerProvider.overrideWith(
        () => _FakeCaptureController(
          const CaptureState(analysis: _sampleSessionAnalysis, session: _sampleSessionStart),
        ),
      ),
    ],
  ),
  _Shot(
    slug: '13-session-teaching',
    group: '授業の線',
    title: '授業(板書つき)',
    source: 'lib/src/features/session/presentation/session_screen.dart',
    note: 'コアループの中心。数式は板書に、声は問いかけだけ。板書は1問のあいだ生き続ける。',
    screen: const SessionScreen(),
    overrides: <Object?>[
      captureControllerProvider.overrideWith(
        () => _FakeCaptureController(
          const CaptureState(analysis: _sampleSessionAnalysis, session: _sampleSessionStart),
        ),
      ),
      sessionControllerProvider.overrideWith(
        () => _FakeSessionController(
          const SessionState(
            phase: SessionPhase.senpaiTeaching,
            remainingSeconds: 214,
            lastSenpaiText: 'ここ、D を見てほしいんだけど — プラスだよね。だから?',
            board: _sampleBoard,
          ),
        ),
      ),
    ],
  ),
  _Shot(
    slug: '14-session-explain-back',
    group: '授業の線',
    title: '授業(説明し返す番)',
    source: 'lib/src/features/session/presentation/session_screen.dart',
    note: '「じゃあ今の、説明してみて」。板書は残したまま、話す側が入れ替わる。',
    screen: const SessionScreen(),
    overrides: <Object?>[
      captureControllerProvider.overrideWith(
        () => _FakeCaptureController(
          const CaptureState(analysis: _sampleSessionAnalysis, session: _sampleSessionStart),
        ),
      ),
      sessionControllerProvider.overrideWith(
        () => _FakeSessionController(
          const SessionState(
            phase: SessionPhase.explainBack,
            remainingSeconds: 168,
            lastSenpaiText: 'じゃあ今の、自分の言葉で説明してみて。',
            board: _sampleBoard,
          ),
        ),
      ),
    ],
  ),
  _Shot(
    slug: '15-session-connecting',
    group: '授業の線',
    title: '授業(つないでいる)',
    source: 'lib/src/features/session/presentation/session_screen.dart',
    note: '先輩が入ってくるまでの数秒。空白にせず、待っていることを言葉にする。',
    screen: const SessionScreen(),
    overrides: <Object?>[
      captureControllerProvider.overrideWith(
        () => _FakeCaptureController(
          const CaptureState(analysis: _sampleSessionAnalysis, session: _sampleSessionStart),
        ),
      ),
      sessionControllerProvider.overrideWith(
        () => _FakeSessionController(
          const SessionState(phase: SessionPhase.connecting, remainingSeconds: 300),
        ),
      ),
    ],
  ),
  _Shot(
    slug: '16-celebration',
    group: '授業の線',
    title: '祝福',
    source: 'lib/src/features/session/presentation/celebration_screen.dart',
    note: '教え返せたことを祝う場所。点数を出さないので、祝うのは「言えた」という事実だけ。',
    screen: const CelebrationScreen(),
    overrides: <Object?>[
      progressControllerProvider.overrideWith(FakeProgressController.new),
      latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
    ],
  ),
  _Shot(
    slug: '17-karte',
    group: '授業の線',
    title: 'カルテ',
    route: _karte,
    source: 'lib/src/features/karte/presentation/karte_screen.dart',
    note: '言えたこと(黄)と、説明が止まった穴(ピンク)。先輩が書いた板書が根拠として残る。',
    overrides: <Object?>[
      latestKarteControllerProvider.overrideWith(FakeLatestKarteController.new),
      lastBoardControllerProvider.overrideWith(_FakeLastBoardController.new),
      sessionOutcomeControllerProvider.overrideWith(
        () => FakeSessionOutcomeController(const SessionOutcome()),
      ),
    ],
  ),

  // --- 戻ってくる線 ---
  _Shot(
    slug: '18-review',
    group: '戻ってくる線',
    title: '復習',
    route: _review,
    source: 'lib/src/features/karte/presentation/review_screen.dart',
    note: '埋めにいく穴と、埋めた穴が同じ画面に並ぶ。履歴のために別画面は作らない。',
    progress: premiumSummary,
    reviews: _sampleReviewScreenQueue,
    overrides: <Object?>[...premiumOverrides()],
  ),
  _Shot(
    slug: '19-parent-report',
    group: '戻ってくる線',
    title: '親レポート',
    route: _parentReport,
    source: 'lib/src/features/parent_report/presentation/parent_report_screen.dart',
    note: '送る本文を全部見せてから共有する。引用は本人の言葉のまま、点数や順位は作らない。',
    overrides: <Object?>[
      parentReportControllerProvider.overrideWith(
        () => FakeParentReportController(sampleParentReportResponse),
      ),
      ...premiumOverrides(),
    ],
  ),
  _Shot(
    slug: '20-parent-report-locked',
    group: '戻ってくる線',
    title: '親レポート(未契約)',
    route: _parentReport,
    source: 'lib/src/features/parent_report/presentation/parent_report_screen.dart',
    note: 'エラーではなく「まだ開いていない」。閉じている理由と開け方だけを出す。',
    overrides: <Object?>[
      parentReportControllerProvider.overrideWith(
        () => FakeParentReportController(ParentReportResponse.locked),
      ),
    ],
  ),

  // --- 課金 ---
  _Shot(
    slug: '21-paywall',
    group: '課金',
    title: 'ペイウォール',
    source: 'lib/src/features/monetization/presentation/paywall_screen.dart',
    note: '買わずに続ける道を必ず残す。金額はRevenueCatのOfferingから来るので、この撮影では読み込めていない状態で写る。',
    route: _paywall,
  ),
  _Shot(
    slug: '22-thanks',
    group: '課金',
    title: '購入のお礼',
    route: _thanks,
    source: 'lib/src/features/monetization/presentation/thanks_screen.dart',
    note: '祝っている画面でも、更新日と解約できることを消さない(App Store 3.1.2)。',
    overrides: <Object?>[...premiumOverrides()],
  ),

  // --- 板書パーツ ---
  _Shot(
    slug: '30-board-latex',
    group: '板書パーツ',
    title: 'latex(数式)',
    source: 'lib/src/features/session/presentation/board/latex_element_view.dart',
    note: '式は画像ではなく組版で描く。フォントが載っていないと四角(tofu)になるので、ここで見える。',
    screen: _boardTileOf(
      const BoardElement.latex(tex: r'D = (-3)^2 - 4 \cdot 1 \cdot 2 = 9 - 8 = 1'),
    ),
    size: _boardTile,
  ),
  _Shot(
    slug: '31-board-text',
    group: '板書パーツ',
    title: 'text(そのまま書く)',
    source: 'lib/src/features/session/presentation/board/text_element_view.dart',
    note: '式にしない短い事実(係数の確認など)。チョーク色は板の上でしか読めない。',
    screen: _boardTileOf(const BoardElement.text(body: 'a = 1, b = -3, c = 2')),
    size: _boardTile,
  ),
  _Shot(
    slug: '32-board-plot',
    group: '板書パーツ',
    title: 'plot(グラフ)',
    source: 'lib/src/features/session/presentation/board/plot_painter.dart',
    note: '関数と印。答えの数値ではなく、どこで交わるかを見せるために置く。',
    screen: _boardTileOf(
      const BoardElement.plot(
        fn: 'x^2 - 3*x + 2',
        domain: BoardDomain(min: -1, max: 4),
        marks: <PlotMark>[
          PlotMark(at: BoardPoint(x: 1, y: 0), label: 'x = 1'),
          PlotMark(at: BoardPoint(x: 2, y: 0), label: 'x = 2'),
        ],
      ),
    ),
    size: _boardTile,
  ),
  _Shot(
    slug: '33-board-triangle',
    group: '板書パーツ',
    title: 'triangle(三角形)',
    source: 'lib/src/features/session/presentation/board/triangle_painter.dart',
    note: '頂点名・直角マーク・角のマーク。図形の話を言葉だけで進めないための最小の絵。',
    screen: _boardTileOf(
      const BoardElement.triangle(
        vertices: <BoardPoint>[
          BoardPoint(x: 0, y: 0),
          BoardPoint(x: 4, y: 0),
          BoardPoint(x: 0, y: 3),
        ],
        labels: <String>['A', 'B', 'C'],
        marks: <AngleMark>[
          AngleMark(vertex: 0, kind: AngleMarkKind.rightAngle),
          AngleMark(vertex: 1, kind: AngleMarkKind.angle, label: 'θ'),
        ],
      ),
    ),
    size: _boardTile,
  ),
  _Shot(
    slug: '34-board-circle',
    group: '板書パーツ',
    title: 'circle(円)',
    source: 'lib/src/features/session/presentation/board/circle_painter.dart',
    note: '中心と半径のラベル。円と直線の位置関係を、距離の比較として描くために使う。',
    screen: _boardTileOf(
      const BoardElement.circle(
        center: BoardPoint(x: 0, y: 0),
        r: 5,
        labels: <String>['O', 'r = 5'],
      ),
    ),
    size: _boardTile,
  ),
  _Shot(
    slug: '35-board-sentence',
    group: '板書パーツ',
    title: 'sentence(英文)',
    source: 'lib/src/features/session/presentation/board/sentence_element_view.dart',
    note: '英語の板書。focus に下線を引き、訳ではなく「どこを見るか」を示す。',
    screen: _boardTileOf(
      const BoardElement.sentence(
        text: 'I have lived here for ten years.',
        gloss: '10年間ここに住んでいる(今も)',
        focus: 'have lived',
      ),
    ),
    size: _boardTile,
  ),
  _Shot(
    slug: '36-board-compare',
    group: '板書パーツ',
    title: 'compare(対比表)',
    source: 'lib/src/features/session/presentation/board/compare_element_view.dart',
    note: '2つの違いを並べる。列は等分で、どちらが「正解」かは書かない。',
    screen: _boardTileOf(
      const BoardElement.compare(
        title: '現在完了 と 過去形',
        columns: <String>['現在完了', '過去形'],
        rows: <List<String>>[
          <String>['have + 過去分詞', '過去形'],
          <String>['今とつながっている', '今のことは言っていない'],
        ],
      ),
    ),
    size: _boardTile,
  ),
];
