import 'dart:convert';

import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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
///
/// ## 寸法を必ず固定する
///
/// **widget test の既定は 800×600 で、どの端末でもない横長。**
/// 縦が実機より250pt以上短いので、画面の下のほうにあるボタンがビューポートの
/// 外に出る。そして `tap` は画面外の座標を叩いても**例外にならず、静かに何も
/// 起きない** —— テストは通るのに操作が届いていない状態ができる。
///
/// 実際、オンボーディングでこれが起きた。「うまく言えない」が折り返しの下に
/// 落ちたあとも3本のテストが緑のままで、**板書を積んで画面が伸びたことに
/// 誰も気づけなかった**。既定を実機の寸法にしておけば、同じ壊れ方は
/// 「ボタンが見つからない」として落ちる。
Future<void> pumpApp(
  WidgetTester tester,
  Widget child, {
  List<Object?> overrides = const <Object?>[],
  Locale locale = const Locale('ja'),
  Size size = phoneSurface,
}) async {
  await setSurface(tester, size: size);
  await tester.pumpWidget(wrapApp(child, overrides: overrides, locale: locale));
  await tester.pumpAndSettle();
}

/// 既定の描画サイズ。iPhone 15 相当の論理ピクセル。
///
/// golden もこの寸法で撮る(だから以前は `goldenSurface` という名前だった)が、
/// **golden 専用の値ではない。** 名前が golden 専用に見えると、
/// 普通の widget test で寸法を固定する動機が消えてしまう。
const Size phoneSurface = Size(393, 852);

/// いちばん狭い実機(iPhone SE 級)。
///
/// 折り返しの下に操作が落ちていないかは、この寸法で見る。
/// [phoneSurface] で収まっても、ここで溢れる画面がある。
const Size smallPhoneSurface = Size(375, 667);

/// 実フォントを読み込む。
///
/// widget test は既定でAhem(四角)で描画するので、そのままgoldenを撮ると
/// 字形の崩れに気づけない。丸ゴシックはブランドの一部なので実物を読ませる。
///
/// パスを直書きせず FontManifest から読むのは、**MaterialIcons も一緒に
/// 載せる**ため。アイコンが四角のままだと、戻るボタンや設定アイコンが
/// 出ているかどうかを golden で確かめられない(導線が消えても気づけない)。
///
/// **family名はプレフィックスを剥がさず、そのまま登録する。**
/// 以前は `packages/foo/MyFont` 形式のとき末尾だけ取り出していたが、これは
/// このアプリ自身のフォント(`ZenMaruGothic`。プレフィックス無し)にしか
/// 当てはまらない前提だった。サードパーティのフォントパッケージ(例:
/// `flutter_math_fork` のKaTeXフォント一式)は、パッケージ自身のコードの中で
/// `'packages/flutter_math_fork/KaTeX_Main'` のようにプレフィックス込みの
/// family名で参照している(該当パッケージの `make_symbol.dart` で確認済み)。
/// 剥がして登録すると、その名前で探しにいくwidgetからは見つからず、
/// フォントが無いのと同じ状態(golden上は黒塗りの四角=tofu)になる。
/// `FontManifest.json` を実際に読ませて確認したところ、`MaterialIcons` と
/// `ZenMaruGothic` はもともとプレフィックスを持たないので、剥がすのをやめても
/// 既存のgoldenの見た目は変わらない(登録名がそのまま変わらないため)。
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

/// 描画サイズを固定する。
///
/// golden では端末差で絵が揺れないように、普通の widget test では
/// **既定の 800×600(どの端末でもない横長)で走らせないように**使う。
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

