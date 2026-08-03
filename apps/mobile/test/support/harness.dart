import 'dart:io';

import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
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
Widget wrapApp(Widget child, {List<Object?> overrides = const <Object?>[]}) {
  return ProviderScope(
    overrides: overrides.cast(),
    child: MaterialApp(
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
      home: child,
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
Future<void> loadAppFonts() async {
  final FontLoader loader = FontLoader('ZenMaruGothic');
  for (final String path in <String>[
    'assets/fonts/ZenMaruGothic-Regular.ttf',
    'assets/fonts/ZenMaruGothic-Bold.ttf',
  ]) {
    final Uint8List bytes = await File(path).readAsBytes();
    loader.addFont(Future<ByteData>.value(ByteData.view(bytes.buffer)));
  }
  await loader.load();
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

// --- プロバイダの差し替え ---

class FakeProgressController extends ProgressController {
  @override
  Future<Progress> build() async => sampleProgress;
}

class FakeLatestKarteController extends LatestKarteController {
  @override
  Karte? build() => sampleKarte;
}

class FakeSessionOutcomeController extends SessionOutcomeController {
  FakeSessionOutcomeController(this._outcome);

  final SessionOutcome _outcome;

  @override
  SessionOutcome build() => _outcome;
}

class FakeReviewController extends ReviewController {
  FakeReviewController(this._queue);

  final ReviewQueue _queue;

  @override
  Future<ReviewQueue> build() async => _queue;
}
