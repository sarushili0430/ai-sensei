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

/// 1x1 のPNG。サムネイルが描ければよいので、これ以上小さくする必要はない。
final Uint8List _onePixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// 撮影画面。見ているのは見た目ではなく、**2つの約束が画面として成立しているか**。
///
///   - 問題の写真は**任意**(§4-1)。撮らなくても授業を始められる
///   - 読み取った問題文は**授業の前に見せる**。読めなかったときは黙って進める
///
/// カメラは `plugins.flutter.io/image_picker` を差し替えて、撮ったことにする。
void main() {
  const MethodChannel pickerChannel = MethodChannel('plugins.flutter.io/image_picker');
  const AppStrings ja = AppStrings(Locale('ja'));

  late Directory tempDir;
  late List<String> pickedPaths;

  /// カメラを閉じるまでに撮らずに帰る回数。0なら毎回撮る。
  late int cancelCount;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('capture_screen_test');
    pickedPaths = <String>[];
    cancelCount = 0;

    // カメラを開くたびに別のファイルを返す(ノートと問題を取り違えないため)。
    //
    // **中身は本物の画像でないといけない。** 撮ったものは画面にサムネイルとして
    // 出るので、デコードできないバイト列を返すと `Image.file` がそこで落ちる。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      pickerChannel,
      (MethodCall call) async {
        // 撮らずに帰る(image_picker は null を返す)。
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

    // 許可の照会は差し替えないと返ってこない(理由は `mockPermissionHandler`)。
    mockPermissionHandler();
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickerChannel, null);
    tempDir.deleteSync(recursive: true);
  });

  /// `problem` を返すAPIクライアント。null なら「読めなかった」。
  List<Object?> apiOverrides({Map<String, dynamic>? problem, List<http.BaseRequest>? calls}) {
    final MockClient client = MockClient((http.Request request) async {
      calls?.add(request);
      final Map<String, dynamic> body = <String, dynamic>{
        'session_id': 'ses_1',
        'kind': 'new',
        'livekit': <String, dynamic>{
          'url': 'wss://test.livekit.cloud',
          'token': 'token',
          'room': 'ses_1',
        },
        'detected_topics': <Map<String, dynamic>>[
          <String, dynamic>{
            'topic_id': 'M2-ZUKEI-ENCHOKU',
            'course': '数学II',
            'unit': '図形と方程式',
            'topic': '円と直線の位置関係',
            'confidence': 0.92,
          },
        ],
        'problem': problem,
        'limits': <String, dynamic>{'max_seconds': 300, 'lesson_allowed_today': false},
      };
      return http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        201,
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
    List<http.BaseRequest>? calls,
    Size size = phoneSurface,
  }) async {
    await pumpApp(
      tester,
      const CaptureScreen(),
      overrides: apiOverrides(problem: problem, calls: calls),
      size: size,
    );
  }

  /// 「授業をはじめる」を押して、解析が返るまで進める。
  ///
  /// **[WidgetTester.runAsync] を挟むのは手抜きではない。** 送っているのは
  /// multipart で、`MockClient` は本文を組み立てるときに**実際にファイルを読む**。
  /// これは widget test の擬似時間では進まないので、`pumpAndSettle` だけだと
  /// スピナーのまま返ってこない(`capture_flow_test.dart` が素の `test()` で
  /// 動いているのは、あちらが最初から実時間だから)。
  Future<void> startLesson(WidgetTester tester) async {
    await tester.tap(find.text(ja.captureStart));
    // multipart の送信は `MockClient` が実際にファイルを読むので、
    // `pumpAndSettle` では進まない(理由は `pumpUntil`)。
    await pumpUntil(tester, find.text(ja.captureConfirmHint));
  }

  testWidgets('撮ったら、解析の前に一度止まる(今日の1回を使う前)', (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls);

    // 撮っただけでは、まだサーバへ行っていない。
    expect(calls, isEmpty);
    expect(find.text(ja.capturePhotoNotes), findsOneWidget);
    expect(find.text(ja.capturePhotoProblem), findsOneWidget);
    // ヒントであって要求ではないので、撮っていなくても始められる。
    expect(find.text(ja.captureProblemHint), findsOneWidget);
  });

  testWidgets('問題を撮らなくても授業を始められる(2枚目は任意)', (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls);

    await startLesson(tester);

    expect(pickedPaths, hasLength(1), reason: 'カメラを開いたのは1回だけ');
    expect(find.text(ja.captureConfirmTitle), findsOneWidget);
  });

  testWidgets('問題も撮ると、2枚目として送られる', (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(tester, calls: calls);

    await tester.tap(find.text(ja.captureAddProblem));
    await tester.pumpAndSettle();
    await startLesson(tester);

    expect(pickedPaths, hasLength(2));
    final String body = utf8.decode(
      (calls.single as http.Request).bodyBytes,
      allowMalformed: true,
    );
    // 枠が分かれていることが、問題の紙面が保存されない唯一の根拠。
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

    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsOneWidget);
    expect(find.textContaining('共有点の個数'), findsOneWidget);
  });

  // 契約の上限(`problemTextMaxLength` = 600字)。**例外ではなく仕様の一部**なので、
  // 収まる前提にはできない。ここを固定しないと、長い問題文が来た瞬間に
  // 「授業をはじめる」が画面の外へ出る(実測で 375×667 で557pxはみ出していた)。
  testWidgets('600字の問題文でも、始めるボタンが画面の外に出ない', (WidgetTester tester) async {
    final String longProblem =
        ('円 x^2 + y^2 = 5 と直線 y = x + k について共有点の個数を求めよ。' * 30).substring(0, 600);

    await pumpCapture(
      tester,
      size: smallPhoneSurface,
      problem: <String, dynamic>{'text': longProblem, 'source': 'problem_photo'},
    );
    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsOneWidget);
    expect(
      tester.getBottomLeft(find.text(ja.captureStart)).dy,
      lessThan(smallPhoneSurface.height),
    );
  });

  /// ノートの必須をやめた(PM判断)。**必須にしているかぎり、手も付けていない
  /// 問題を持ってきた生徒は紙面をノート枠に入れるしかなく**、解析後破棄の約束が
  /// 自分たちのUI制約で破られる。
  group('ノートが無い経路', () {
    testWidgets('1枚目を撮らずに帰っても、画面に留まって問題を撮れる', (WidgetTester tester) async {
      cancelCount = 1; // ノートのカメラだけキャンセルする
      await pumpCapture(tester);

      // 以前はここでホームへ降ろしていた。降ろすと問題の枠にたどり着けない。
      expect(find.text(ja.capturePhotoNotes), findsOneWidget);
      expect(find.text(ja.captureTakeNotes), findsOneWidget);
      expect(find.text(ja.captureAddProblem), findsOneWidget);
    });

    testWidgets('両方空のときだけ、はじめられない', (WidgetTester tester) async {
      cancelCount = 1;
      await pumpCapture(tester);

      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNull);
      // **押せない理由は書かない。** 空の枠が2つ見えていれば足りる。
      expect(find.textContaining('ノートがありません'), findsNothing);
    });

    testWidgets('問題だけでも授業を始められる', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      cancelCount = 1;
      await pumpCapture(tester, calls: calls);

      await tester.tap(find.text(ja.captureAddProblem));
      await tester.pumpAndSettle();
      await startLesson(tester);

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

    // ノートがあるほうが良いことは変わっていない。見出しは据え置く。
    testWidgets('ノートの枠を「任意」に見せ替えない', (WidgetTester tester) async {
      cancelCount = 1;
      await pumpCapture(tester);

      expect(find.text(ja.capturePhotoNotes), findsOneWidget);
      expect(find.text(ja.capturePhotoProblem), findsOneWidget);
      expect(ja.capturePhotoNotes, isNot(contains('任意')));
    });
  });

  // 読めなかったことを警告として出すと、任意のはずの2枚目が事実上の必須になる。
  testWidgets('読み取れなかったときは、何も言わずに進める', (WidgetTester tester) async {
    await pumpCapture(tester);

    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsNothing);
    // 行き止まりにもしない。単元の確認まで進んでいる。
    expect(find.text(ja.captureConfirmHint), findsOneWidget);
  });
}