/// 実時間と擬似時間を交互に進めて、[finder] が現れるまで待つ。
///
/// ## `pumpAndSettle` が返らなくなる形
///
/// **「スピナーを出しているあいだに、未解決の非同期がある」**と固まる。
/// `CircularProgressIndicator` は終わらないアニメーションなので
/// `pumpAndSettle` は「まだフレームが来る」と判断して回り続け、
/// その裏の非同期は擬似時間では進まない。踏んだ例が2つある:
///
///   - **multipart の送信。** `MockClient` は本文を組み立てるときに
///     **実際にファイルを読む**。これは `runAsync` の中でしか進まない
///     (素の `test()` で書かれたテストが平気なのは、最初から実時間だから)
///   - **`permission_handler` の照会。** チャンネルを差し替えていないと
///     応答が返らず、許可を待つあいだスピナーが回り続ける
///     → こちらは [mockPermissionHandler] で塞ぐ
///
/// だから `pumpAndSettle` ではなく、**実時間([WidgetTester.runAsync])と
/// 擬似時間([WidgetTester.pump])を交互に**進めて、目印が出たら止める。
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

/// `permission_handler` のチャンネルを差し替える。
///
/// **差し替えないと照会が返ってこない。** 許可を待つあいだ画面に出ているのが
/// スピナーだと、そのまま `pumpAndSettle` が返らなくなる([pumpUntil] 参照)。
/// 実機では必ず答えが返る問い合わせなので、テストでも返す。
///
/// [status] は `PermissionStatus` の並び順(0=denied / 1=granted / 2=restricted /
/// 3=limited / 4=permanentlyDenied)。既定は granted。
void mockPermissionHandler({int status = permissionGranted}) {
  const MethodChannel channel = MethodChannel('flutter.baseflow.com/permissions/methods');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async => status);
  addTearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );
}

/// `PermissionStatus.granted`(enum の2番目)。
const int permissionGranted = 1;

/// `PermissionStatus.denied`(enum の先頭)。
const int permissionDenied = 0;

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
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: true),
);

/// 初回起動のホーム。数えるものが何も無い状態。
const ProgressSummary firstRunSummary = ProgressSummary(
  progress: Progress.empty,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: true),
);

/// 今日はもう授業をしない日のホーム(§6-3「先輩の判断」)。
///
/// **いちばん長い文が出る状態。** 「今日はここまでにしよっか。詰め込みすぎても
/// 入らないから、明日また続きやろう」が画面に乗るので、
/// 狭い端末で溢れるならまずここから溢れる。
const ProgressSummary exhaustedSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: false,
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: false),
);

/// 契約している人のホーム。授業可否は常に true で返る。
///
/// entitlement だけ Premium にして進捗を無料のままにすると、
/// 「Premium の印」と「今日はここまで」が同じ画面に並ぶ。
/// 実機では起きない組み合わせなので、golden に写してはいけない。
const ProgressSummary premiumSummary = ProgressSummary(
  progress: sampleProgress,
  isPremium: true,
  limits: SessionLimits(maxSeconds: 300, lessonAllowedToday: true),
);

/// 契約している状態。
///
/// 期限は固定の**ローカル日時**にする。`DateTime.utc` にすると、走らせる
/// 端末のタイムゾーン次第で日付が1日ずれて golden が揺れる。
final Entitlement premiumEntitlement = Entitlement(
  isPremium: true,
  willRenew: true,
  expiresAt: DateTime(2026, 9, 8),
);

/// 解約予約済み。期限までは使える。
final Entitlement cancelledEntitlement = Entitlement(
  isPremium: true,
  expiresAt: DateTime(2026, 9, 8),
);

/// 無料トライアル中。**まだ1円も払っていない。**
///
/// 残り日数は「今から」数えるので、期限も今からの相対で作る
/// (固定日にすると、その日を過ぎた瞬間にテストが落ちる)。
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

/// 契約の状態を差し替える。SDKを呼ばずに Premium の画面を組むために使う。
class FakeEntitlementController extends EntitlementController {
  FakeEntitlementController(this._entitlement);

  final Entitlement _entitlement;

  @override
  Future<Entitlement> build() async => _entitlement;
}

/// Premium で画面を組むときの差し替え一式。
List<Object?> premiumOverrides([Entitlement? entitlement]) => <Object?>[
  entitlementControllerProvider.overrideWith(
    () => FakeEntitlementController(entitlement ?? premiumEntitlement),
  ),
];
