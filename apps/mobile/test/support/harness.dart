import 'dart:convert';

import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// テストで画面を組み立てるための足場。
///
/// 本番の `AiSenseiApp` と同じデリゲートを渡す。ここを削ると
/// 「MaterialLocalizations が ja に対応していない」で落ちる。
///
/// `overrides` を `List<Object?>` で受けているのは、Riverpod 3 が `Override` 型を
/// 公開APIに出していないため。`cast()` の型は ProviderScope 側から推論される。
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

/// テスト用の `SharedPreferences`。
///
/// 本番は main() が起動時に読んで差し込む。保存された設定を見る画面
/// (言語を持つ設定画面)を組み立てるときは、これを `overrides` に足す。
/// 忘れると `preferencesProvider` が UnimplementedError を投げる —— 黙って
/// 既定値で動かないのは、**差し込み忘れに気づけるようにする**ため。
Future<Object?> preferencesOverride([
  Map<String, Object> values = const <String, Object>{},
]) async {
  SharedPreferences.setMockInitialValues(values);
  return preferencesProvider.overrideWithValue(await SharedPreferences.getInstance());
}

/// テストのあいだ、装飾のアニメーションを止める。
///
/// 端末の「アニメーションを減らす」と同じ経路(`AppMotion`)を通すので、
/// 入場アニメーションは**終わった状態**で描かれ、呼吸やまばたきのような
/// ループは始まらない。goldenが撮った瞬間で変わらなくなり、
/// `pumpAndSettle` も返る。
///
/// 逆に言うと、ここを通していないアニメーションを足すと
/// `pumpAndSettle` が返らずにテストが落ちる。それが検知そのものになる。
Widget reduceMotion(BuildContext context, Widget? child) {
  return MediaQuery(
    data: MediaQuery.of(context).copyWith(disableAnimations: true),
    child: child ?? const SizedBox.shrink(),
  );
}

/// 端末側の「アニメーションを減らす」を立てる。
///
/// [reduceMotion] は `MaterialApp.builder` に差し込む形なので、**自分で
/// MaterialApp を作るウィジェット**(本物の `AiSenseiApp`)には届かない。
/// そちらはOSの設定と同じ経路(accessibilityFeatures)から入れる。
/// 立てないと後輩の呼吸が回りつづけて `pumpAndSettle` が返らない。
void reduceMotionOnDevice(WidgetTester tester) {
  tester.platformDispatcher.accessibilityFeaturesTestValue =
      const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

/// 端末の言語を差し替える。
///
/// テストの既定は en-US。`wrapApp` は `locale` を直接渡すので関係ないが、
/// 端末の言語から解決させる経路(本物の `AiSenseiApp`)ではこれが要る。
void useDeviceLocale(WidgetTester tester, Locale locale) {
  tester.platformDispatcher.localesTestValue = <Locale>[locale];
  tester.platformDispatcher.localeTestValue = locale;
  addTearDown(() {
    tester.platformDispatcher.clearLocalesTestValue();
    tester.platformDispatcher.clearLocaleTestValue();
  });
}

/// 本物のルータで組み立てる。
///
/// 画面単体では見えない「戻れるか」を見るために使う。`go` と `push` の
/// 使い分けとルートの入れ子が壊れると、行き止まりはここで落ちる。
///
/// ルータを先に取り出せるように、コンテナは呼び出し側で作って渡す。
/// `ProviderScope` で作り直すと、ルータの `redirect` が見ている provider と
/// 画面が見ている provider が別のコンテナになってしまう。
Widget wrapRouter(ProviderContainer container) {
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      locale: const Locale('ja'),
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

/// 画面を組み立てて、描画が落ち着くまで進める。
///
/// GlobalMaterialLocalizations のデリゲートは**非同期に読み込まれる**ので、
/// pumpWidget の1フレーム目には本文がまだ出ていない。ここを忘れると
/// 「Found 0 widgets」で落ちる。
Future<void> pumpApp(
  WidgetTester tester,
  Widget child, {
  List<Object?> overrides = const <Object?>[],
}) async {
  await tester.pumpWidget(wrapApp(child, overrides: overrides));
  await tester.pumpAndSettle();
}

/// golden test の描画サイズ。iPhone 15 相当の論理ピクセル。
const Size goldenSurface = Size(393, 852);

/// 実フォントを読み込む。
///
/// widget test は既定でAhem(四角)で描画するので、そのままgoldenを撮ると
/// 字形の崩れに気づけない。丸ゴシックはブランドの一部なので実物を読ませる。
///
/// パスを直書きせず FontManifest から読むのは、**MaterialIcons も一緒に
/// 載せる**ため。アイコンが四角のままだと、戻るボタンや設定アイコンが
/// 出ているかどうかを golden で確かめられない(導線が消えても気づけない)。
Future<void> loadAppFonts() async {
  final String manifest = await rootBundle.loadString('FontManifest.json');

  for (final dynamic entry in jsonDecode(manifest) as List<dynamic>) {
    final Map<String, dynamic> family = entry as Map<String, dynamic>;
    // `packages/foo/MyFont` 形式で入っていることがある。実際の family 名は末尾。
    final String name = (family['family'] as String).split('/').last;

    final FontLoader loader = FontLoader(name);
    for (final dynamic font in family['fonts'] as List<dynamic>) {
      loader.addFont(rootBundle.load((font as Map<String, dynamic>)['asset'] as String));
    }
    await loader.load();
  }
}

/// golden用にサイズを固定する。端末差でgoldenが揺れないように。
Future<void> setGoldenSurface(WidgetTester tester, {Size size = goldenSurface}) async {
  await tester.binding.setSurfaceSize(size);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() async {
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

// --- テスト用のデータ ---

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
  openHoles: 1,
  lastSessionDate: '2026-08-03',
);

const ProgressSummary sampleSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 300, remainingSessionsToday: 1),
);

/// 初回起動のホーム。数えるものが何も無い状態。
const ProgressSummary firstRunSummary = ProgressSummary(
  progress: Progress.empty,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 300, remainingSessionsToday: 1),
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

// --- プロバイダの差し替え ---

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

/// カルテがまだ手元に無い状態。会話直後(生成待ち)の祝福画面で使う。
class EmptyLatestKarteController extends LatestKarteController {
  @override
  Karte? build() => null;
}

class FakeSessionOutcomeController extends SessionOutcomeController {
  FakeSessionOutcomeController(this._outcome, {this.karteArrives = false});

  final SessionOutcome _outcome;

  /// 取りに行ったらカルテがあるか。
  final bool karteArrives;

  @override
  SessionOutcome build() => _outcome;

  /// 取りに行くのをここで止める。テストからネットワークへ出さないため。
  @override
  Future<bool> retrieveKarte() async => karteArrives;
}

class FakeReviewController extends ReviewController {
  FakeReviewController(this._queue);

  final ReviewQueue _queue;

  @override
  Future<ReviewQueue> build() async => _queue;
}
