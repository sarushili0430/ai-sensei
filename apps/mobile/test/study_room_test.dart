import 'dart:convert';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/capture/presentation/capture_screen.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/presentation/home_screen.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/features/study_room/application/last_board_controller.dart';
import 'package:ai_sensei/src/features/study_room/domain/last_board.dart';
import 'package:ai_sensei/src/features/study_room/domain/senpai_nudge.dart';
import 'package:ai_sensei/src/features/study_room/presentation/study_room_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/harness.dart';

/// 自習室(計画書§4-2)。
///
/// golden は**置かない**(計画書§10-8。比較対象のPNGはCI/Linuxで作るので、
/// 手元で撮ったものを一緒にコミットするとCIが落ちる)。ここで見るのは見た目ではなく、
/// このモードが無料である根拠と、そこから出られることのほう。
///
/// いちばん効いているのは「組める」の1本。自習室のタイマーは1秒ごとに
/// フレームを積むループなので、`AppMotion` の経路を通し忘れると
/// `pumpAndSettle` が永遠に返らなくなる。落ちれば通し忘れたと分かる。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));

  /// 板書を手元に置いた状態を作る。
  ///
  /// 本番で書き込むのは授業(`SessionController._applyBoard`)の1か所だけ。
  /// ここで見るのは書き込み口ではなく、**残った板書をどう見せるか**。
  List<Object?> boardOverrides(LastBoard board) => <Object?>[
        lastBoardControllerProvider.overrideWith(() => _FakeLastBoardController(board)),
      ];

  const BoardStep sampleStep = BoardStep(
    index: 0,
    speech: 'ここ、Dを見てほしいんだけど',
    // 数式ではなく text にしてあるのは、フォントを読み込まない widget test で
    // LaTeX が tofu になっても意味のある検証にならないため(計画書§3-6c)。
    board: BoardElement.text(body: '解が2つ ⇔ D > 0'),
  );

  group('先輩の声かけ', () {
    // 声かけは経過時間から引く純関数。**タイマーを増やさない**ための形なので、
    // ここが壊れると「声かけのための別のTimer」を足したくなる。
    test('経過時間だけで決まる', () {
      expect(SenpaiNudge.forElapsed(Duration.zero), SenpaiNudge.start);
      expect(SenpaiNudge.forElapsed(const Duration(minutes: 9)), SenpaiNudge.start);
      expect(SenpaiNudge.forElapsed(const Duration(minutes: 10)), SenpaiNudge.going);
      expect(SenpaiNudge.forElapsed(const Duration(minutes: 25)), SenpaiNudge.takeABreak);
      expect(SenpaiNudge.forElapsed(const Duration(minutes: 50)), SenpaiNudge.longHaul);
      expect(SenpaiNudge.forElapsed(const Duration(hours: 3)), SenpaiNudge.longHaul);
    });
  });

  group('自習室', () {
    testWidgets('動かさない設定でも組める(タイマーがAppMotionを通っている)', (WidgetTester tester) async {
      // ここで返ってこなければ、1秒ごとのループが `AppMotion` を通っていない。
      await pumpApp(tester, const StudyRoomScreen());

      expect(find.byType(StudyRoomScreen), findsOneWidget);
      expect(find.text(ja.studyRoomElapsed(0)), findsOneWidget);
    });

    testWidgets('マイクを開いていないことを、黙っていないで書く', (WidgetTester tester) async {
      // この一行が無料である根拠(§4-2)そのもの。先輩が隣にいる画面は、
      // 聞かれていると誤解されうる形をしている。
      await pumpApp(tester, const StudyRoomScreen());
      expect(find.text(ja.studyRoomMicOff), findsOneWidget);
    });

    testWidgets('板書が無くても空白にしない', (WidgetTester tester) async {
      await pumpApp(tester, const StudyRoomScreen());

      expect(find.text(ja.studyRoomBoardEmpty), findsOneWidget);
      expect(find.byType(BoardView), findsNothing);
    });

    testWidgets('さっきの板書が残っている', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: boardOverrides(const LastBoard(steps: <BoardStep>[sampleStep])),
      );

      expect(find.byType(BoardView), findsOneWidget);
      expect(find.text('解が2つ ⇔ D > 0'), findsOneWidget);
      expect(find.text(ja.studyRoomBoardEmpty), findsNothing);
      expect(find.text(ja.studyRoomBoardTruncated), findsNothing);
    });

    /// 板書の実効幅は、授業モードと同じでなければならない。
    ///
    /// `BoardStyle.latexMinScale`(70%)は**実効幅340pt**での実測から決めた値
    /// (計画書§3-6b)。自習室で板書をカードに入れると 345pt → 311pt まで落ち、
    /// 実測では縮小して収まった式が横スクロールに落ちる。**落ちたことは
    /// `debugPrint` にしか出ず見た目では気づけない**ので、幅で見張る。
    /// `session_board_test.dart` の同名の見張りと対になっている。
    testWidgets('板書の実効幅は、実測の前提(340pt)を下回らない', (WidgetTester tester) async {
      await setSurface(tester);
      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: boardOverrides(const LastBoard(steps: <BoardStep>[sampleStep])),
      );

      expect(tester.getSize(find.byType(BoardView)).width, greaterThanOrEqualTo(340));
    });

    // 配送が欠落した板書は、手順の列だけ見ても健全なものと区別がつかない。
    // 黙って出すと、計画書§3-6b が横スクロールを却下した理由
    // 「これで全部だ」と誤読させる — をそのまま再現する。
    testWidgets('とぎれた板書は、とぎれていると分かる', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: boardOverrides(
          const LastBoard(steps: <BoardStep>[sampleStep], truncated: true),
        ),
      );

      expect(find.text('解が2つ ⇔ D > 0'), findsOneWidget, reason: '書かれた行は消さない');
      expect(find.text(ja.studyRoomBoardTruncated), findsOneWidget);
    });

    // 手順が1つも無いのに「ここから先は残っていません」だけが出ると、
    // 何も起きていないのに壊れて見える。
    testWidgets('空の板書には、とぎれた印を出さない', (WidgetTester tester) async {
      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: boardOverrides(const LastBoard(truncated: true)),
      );

      expect(find.text(ja.studyRoomBoardEmpty), findsOneWidget);
      expect(find.text(ja.studyRoomBoardTruncated), findsNothing);
    });

    testWidgets('先輩を呼ぶ導線がある(ここが課金の切れ目)', (WidgetTester tester) async {
      await pumpApp(tester, const StudyRoomScreen());
      expect(find.text(ja.studyRoomAsk), findsOneWidget);
    });

    testWidgets('バックグラウンド化とdisposeが重なっても1回だけ送る', (WidgetTester tester) async {
      DateTime now = DateTime(2026, 8, 3, 21);
      final List<http.Request> calls = <http.Request>[];
      final MockClient server = MockClient((http.Request request) async {
        calls.add(request);
        return http.Response('', 204);
      });
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed),
      );

      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: <Object?>[
          studyRoomClockProvider.overrideWithValue(() => now),
          apiClientProvider.overrideWithValue(
            ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: server),
          ),
        ],
      );

      // 1秒未満の訪問は契約上送れない。そこで最初の訪問は閉じるが、resumedで
      // 新しい訪問を始めるので、戻ったあとの95秒は次の退室で残せる。
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(calls, isEmpty);

      now = now.add(const Duration(minutes: 1, seconds: 35));

      // 非表示への状態遷移と、その後の親ルート差し替えによるdisposeが重なっても
      // 同じ退室は1件だけ。OSごとの通知順に依存させない。
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();

      expect(calls, hasLength(1));
      expect(calls.single.url.path, '/v1/me/study-room');
      expect(calls.single.headers['idempotency-key'], matches(RegExp(r'^[0-9a-f-]{36}$')));
      expect(jsonDecode(calls.single.body), <String, dynamic>{
        'duration_seconds': 95,
        'visited_on': '2026-08-03',
      });
    });

    testWidgets('1秒未満で離れた訪問を、背後の時間で水増ししない',
        (WidgetTester tester) async {
      DateTime now = DateTime(2026, 8, 3, 21);
      final List<http.Request> calls = <http.Request>[];
      final MockClient server = MockClient((http.Request request) async {
        calls.add(request);
        return http.Response('', 204);
      });
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed),
      );

      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: <Object?>[
          studyRoomClockProvider.overrideWithValue(() => now),
          apiClientProvider.overrideWithValue(
            ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: server),
          ),
        ],
      );

      // 0秒の訪問はPOSTしない。ただし閉じた印を残さないと、この30分後の
      // disposeが「自習していた30分」として誤送信してしまう。
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      now = now.add(const Duration(minutes: 30));
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();

      expect(calls, isEmpty);
    });

    testWidgets('計測の送信に失敗しても自習室を壊さない', (WidgetTester tester) async {
      DateTime now = DateTime(2026, 8, 3, 21);
      final MockClient server = MockClient(
        (_) async => http.Response(
          '{"error":{"code":"internal_error","message":"temporary"}}',
          500,
          headers: <String, String>{'content-type': 'application/json'},
        ),
      );
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed),
      );

      await pumpApp(
        tester,
        const StudyRoomScreen(),
        overrides: <Object?>[
          studyRoomClockProvider.overrideWithValue(() => now),
          apiClientProvider.overrideWithValue(
            ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: server),
          ),
        ],
      );
      now = now.add(const Duration(minutes: 5));

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.byType(StudyRoomScreen), findsOneWidget);
      expect(find.text(ja.studyRoomMicOff), findsOneWidget);
    });
  });

  group('導線', () {
    ProviderContainer navigationContainer({
      required DateTime Function() clock,
      required List<http.Request> calls,
    }) {
      final MockClient server = MockClient((http.Request request) async {
        calls.add(request);
        return http.Response('', 204);
      });
      final ProviderContainer container = ProviderContainer(
        overrides: <Object?>[
          onboardedProvider.overrideWithValue(true),
          deviceIdProvider.overrideWithValue('dev_test'),
          progressControllerProvider.overrideWith(FakeProgressController.new),
          reviewControllerProvider.overrideWith(() => FakeReviewController(sampleReviewQueue)),
          studyRoomClockProvider.overrideWithValue(clock),
          apiClientProvider.overrideWithValue(
            ApiClient(baseUrl: 'http://test', deviceId: 'dev_test', client: server),
          ),
        ].cast(),
      );
      addTearDown(container.dispose);
      return container;
    }

    testWidgets('下タブでホーム → 自習室 → ホームへ戻れる', (WidgetTester tester) async {
      // 自習室は独立した常設の枝になった。戻り先をNavigatorの履歴で捏造せず、
      // 下タブと明示的な「自習室を出る」のどちらからもホームへ帰れるようにする。
      DateTime now = DateTime(2026, 8, 3, 21);
      final List<http.Request> calls = <http.Request>[];
      final ProviderContainer container = navigationContainer(
        clock: () => now,
        calls: calls,
      );

      await tester.pumpWidget(wrapRouter(container));
      await tester.pumpAndSettle();

      await tester.tap(find.text(ja.homeStudyRoom));
      await tester.pumpAndSettle();
      expect(find.byType(StudyRoomScreen), findsOneWidget);

      now = now.add(const Duration(minutes: 3));
      await tester.tap(find.text(ja.studyRoomLeave));
      await tester.pumpAndSettle();
      expect(find.byType(HomeScreen), findsOneWidget);
      // ボタン・PopScope・disposeの3経路が同じpopを見ても、送るのは1回だけ。
      expect(calls, hasLength(1));
      expect(jsonDecode(calls.single.body), containsPair('duration_seconds', 3 * 60));
    });

    testWidgets('タブを離れた時間を混ぜず、戻るたび新しい訪問にする',
        (WidgetTester tester) async {
      DateTime now = DateTime(2026, 8, 3, 21);
      final List<http.Request> calls = <http.Request>[];
      final ProviderContainer container = navigationContainer(
        clock: () => now,
        calls: calls,
      );

      await tester.pumpWidget(wrapRouter(container));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('navigation-study-room')));
      await tester.pumpAndSettle();

      now = now.add(const Duration(minutes: 2));
      await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
      await tester.pumpAndSettle();
      expect(calls, hasLength(1));
      expect(jsonDecode(calls[0].body), containsPair('duration_seconds', 2 * 60));
      final String firstVisitId = calls[0].headers['idempotency-key']!;

      // ホームを見ていた30分は自習ではない。枝のStateは残っていても、
      // 戻った瞬間の表示と次のPOSTは0から始まる必要がある。
      now = now.add(const Duration(minutes: 30));
      await tester.tap(find.byKey(const ValueKey<String>('navigation-study-room')));
      await tester.pumpAndSettle();
      expect(find.text(ja.studyRoomElapsed(0)), findsOneWidget);

      now = now.add(const Duration(minutes: 3));
      await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
      await tester.pumpAndSettle();
      expect(calls, hasLength(2));
      expect(jsonDecode(calls[1].body), containsPair('duration_seconds', 3 * 60));
      expect(calls[1].headers['idempotency-key'], isNot(firstVisitId));
    });

    testWidgets('撮影をやめて戻ったあとは、新しい訪問として記録する',
        (WidgetTester tester) async {
      // 撮影結果はこのテストの対象ではない。カメラを閉じた状態だけを返し、
      // 「先輩、ちょっといい?」のpushとpopを本物のルータで通す。
      const MethodChannel pickerChannel = MethodChannel('plugins.flutter.io/image_picker');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pickerChannel, (_) async => null);
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(pickerChannel, null),
      );
      mockPermissionHandler();

      DateTime now = DateTime(2026, 8, 3, 21);
      final List<http.Request> calls = <http.Request>[];
      final ProviderContainer container = navigationContainer(
        clock: () => now,
        calls: calls,
      );
      final GoRouter router = container.read(appRouterProvider);

      await tester.pumpWidget(wrapRouter(container));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey<String>('navigation-study-room')));
      await tester.pumpAndSettle();

      now = now.add(const Duration(minutes: 2));
      await tester.tap(find.text(ja.studyRoomAsk));
      await tester.pumpAndSettle();
      expect(find.byType(CaptureScreen), findsOneWidget);
      expect(calls, hasLength(1));
      expect(jsonDecode(calls[0].body), containsPair('duration_seconds', 2 * 60));
      final String firstVisitId = calls[0].headers['idempotency-key']!;

      // 撮影画面にいた30分は自習時間へ足さない。pop後の0表示は、開始時刻を
      // 戻った時点へ置き直せたことも固定する。
      now = now.add(const Duration(minutes: 30));
      router.pop();
      await tester.pumpAndSettle();
      expect(find.byType(StudyRoomScreen), findsOneWidget);
      expect(find.text(ja.studyRoomElapsed(0)), findsOneWidget);

      now = now.add(const Duration(minutes: 3));
      await tester.tap(find.byKey(const ValueKey<String>('navigation-home')));
      await tester.pumpAndSettle();
      expect(calls, hasLength(2));
      expect(jsonDecode(calls[1].body), containsPair('duration_seconds', 3 * 60));
      expect(calls[1].headers['idempotency-key'], isNot(firstVisitId));
    });
  });
}

class _FakeLastBoardController extends LastBoardController {
  _FakeLastBoardController(this._board);

  final LastBoard _board;

  @override
  LastBoard build() => _board;
}
