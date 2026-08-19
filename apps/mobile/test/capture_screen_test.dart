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
// `ImageSource.gallery.index` を綴らずに書くため。**どちらが開いたかは
// この番号でしか確かめられない**(返ってくる写真は同じなので)。
import 'package:image_picker/image_picker.dart';

import 'support/harness.dart';

/// 1x1 のPNG。サムネイルが描ければよいので、これ以上小さくする必要はない。
final Uint8List _onePixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// 撮影画面。見ているのは見た目ではなく、**3つの約束が画面として成立しているか**。
///
///   - **カメラを勝手に開かない。** 何を撮るかを先に選ばせる。ノートが無い生徒が
///     「ノートは無い」をシャッターの前に言えるのは、ここしかない
///   - どちらか1枚で授業を始められる(§4-1)
///   - 読み取った問題文は**授業の前に見せる**。読めなかったときは黙って進める
///
/// カメラは `plugins.flutter.io/image_picker` を差し替えて、撮ったことにする。
void main() {
  const MethodChannel pickerChannel = MethodChannel('plugins.flutter.io/image_picker');

  /// 切り抜きのネイティブUI(uCrop / TOCropViewController)も同じやり方で差し替える。
  const MethodChannel cropperChannel = MethodChannel('plugins.hunghd.vn/image_cropper');
  const AppStrings ja = AppStrings(Locale('ja'));

  late Directory tempDir;
  late List<String> pickedPaths;

  /// 撮ったのか選んだのか(`ImageSource.index`。0=カメラ / 1=アルバム)。
  ///
  /// **経路の取り違えは画面から見えない。** アルバムを押したのにカメラが
  /// 開いていても、返ってくる写真は同じなので画面のテストはすべて通ってしまう。
  late List<int> pickedSources;

  /// 写真を開くときに頼んだ長辺の上限(`maxWidth` / `maxHeight`)。
  ///
  /// **上限が抜けても画面には出ない。** 返ってくるパスは同じなので、
  /// 頼んだ引数を見ておかないと、48MPの1枚がそのままVision APIへ行く経路が
  /// 黙って戻る。
  late List<Object?> pickedMaxSides;

  /// 切り抜いた結果のパス。**撮った写真とは別のファイルにする** —
  /// 同じものを返すと、切り抜きが枠に入ったかどうかが見えない。
  late List<String> croppedPaths;

  /// カメラ/アルバムを閉じるまでに撮らずに帰る回数。0なら毎回撮る。
  late int cancelCount;

  /// 切り抜きをやめる回数。0なら毎回切り抜く。
  late int cropCancelCount;

  /// 切り抜きを開いた回数(やめた分も数える)。
  ///
  /// **スピナーの出現では待てない。** 差し替えた切り抜きは一瞬で返るので、
  /// `_picking` が立ってから寝るまでのあいだに1フレームも挟まらないことがある。
  late int cropCalls;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('capture_screen_test');
    pickedPaths = <String>[];
    pickedSources = <int>[];
    pickedMaxSides = <Object?>[];
    croppedPaths = <String>[];
    cancelCount = 0;
    cropCancelCount = 0;
    cropCalls = 0;

    // カメラを開くたびに別のファイルを返す(ノートと問題を取り違えないため)。
    //
    // **中身は本物の画像でないといけない。** 撮ったものは画面にサムネイルとして
    // 出るので、デコードできないバイト列を返すと `Image.file` がそこで落ちる。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      pickerChannel,
      (MethodCall call) async {
        // **やめた場合も、何を開いたかは記録する。** アルバムを押した人に
        // カメラの文言を返していないかは、ここでしか確かめられない。
        final Map<Object?, Object?> arguments = call.arguments as Map<Object?, Object?>;
        pickedSources.add(arguments['source']! as int);
        pickedMaxSides.add(arguments['maxWidth']);
        pickedMaxSides.add(arguments['maxHeight']);
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

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      cropperChannel,
      (MethodCall call) async {
        cropCalls += 1;
        // 切り抜きをやめる(image_cropper も null を返す)。
        if (cropCancelCount > 0) {
          cropCancelCount -= 1;
          return null;
        }
        final File file = File('${tempDir.path}/cropped${croppedPaths.length}.jpg')
          ..writeAsBytesSync(_onePixelPng);
        croppedPaths.add(file.path);
        return file.path;
      },
    );

    // 許可の照会は差し替えないと返ってこない(理由は `mockPermissionHandler`)。
    mockPermissionHandler();
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickerChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(cropperChannel, null);
    tempDir.deleteSync(recursive: true);
  });

  /// `problem` を返すAPIクライアント。null なら「読めなかった」。
  List<Object?> apiOverrides({
    Map<String, dynamic>? problem,
    /// 読めなかった理由(`api.ts` の `problemOutcomes`)。画面の文言がこれで変わる。
    String? problemOutcome,
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,
    /// 会話の開始だけを落とす(解析は通る)。通信が切れた状況を作る。
    bool failStart = false,
    /// 打ち直した問題文をサーバのガードレールが弾く(解答が混ざっていた等)。
    String? rejectProblemMessage,
  }) {
    final MockClient client = MockClient((http.Request request) async {
      calls?.add(request);
      // 問題文の打ち直し。**写真は送らない**ので、ここは素のJSON。
      if (request.url.path.endsWith('/problem')) {
        if (rejectProblemMessage != null) {
          return http.Response.bytes(
            utf8.encode(jsonEncode(<String, dynamic>{
              'error': <String, dynamic>{
                'code': 'problem_unreadable',
                'message': rejectProblemMessage,
              },
            })),
            422,
            headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
          );
        }
        final String text =
            (jsonDecode(request.body) as Map<String, dynamic>)['text'] as String;
        return http.Response.bytes(
          utf8.encode(jsonEncode(<String, dynamic>{
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
            'problem': <String, dynamic>{'text': text, 'source': 'manual'},
            'problem_outcome': 'read',
          })),
          200,
          headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
        );
      }
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
      // 部屋の鍵が出るのは会話の開始だけ。**解析の応答には載せない** —
      // 載せると、鍵を持っている = いつでも始められる になり、
      // 回数を会話の開始で数える形が画面のテストからも見えなくなる。
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
              'problem_outcome':
                  problemOutcome ?? (problem == null ? 'not_found' : 'read'),
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
    String? problemOutcome,
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,
    bool failStart = false,
    String? rejectProblemMessage,
    Size size = phoneSurface,
  }) async {
    await pumpApp(
      tester,
      const CaptureScreen(),
      overrides: apiOverrides(
        problem: problem,
        problemOutcome: problemOutcome,
        topics: topics,
        calls: calls,
        errorCode: errorCode,
        errorMessage: errorMessage,
        failStart: failStart,
        rejectProblemMessage: rejectProblemMessage,
      ),
      size: size,
    );
  }

  /// 枠をタップして、シートから入れ方を選ぶ。
  ///
  /// **枠のタップではカメラが開かない。** 開くのは入れ方のシートで、カメラは
  /// その1マス目。アルバムの導線を置ける場所がここしか無かったので、撮る人にも
  /// 1タップ増えている(理由は `capture_screen.dart` のコメント)。
  Future<void> tapSlot(WidgetTester tester, String slotLabel, String action) async {
    await tester.tap(find.text(slotLabel));
    await tester.pumpAndSettle();
    await tester.tap(find.text(action));
    await tester.pumpAndSettle();
  }

  /// ノートの枠から撮る。**画面に入っただけではカメラが開かない**ので、
  /// 写真が要るテストはここを通る。
  Future<void> takeNotes(WidgetTester tester) =>
      tapSlot(tester, ja.captureTakeNotes, ja.capturePickCamera);

  /// 問題の枠から撮る。ノートが無い生徒はこちらだけを通る。
  Future<void> takeProblem(WidgetTester tester) =>
      tapSlot(tester, ja.captureAddProblem, ja.capturePickCamera);

  /// 条件が満たされるまで実時間で進める。
  ///
  /// **画面の変化では待てない場面がある。** 切り抜きは戻ってきても枠の見た目が
  /// 変わらない(サムネイルが差し替わるだけ)ので、結果そのものを待つ。
  /// 実時間を挟む理由は [pumpUntil] と同じ。
  Future<void> pumpUntilTrue(WidgetTester tester, bool Function() done) async {
    for (int i = 0; i < 100; i++) {
      if (done()) return;
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 10));
    }
    fail('条件が満たされませんでした');
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

  /// **ここが崩れると、ノートが無い生徒は問題の枠を見ないままシャッターの前に立つ。**
  /// 手元にあるのは問題集だけなので、そこで撮れば紙面がノート枠に入り、
  /// 「解析後に破棄する」という約束が自分たちのUIで破れる
  /// (`api.ts` の `sessionPhotoParts` が「残る穴」と書いたもの)。
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
    await takeNotes(tester);

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
    await takeNotes(tester);
    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsOneWidget);
    expect(
      tester.getBottomLeft(find.text(ja.captureStart)).dy,
      lessThan(smallPhoneSurface.height),
    );
  });

  // 学年ラベルが付いたぶん、チップは横に伸びた。「中1 データの分布とヒストグラム」は
  // 375px の端末で1チップが画面幅を超える。切り詰めるとどの単元か読めなくなるので
  // 折り返す — その結果、**縦にも横にも溢れていない**ことをここで固定する。
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

  /// ノートの必須をやめた(PM判断)。**必須にしているかぎり、手も付けていない
  /// 問題を持ってきた生徒は紙面をノート枠に入れるしかなく**、解析後破棄の約束が
  /// 自分たちのUI制約で破られる。
  group('ノートが無い経路', () {
    testWidgets('カメラを開いてやめても、画面に留まって選び直せる', (WidgetTester tester) async {
      cancelCount = 1;
      await pumpCapture(tester);
      await takeNotes(tester); // 開いて、撮らずに帰る

      // 以前はここでホームへ降ろしていた。降ろすと選び直せない。
      expect(find.text(ja.capturePhotoNotes), findsOneWidget);
      expect(find.text(ja.captureTakeNotes), findsOneWidget);
      expect(find.text(ja.captureAddProblem), findsOneWidget);
    });

    testWidgets('両方空のときだけ、はじめられない', (WidgetTester tester) async {
      await pumpCapture(tester);

      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNull);
      // **押せない理由は書かない。** 空の枠が2つ見えていれば足りる。
      expect(find.textContaining('ノートがありません'), findsNothing);
    });

    /// ノートのカメラを一度も開かずに、問題だけで始められること。
    /// **キャンセルを経由しないのが要点** — 以前はここを通らないと
    /// 問題の枠にたどり着けず、キャンセルは「やめる」に読めていた。
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

    /// **ノートが無いことを、撮る前に許しておく。** ここで黙っていると、
    /// 解けなかった生徒には紙面をノート枠に入れる以外の道が見えない。
    testWidgets('1枚も撮っていないうちに、問題だけでいいと言う', (WidgetTester tester) async {
      await pumpCapture(tester);

      expect(find.text(ja.captureEitherIsFine), findsOneWidget);
      // 2枚目の促しはノートを撮った人へのもの。まだ出さない。
      expect(find.text(ja.captureProblemHint), findsNothing);
    });

    testWidgets('問題を撮った人に、問題も撮れとは言わない', (WidgetTester tester) async {
      await pumpCapture(tester);
      await takeProblem(tester);

      expect(find.text(ja.captureProblemHint), findsNothing);
      expect(find.text(ja.captureEitherIsFine), findsNothing);
    });

    // ノートがあるほうが良いことは変わっていない。見出しは据え置く。
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

  /// **外部テスターの唯一の不満だったもの。**
  ///
  /// ここは長いあいだ意図して無言だった(読めなかったと告げるだけでは、
  /// 撮り直さないと消えない警告になり、任意のはずの2枚目が事実上の必須になる)。
  /// その結果、失敗が最初に表に出るのは会話の中 —
  /// 先輩が「問題、読んでもらってもいい?」と聞き、生徒は**画面に見えている問題を、
  /// もう一度声で入れ直していた。**
  ///
  /// **直せる口と同時に出すなら、警告にならない。** その場で終わる話になる。
  group('問題文が読めなかったとき', () {
    testWidgets('黙って進めず、打ち直し欄を最初から主導線として出す', (WidgetTester tester) async {
      await pumpCapture(tester);
      await takeNotes(tester);

      await startLesson(tester);

      expect(find.text(ja.captureProblemNotRead), findsOneWidget);
      expect(find.text(ja.captureProblemNotReadGuidance), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text(ja.captureProblemFixHint), findsOneWidget);
      expect(find.text(ja.captureProblemStartWarning), findsOneWidget);
      // 読み合わせの見出しは出ない(読めていないので、見せる本文が無い)。
      expect(find.text(ja.captureProblemTitle), findsNothing);
      // 行き止まりにもしない。単元の確認まで進んでいる。
      expect(find.text(ja.captureConfirmHint), findsOneWidget);
    });

    /// **落ち方をまとめない。** ぜんぶ「読み取れませんでした」に畳むと、
    /// 生徒からは同じ行き止まりに見え、次に何をすればいいか分からない。
    testWidgets('紙面を丸ごと撮っていたときは、そう言う', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'too_long');
      await takeNotes(tester);
      await startLesson(tester);

      expect(find.text(ja.captureProblemTooLong), findsOneWidget);
      expect(find.text(ja.captureProblemTooLongGuidance), findsOneWidget);
      expect(find.text(ja.captureProblemNotRead), findsNothing);
    });

    testWidgets('解答まで写っていたときは、そう言う', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'solution_included');
      await takeNotes(tester);
      await startLesson(tester);

      expect(find.text(ja.captureProblemHadSolution), findsOneWidget);
      expect(find.text(ja.captureProblemHadSolutionGuidance), findsOneWidget);
    });

    testWidgets('式だけだったときは、設問の指示まで入れるよう案内する', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'not_a_problem');
      await takeNotes(tester);
      await startLesson(tester);

      expect(find.text(ja.captureProblemNotAQuestion), findsOneWidget);
      expect(find.text(ja.captureProblemNotAQuestionGuidance), findsOneWidget);
    });

    /// サーバが落ち方を増やしても、確認画面ごと落ちない。
    testWidgets('知らない落ち方でも、既定の言い方で進める', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'something_new');
      await takeNotes(tester);
      await startLesson(tester);

      expect(find.text(ja.captureProblemNotRead), findsOneWidget);
      expect(find.text(ja.captureConfirmHint), findsOneWidget);
    });
  });

  /// **授業が始まる前に問題文を直せる、唯一の口。**
  /// 問題の紙面は解析後に破棄されるので、あとから機械が読み直す手段は無い。
  group('問題文の打ち直し', () {
    const String typed = '円 x^2 + y^2 = 5 と直線 y = x + k の共有点の個数を求めよ。';

    /// 入力欄を開いて打ち込み、送るところまで。
    Future<void> typeProblem(
      WidgetTester tester,
      String text, {
      String? opener,
    }) async {
      if (opener != null) {
        await tester.tap(find.text(opener));
        await tester.pumpAndSettle();
      }
      await tester.enterText(find.byType(TextField), text);
      await tester.pumpAndSettle();
      await tester.tap(find.text(ja.captureProblemSave));
      await tester.pumpAndSettle();
    }

    testWidgets('打ち直した問題文が、読み合わせに出る', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);
      await takeNotes(tester);
      await startLesson(tester);

      await typeProblem(tester, typed);

      expect(find.text(ja.captureProblemTitle), findsOneWidget);
      expect(find.text(typed), findsOneWidget);
      // 読めなかったことを言う行は、もう出ない。
      expect(find.text(ja.captureProblemNotRead), findsNothing);
    });

    /// **写真は送り直さない。** 解答が混ざる原因は「紙面のどこを写したか」なので、
    /// 同じ写真を投げ直しても同じものが返る(そのぶん解析の枠だけが減る)。
    testWidgets('送るのはテキストだけ(写真を撮り直させない)', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);
      await takeNotes(tester);
      await startLesson(tester);

      await typeProblem(tester, typed);

      final http.Request patched = calls.lastWhere(
        (http.BaseRequest it) => it.url.path.endsWith('/problem'),
      ) as http.Request;
      expect(patched.method, 'PATCH');
      expect(jsonDecode(patched.body)['text'], typed);
      // 撮り直しの導線は開かない。
      expect(pickedPaths, hasLength(1));
    });

    // 誤読の訂正。読めていた本文も、始まる前なら直せる。
    testWidgets('読めていた問題文も直せる(欄には元の本文が入っている)', (WidgetTester tester) async {
      await pumpCapture(
        tester,
        problem: <String, dynamic>{'text': '円 x^2 + y^2 = 5 の共有点', 'source': 'problem_photo'},
      );
      await takeNotes(tester);
      await startLesson(tester);

      expect(find.text(ja.captureProblemEdit), findsOneWidget);
      await tester.tap(find.text(ja.captureProblemEdit));
      await tester.pumpAndSettle();

      // いちから打ち直させない。**直すのは一部**なので、元の本文から始める。
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller?.text,
        '円 x^2 + y^2 = 5 の共有点',
      );
    });

    /// **弾かれても、単元の確認ごと消さない。**
    /// `CaptureState.error` に載せると全面のエラー表示になり、
    /// いま打った本文も、直せる場所も画面から消える。
    testWidgets('弾かれたら、理由は入力欄の下に出る', (WidgetTester tester) async {
      const String message = '問題文として読み取れませんでした。答えや解説を外してみてください。';
      await pumpCapture(tester, rejectProblemMessage: message);
      await takeNotes(tester);
      await startLesson(tester);

      await typeProblem(tester, 'x^2 - 3x + 2 = 0 【解答】x = 1, 2');

      expect(find.text(message), findsOneWidget);
      // 打った本文も、単元のチップも残っている。
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text(ja.captureConfirmHint), findsOneWidget);
    });

    /// **打った本文が届かないまま授業が始まる**のが、この画面でいちばん
    /// 起きてはいけない裏切り(それを直すために作った口なので)。
    testWidgets('打ち込んでいる最中は、授業を始められない', (WidgetTester tester) async {
      await pumpCapture(tester);
      await takeNotes(tester);
      await startLesson(tester);

      final ChunkyButton button = tester.widget<ChunkyButton>(
        find.widgetWithText(ChunkyButton, ja.captureStart),
      );
      expect(button.onPressed, isNull);
    });

    testWidgets('やめれば、元の読み合わせに戻る', (WidgetTester tester) async {
      await pumpCapture(tester);
      await takeNotes(tester);
      await startLesson(tester);

      await tester.tap(find.text(ja.captureProblemCancel));
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsNothing);
      expect(find.text(ja.captureProblemNotRead), findsOneWidget);
      expect(find.text(ja.captureProblemStartWarning), findsOneWidget);

      // 2枚目を事実上の必須にはしない。結果を明示したうえで、空のまま進める。
      final ChunkyButton button = tester.widget<ChunkyButton>(
        find.widgetWithText(ChunkyButton, ja.captureStart),
      );
      expect(button.onPressed, isNotNull);
    });
  });

  /// `/start` が指定の回数だけ飛ぶまで進める。
  ///
  /// **画面の変化では待てない。** ここでは開始をずっと失敗させているので、
  /// 出ている「もう一度」は押す前と押したあとで見分けがつかない。
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

  /// **「もう一度」が撮り直しに戻ると、行き止まりになる。**
  ///
  /// 解析済みの状態では [CaptureController.setPhoto] が新しい写真を捨てるので、
  /// カメラだけが何度も開いてエラーが消えない。しかも会話の開始で落ちた場合は、
  /// サーバ側で今日の枠を押さえていることがあり、撮り直すとその1回を捨てる。
  testWidgets('会話の開始で落ちたら、「もう一度」は開始をやり直す(カメラを開かない)',
      (WidgetTester tester) async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    await pumpCapture(
      tester,
      calls: calls,
      failStart: true,
      problem: <String, dynamic>{
        'text': 'x^2 - 3x + 2 = 0 を解け。',
        'source': 'notes_photo',
      },
    );
    await takeNotes(tester);
    await startLesson(tester);

    final int picksBeforeRetry = pickedPaths.length;

    // 単元の確認画面の「はじめる」→ 会話の開始が落ちる
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

  /// **端末の写真をアプリ内に並べる案は採っていない。** それには Android で
  /// `READ_MEDIA_IMAGES`(広いアクセス)が要り、Google Play の Photo & Video
  /// Permissions ポリシーの申告・審査対象になる。マス目はOSのピッカーに任せ、
  /// 撮影ボタンだけ手前に出す形にしてある(理由は `capture_screen.dart`)。
  group('アルバムから入れる', () {
    testWidgets('枠をタップすると、撮るとアルバムが並ぶ', (WidgetTester tester) async {
      await pumpCapture(tester);
      await tester.tap(find.text(ja.captureTakeNotes));
      await tester.pumpAndSettle();

      expect(find.text(ja.capturePickCamera), findsOneWidget);
      expect(find.text(ja.capturePickGallery), findsOneWidget);
      // 空の枠に切り抜きは出さない(押せない操作が増えるだけ)。
      expect(find.text(ja.captureCrop), findsNothing);
      // **どちらの枠を触っているかを出す。** シートが枠を隠すので、
      // 名前が無いと取り違えたまま入れられる。
      expect(find.text(ja.capturePhotoNotes), findsWidgets);
      // カメラはまだ開いていない。並べて見せているだけ。
      expect(pickedSources, isEmpty);
    });

    /// **経路の取り違えは画面から見えない。** 返ってくる写真は同じなので、
    /// アルバムを押してカメラが開いていても、見た目のテストは全部通る。
    testWidgets('アルバムを選ぶと、カメラではなくアルバムが開く', (WidgetTester tester) async {
      await pumpCapture(tester);
      await tapSlot(tester, ja.captureAddProblem, ja.capturePickGallery);

      expect(pickedSources, <int>[ImageSource.gallery.index]);
      expect(pickedPaths, hasLength(1));
    });

    /// アルバムから入れても**枠の意味は変わらない。**
    /// 問題の紙面がノート枠に入ると、他者の著作物がR2に保存される。
    testWidgets('アルバムから入れた問題も、problem_photo として送られる',
        (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);
      await tapSlot(tester, ja.captureAddProblem, ja.capturePickGallery);
      await startLesson(tester);

      final String body =
          utf8.decode((calls.single as http.Request).bodyBytes, allowMalformed: true);
      expect(body, contains('name="problem_photo"'));
      expect(body, isNot(contains('name="photo"')));
    });

    /// **カメラの範囲を超えた1枚が入ってくる。** アルバムには他のアプリで撮った
    /// 48MPの写真もパノラマもあり、解析は画像をそのままVision APIへ渡すので、
    /// 大きすぎる1枚は**生徒からは「サーバのエラー」としてしか見えない形**で落ちる。
    /// 上限は切り抜き側と同じ2576px(`claude-sonnet-5` がそのまま読める大きさ)。
    testWidgets('開くときに長辺の上限を頼む(切り抜かない経路でも効く)',
        (WidgetTester tester) async {
      await pumpCapture(tester);
      await tapSlot(tester, ja.captureAddProblem, ja.capturePickGallery);

      expect(pickedMaxSides, <Object?>[2576.0, 2576.0]);
    });

    /// **枠は「これで合っている?」を見る場所。** `cover` は端を落とすので、
    /// 紙面が切れていることがいちばん出るところが隠れる。アルバムから
    /// 横長の写真も長いスクリーンショットも入ってくる。
    testWidgets('確かめる枠では、写真を切り取らずに全体を入れる',
        (WidgetTester tester) async {
      await pumpCapture(tester);
      await takeProblem(tester);

      final Image thumbnail = tester.widget(find.byType(Image));
      expect(thumbnail.fit, BoxFit.contain);
    });
  });

  group('切り抜き', () {
    /// 切り抜きを開いて、戻ってくるまで進める。
    ///
    /// **`pumpAndSettle` では待てない。** 待っているあいだ画面に出ているのは
    /// 終わらないスピナーで、切り抜き自体も実ファイルを触る([pumpUntil])。
    Future<void> cropFilledSlot(WidgetTester tester) async {
      await tester.tap(find.text(ja.captureChangePhoto));
      await tester.pumpAndSettle();
      await tester.tap(find.text(ja.captureCrop));
      await pumpUntilTrue(tester, () => cropCalls > 0);
      // 結果が枠に入るまで(スピナーが出ていれば、それが消えるまで)。
      await pumpUntilTrue(
        tester,
        () => find.byType(CircularProgressIndicator).evaluate().isEmpty,
      );
      await tester.pumpAndSettle();
    }

    /// **既知の失敗モードへの手当て。** `contract` の `problemTextMaxLength` が
    /// 「ページ全体を写すと、章末の解答や解説まで問題文として流れ込み、先輩が
    /// 答えを読み上げるところから授業が始まってしまう」と書いていて、600字の上限は
    /// その安全弁でしかなかった。**それでも促しに留める。**
    testWidgets('問題が入っている人にだけ、切り抜きを促す', (WidgetTester tester) async {
      await pumpCapture(tester);
      expect(find.text(ja.captureCropHint), findsNothing);

      await takeProblem(tester);

      expect(find.text(ja.captureCropHint), findsOneWidget);
      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNotNull, reason: '切り抜かなくても始められる');
    });

    testWidgets('切り抜くと、切り抜いたほうが枠に入って送られる', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);
      await takeProblem(tester);

      await cropFilledSlot(tester);
      expect(croppedPaths, hasLength(1));

      await startLesson(tester);
      final String body =
          utf8.decode((calls.single as http.Request).bodyBytes, allowMalformed: true);
      // 送られたのは切り抜いたほう。元の写真ではない。
      expect(body, contains('filename="${croppedPaths.single.split('/').last}"'));
      expect(body, isNot(contains('filename="${pickedPaths.single.split('/').last}"')));
    });

    /// **やめても写真は残す。** 捨てると撮り直しになる。
    testWidgets('切り抜きをやめても、元の写真は枠に残る', (WidgetTester tester) async {
      cropCancelCount = 1;
      await pumpCapture(tester);
      await takeProblem(tester);

      await cropFilledSlot(tester);

      expect(croppedPaths, isEmpty);
      final ChunkyButton button = tester.widget(find.byType(ChunkyButton));
      expect(button.onPressed, isNotNull, reason: '写真が残っているので始められる');
    });
  });
}
