import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/features/capture/presentation/capture_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/harness.dart';

/// A 1x1 PNG. It only has to render as a thumbnail, so nothing smaller is needed.
final Uint8List _onePixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// The capture screen. What is checked is not appearance but whether three
/// promises hold as a screen:
///
///   - the camera never opens on its own; what to shoot is chosen first, which
///     is the only place a student without notes can say so before the shutter
///   - either photo alone can start a lesson
///   - the problem text that was read is shown before the lesson, and a failed
///     read carries on silently
///
/// The camera is stubbed by replacing `plugins.flutter.io/image_picker`.
void main() {
  const MethodChannel pickerChannel = MethodChannel('plugins.flutter.io/image_picker');
  const AppStrings ja = AppStrings(Locale('ja'));

  late Directory tempDir;
  late List<String> pickedPaths;

  /// How many times to return without shooting; 0 shoots every time.
  late int cancelCount;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('capture_screen_test');
    pickedPaths = <String>[];
    cancelCount = 0;

    // Return a different file each time the camera opens, so notes and problem
    // cannot be confused.
    //
    // The bytes must be a real image: the shot appears as a thumbnail, so
    // undecodable bytes crash `Image.file` there.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      pickerChannel,
      (MethodCall call) async {
        // Return without shooting (image_picker returns null).
        if (cancelCount > 0) {
          cancelCount -= 1;
          return null;
        }
        final File file = File('${tempDir.path}/shot${pickedPaths.length}.jpg')
          ..writeAsBytesSync(_onePixelPng);
        pickedPaths.add(file.path);
        return file.path;
      },
    );

    // Permission queries never return unstubbed (see `mockPermissionHandler`).
    mockPermissionHandler();
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickerChannel, null);
    tempDir.deleteSync(recursive: true);
  });

  /// An API client returning `problem`; null means it could not be read.
  List<Object?> apiOverrides({
    Map<String, dynamic>? problem,
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,
    /// Fail only the conversation start (analysis succeeds), reproducing a
    /// dropped connection.
    bool failStart = false,
  }) {
    final MockClient client = MockClient((http.Request request) async {
      calls?.add(request);
      if (failStart && request.url.path.endsWith('/start')) {
        return http.Response.bytes(
          utf8.encode(jsonEncode(<String, dynamic>{
            'error': <String, dynamic>{'code': 'internal_error', 'message': 'server error'},
          })),
          500,
          headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
        );
      }
      if (errorCode != null) {
        return http.Response.bytes(
          utf8.encode(jsonEncode(<String, dynamic>{
            'error': <String, dynamic>{
              'code': errorCode,
              'message': errorMessage ?? 'server error',
            },
          })),
          429,
          headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
        );
      }
      // The room key comes only from starting the conversation, never from the
      // analysis response: including it would make holding a key equal being able
      // to start any time, hiding where the use is counted even from these tests.
      final Map<String, dynamic> body = request.url.path.endsWith('/start')
          ? <String, dynamic>{
              'session_id': 'ses_1',
              'kind': 'new',
              'livekit': <String, dynamic>{
                'url': 'wss://test.livekit.cloud',
                'token': 'token',
                'room': 'ses_1',
              },
              'limits': <String, dynamic>{'max_seconds': 1200, 'lesson_allowed_today': false},
            }
          : <String, dynamic>{
              'session_id': 'ses_1',
              'kind': 'new',
              'detected_topics': topics ??
                  <Map<String, dynamic>>[
                    <String, dynamic>{
                      'topic_id': 'M2-ZUKEI-ENCHOKU',
                      'course': '数学II',
                      'unit': '図形と方程式',
                      'topic': '円と直線の位置関係',
                      'label': '数学II',
                      'confidence': 0.92,
                    },
                  ],
              'problem': problem,
            };
      return http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        request.url.path.endsWith('/start') ? 200 : 201,
        headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
      );
    });

    return <Object?>[
      apiClientProvider.overrideWithValue(
        ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: client),
      ),
    ];
  }

  Future<void> pumpCapture(
    WidgetTester tester, {
    Map<String, dynamic>? problem,
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,
    bool failStart = false,
    Size size = phoneSurface,
  }) async {
    await pumpApp(
      tester,
      const CaptureScreen(),
      overrides: apiOverrides(
        problem: problem,
        topics: topics,
        calls: calls,
        errorCode: errorCode,
        errorMessage: errorMessage,
        failStart: failStart,
      ),
      size: size,
    );
  }

  /// Shoots from the notes slot. Entering the screen does not open the camera,
  /// so any test needing a photo goes through here.
  Future<void> takeNotes(WidgetTester tester) async {
    await tester.tap(find.text(ja.captureTakeNotes));
    await tester.pumpAndSettle();
  }

  /// Shoots from the problem slot; a student without notes takes only this path.
  Future<void> takeProblem(WidgetTester tester) async {
    await tester.tap(find.text(ja.captureAddProblem));
    await tester.pumpAndSettle();
  }

  /// Taps "start the lesson" and pumps until analysis returns.
  ///
  /// [WidgetTester.runAsync] is not a shortcut: the upload is multipart and
  /// `MockClient` actually reads the file while composing the body, which does
  /// not advance under a widget test's fake time. `pumpAndSettle` alone would
  /// hang on the spinner (`capture_flow_test.dart` is fine because plain `test()`
  /// runs on real time from the start).
  Future<void> startLesson(WidgetTester tester) async {
    await tester.tap(find.text(ja.captureStart));
    // `MockClient` really reads the file for a multipart send, so
    // `pumpAndSettle` does not advance it (see `pumpUntil`).
    await pumpUntil(tester, find.text(ja.captureConfirmHint));
  }

  /// If this breaks, a student without notes stands at the shutter never having
  /// seen the problem slot. With only a workbook to hand, shooting there puts the
  /// page in the notes slot and our own UI breaks the discard-after-analysis
  /// promise (the "remaining hole" in `api.ts`).
  testWidgets('入っただけではカメラを開かない(何を撮るか先に選ばせる)', (WidgetTester tester) async {
    await pumpCapture(tester);

    expect(pickedPaths, isEmpty);
    expect(find.text(ja.captureChooseTitle), findsOneWidget);
    expect(find.text(ja.captureTakeNotes), findsOneWidget);
    expect(find.text(ja.captureAddProblem), findsOneWidget);
  });

  testWidgets('撮ったら、解析の前に一度止まる(今日の1回を使う前)', (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls);
    await takeNotes(tester);

    // Shooting alone has not reached the server yet.
    expect(calls, isEmpty);
    expect(find.text(ja.capturePhotoNotes), findsOneWidget);
    expect(find.text(ja.capturePhotoProblem), findsOneWidget);
    // A hint, not a requirement, so it starts without the second photo.
    expect(find.text(ja.captureProblemHint), findsOneWidget);
  });

  testWidgets('問題を撮らなくても授業を始められる(2枚目は任意)', (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls);
    await takeNotes(tester);

    await startLesson(tester);

    expect(pickedPaths, hasLength(1), reason: 'カメラを開いたのは1回だけ');
    expect(find.text(ja.captureConfirmTitle), findsOneWidget);
  });

  testWidgets('問題も撮ると、2枚目として送られる', (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls);
    await takeNotes(tester);

    await takeProblem(tester);
    await startLesson(tester);

    expect(pickedPaths, hasLength(2));
    final String body = utf8.decode(
      (calls.single as http.Request).bodyBytes,
      allowMalformed: true,
    );
    // Separate parts are the only guarantee the problem page is not stored.
    expect(body, contains('name="photo"'));
    expect(body, contains('name="problem_photo"'));
  });

  testWidgets('読み取った問題文は、授業が始まる前に出る', (WidgetTester tester) async {
    await pumpCapture(
      tester,
      problem: <String, dynamic>{
        'text': '円 x^2 + y^2 = 5 と直線 y = x + k の共有点の個数を求めよ。',
        'source': 'problem_photo',
      },
    );
    await takeNotes(tester);

    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsOneWidget);
    expect(find.textContaining('共有点の個数'), findsOneWidget);
  });

  // The contract's limit (`problemTextMaxLength` = 600) is part of the spec, not
  // an edge case, so we cannot assume it fits. Without pinning this, a long
  // problem pushes "start the lesson" off screen (measured: 557px overflow at
  // 375x667).
  testWidgets('600字の問題文でも、始めるボタンが画面の外に出ない', (WidgetTester tester) async {
    final String longProblem =
        ('円 x^2 + y^2 = 5 と直線 y = x + k について共有点の個数を求めよ。' * 30).substring(0, 600);

    await pumpCapture(
      tester,
      size: smallPhoneSurface,
      problem: <String, dynamic>{'text': longProblem, 'source': 'problem_photo'},
    );
    await takeNotes(tester);
    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsOneWidget);
    expect(
      tester.getBottomLeft(find.text(ja.captureStart)).dy,
      lessThan(smallPhoneSurface.height),
    );
  });

  // Grade labels made chips wider, and a long topic name exceeds the screen width
  // on a 375px device. Truncating would hide which topic it is, so it wraps — and
  // this pins that nothing overflows vertically or horizontally.
  testWidgets('長い単元名のチップでも、横に溢れず始めるボタンも画面内に残る', (WidgetTester tester) async {
    await pumpCapture(
      tester,
      size: smallPhoneSurface,
      topics: <Map<String, dynamic>>[
        <String, dynamic>{
          'topic_id': 'J1-DATA-BUNPU',
          'course': '中学1年 数学',
          'unit': 'データの活用',
          'topic': 'データの分布とヒストグラム',
          'label': '中1',
          'confidence': 0.92,
        },
        <String, dynamic>{
          'topic_id': 'J2-DATA-HAKOHIGE',
          'course': '中学2年 数学',
          'unit': 'データの活用',
          'topic': '四分位範囲と箱ひげ図',
          'label': '中2',
          'confidence': 0.88,
        },
      ],
    );
    await takeNotes(tester);
    await startLesson(tester);

    expect(tester.takeException(), isNull, reason: 'チップが画面から溢れています');
    expect(find.text('中1 データの分布とヒストグラム'), findsOneWidget);
    expect(
      tester.getBottomLeft(find.text(ja.captureStart)).dy,
      lessThan(smallPhoneSurface.height),
    );
  });

  /// Notes are no longer required. While they were, a student who brought a
  /// problem they had not touched had to put the page in the notes slot, and our
  /// own UI constraint broke the discard-after-analysis promise.
  group('ノートが無い経路', () {
    testWidgets('カメラを開いてやめても、画面に留まって選び直せる', (WidgetTester tester) async {
      cancelCount = 1;
      await pumpCapture(tester);
      await takeNotes(tester); // open, then return without shooting

      // This used to drop back to home, which removed the chance to choose again.
      expect(find.text(ja.capturePhotoNotes), findsOneWidget);
      expect(find.text(ja.captureTakeNotes), findsOneWidget);
      expect(find.text(ja.captureAddProblem), findsOneWidget);
    });

    testWidgets('両方空のときだけ、はじめられない', (WidgetTester tester) async {
      await pumpCapture(tester);

      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNull);
      // The reason it is disabled is not written out; two empty slots suffice.
      expect(find.textContaining('ノートがありません'), findsNothing);
    });

    /// Starting from the problem alone, without ever opening the notes camera.
    /// The point is not going through cancel: it used to be the only route to the
    /// problem slot, and cancel reads as "give up".
    testWidgets('問題だけでも授業を始められる', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);

      await takeProblem(tester);
      await startLesson(tester);

      expect(pickedPaths, hasLength(1), reason: 'ノートのカメラは一度も開いていない');
      final String body = utf8.decode(
        (calls.single as http.Request).bodyBytes,
        allowMalformed: true,
      );
      expect(body, contains('name="problem_photo"'));
      expect(
        body,
        isNot(contains('name="photo"')),
        reason: 'ノートが無いのにノート枠を作ると、そこに紙面が入る余地ができる',
      );
    });

    /// Grant permission to have no notes before shooting. Silence here leaves a
    /// stuck student no path but the notes slot.
    testWidgets('1枚も撮っていないうちに、問題だけでいいと言う', (WidgetTester tester) async {
      await pumpCapture(tester);

      expect(find.text(ja.captureEitherIsFine), findsOneWidget);
      // The second-photo nudge is for people who shot notes; not yet.
      expect(find.text(ja.captureProblemHint), findsNothing);
    });

    testWidgets('問題を撮った人に、問題も撮れとは言わない', (WidgetTester tester) async {
      await pumpCapture(tester);
      await takeProblem(tester);

      expect(find.text(ja.captureProblemHint), findsNothing);
      expect(find.text(ja.captureEitherIsFine), findsNothing);
    });

    // Having notes is still better, so the heading is unchanged.
    testWidgets('どちらの枠にも「任意」と書かない', (WidgetTester tester) async {
      await pumpCapture(tester);

      expect(find.text(ja.capturePhotoNotes), findsOneWidget);
      expect(find.text(ja.capturePhotoProblem), findsOneWidget);
      expect(ja.capturePhotoNotes, isNot(contains('任意')));
      expect(
        ja.capturePhotoProblem,
        isNot(contains('任意')),
        reason: '片方にだけ付くと、もう片方が必須に読める',
      );
    });
  });

  // Warning about a failed read makes the optional second photo effectively
  // mandatory.
  testWidgets('読み取れなかったときは、何も言わずに進める', (WidgetTester tester) async {
    await pumpCapture(tester);
    await takeNotes(tester);

    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsNothing);
    // Nor is it a dead end: it reaches topic confirmation.
    expect(find.text(ja.captureConfirmHint), findsOneWidget);
  });

  /// Pumps until `/start` has fired the given number of times.
  ///
  /// It cannot wait on a screen change: start keeps failing here, so the "try
  /// again" on screen looks identical before and after the tap.
  Future<void> pumpUntilStartCalls(
    WidgetTester tester,
    List<http.BaseRequest> calls,
    int count,
  ) async {
    int startCalls() =>
        calls.where((http.BaseRequest call) => call.url.path.endsWith('/start')).length;
    for (int i = 0; i < 100; i++) {
      if (startCalls() >= count) return;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 10));
    }
    fail('会話の開始が $count 回飛びませんでした(実際は ${startCalls()} 回)');
  }

  /// "Try again" returning to a retake is a dead end.
  ///
  /// Once analyzed, [CaptureController.setPhoto] discards the new photo, so the
  /// camera reopens forever and the error never clears. And when the failure was
  /// at conversation start, the server may already hold today's slot, so retaking
  /// throws that use away.
  testWidgets('会話の開始で落ちたら、「もう一度」は開始をやり直す(カメラを開かない)',
      (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls, failStart: true);
    await takeNotes(tester);
    await startLesson(tester);

    final int picksBeforeRetry = pickedPaths.length;

    // "Start" on the topic confirmation screen; the conversation start fails.
    await tester.tap(find.text(ja.captureStart));
    await pumpUntil(tester, find.text(ja.errorRetry));

    await tester.tap(find.text(ja.errorRetry));
    await pumpUntilStartCalls(tester, calls, 2);

    expect(pickedPaths.length, picksBeforeRetry, reason: 'カメラを開き直さない');
  });

  testWidgets('Premium のフェアユース上限は、先輩が締めて再試行させない',
      (WidgetTester tester) async {
    const String serverMessage = '上限3回です。Premiumを購入してください。';
    await pumpCapture(
      tester,
      errorCode: 'fair_use_limit_reached',
      errorMessage: serverMessage,
    );
    await takeNotes(tester);

    await tester.tap(find.text(ja.captureStart));
    await pumpUntil(tester, find.text(ja.lessonEnoughForToday));

    expect(find.text(ja.lessonEnoughForToday), findsOneWidget);
    expect(find.text(serverMessage), findsNothing);
    expect(find.text(ja.errorRetry), findsNothing);
    expect(find.text(ja.paywallCta), findsNothing);
  });
}
