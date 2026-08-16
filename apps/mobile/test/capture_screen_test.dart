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
  List<Object?> apiOverrides({
    Map<String, dynamic>? problem,

    /// 読み取りの決着(`api.ts` の `problemOutcomes`)。
    /// **省略したら `problem` の有無から決める** — 契約は
    /// 「`read` のときだけ `problem` が入る」で縛られているので、
    /// テストの側でその対を崩せないようにしておく。
    String? problemOutcome,
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,

    /// 手入力を弾く(設問が無い・答えが混ざっている)。`PATCH /problem` だけ落とす。
    bool rejectTypedProblem = false,

    /// 会話の開始だけを落とす(解析は通る)。通信が切れた状況を作る。
    bool failStart = false,
  }) {
    /// いま画面に返している問題文。手入力が通れば、そのあとの応答も置き換わる。
    Map<String, dynamic>? currentProblem = problem;
    String currentOutcome = problemOutcome ?? (problem == null ? 'not_found' : 'read');

    final MockClient client = MockClient((http.Request request) async {
      calls?.add(request);

      // 問題文の手入力。**写真は読み直さないので、出どころは `typed`。**
      if (request.url.path.endsWith('/problem')) {
        if (rejectTypedProblem) {
          return http.Response.bytes(
            utf8.encode(jsonEncode(<String, dynamic>{
              'error': <String, dynamic>{
                'code': 'problem_text_rejected',
                'message': '問題文として読み取れませんでした。',
              },
            })),
            422,
            headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
          );
        }
        final String text =
            (jsonDecode(request.body) as Map<String, dynamic>)['text'] as String;
        currentProblem = <String, dynamic>{'text': text, 'source': 'typed'};
        currentOutcome = 'read';
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
              'problem': currentProblem,
              'problem_outcome': currentOutcome,
            };
      return http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        // 作成だけが201。単元の絞り込みも問題文の手入力も、既にある行の更新。
        request.url.path.endsWith('/sessions') ? 201 : 200,
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
    bool rejectTypedProblem = false,
    bool failStart = false,
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
        rejectTypedProblem: rejectTypedProblem,
        failStart: failStart,
      ),
      size: size,
    );
  }

  /// ノートの枠から撮る。**画面に入っただけではカメラが開かない**ので、
  /// 写真が要るテストはここを通る。
  Future<void> takeNotes(WidgetTester tester) async {
    await tester.tap(find.text(ja.captureTakeNotes));
    await tester.pumpAndSettle();
  }

  /// 問題の枠から撮る。ノートが無い生徒はこちらだけを通る。
  Future<void> takeProblem(WidgetTester tester) async {
    await tester.tap(find.text(ja.captureAddProblem));
    await tester.pumpAndSettle();
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

  /// 問題文を打って確定させる。
  ///
  /// [open] は入力を開く操作名。読めなかったときは「問題文を入力する」、
  /// 読み取った文を直すときは「直す」。
  ///
  /// 送信の完了は `pumpAndSettle` では待てない — `MockClient` の応答は実時間で
  /// 返るので、**画面の変化で待つ**(理由は `pumpUntil`)。
  Future<void> typeProblem(
    WidgetTester tester,
    String text, {
    String? open,
    Finder? until,
  }) async {
    await tester.tap(find.text(open ?? ja.captureProblemEnter));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), text);
    await tester.tap(find.text(ja.captureProblemInputSave));
    // 通ったときは入力欄が閉じて読み合わせが出る。弾かれたときは文言が出る。
    await pumpUntil(tester, until ?? find.text(ja.captureProblemTitle));
    await tester.pumpAndSettle();
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

  /// **読めなかったことを、授業が始まる前に言う。**
  ///
  /// 以前はここで黙って通していた(警告を出すと任意のはずの2枚目が事実上の
  /// 必須になる、という判断)。その結果、失敗が最初に表に出るのは会話の中 —
  /// 先輩の「問題、読んでもらってもいい?」で、**アプリに問題が見えているのに
  /// 声で言い直させられる**。外部テスターの唯一の不満がこれだった。
  ///
  /// 判断そのものは撤回していない。出すのは警告ではなく、事実と
  /// **撮り直さずに済む道**(手入力)なので、2枚目は任意のまま。
  group('問題文が読めなかったとき', () {
    testWidgets('読み取れなかったことを言い、打つ道を出す', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'not_found');
      await takeNotes(tester);

      await startLesson(tester);

      expect(find.text(ja.captureProblemUnreadTitle), findsOneWidget);
      expect(find.text(ja.captureProblemEnter), findsOneWidget);
      // 行き止まりにしない。単元の確認まで進んでいて、そのまま始められる。
      expect(find.text(ja.captureConfirmHint), findsOneWidget);
      expect(
        tester.widget<ChunkyButton>(find.byType(ChunkyButton)).onPressed,
        isNotNull,
        reason: '読めなくても授業は始められる(2枚目は任意のまま)',
      );
    });

    // 撮り直しを促す言葉だけを置くと、それは撮り直さないと消えない警告になり、
    // 任意のはずの2枚目が事実上の必須になる。
    testWidgets('撮り直せとは言わない', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'not_found');
      await takeNotes(tester);
      await startLesson(tester);

      expect(find.text(ja.captureRetake), findsNothing);
      expect(find.text(ja.captureAddProblem), findsNothing);
    });

    /// 落ち方ごとに、本人にできることが違う。畳んで「読み取れませんでした」1本に
    /// すると、**直せたはずの人が直し方を知らないまま授業に入る。**
    final Map<String, String> detailByOutcome = <String, String>{
      'too_long': ja.captureProblemUnreadTooLong,
      'solution_included': ja.captureProblemUnreadSolutionIncluded,
      'not_a_problem': ja.captureProblemUnreadNotAProblem,
      'not_found': ja.captureProblemUnreadNotFound,
    };
    for (final MapEntry<String, String> entry in detailByOutcome.entries) {
      testWidgets('${entry.key} には、その落ち方の直し方を出す', (WidgetTester tester) async {
        await pumpCapture(tester, problemOutcome: entry.key);
        await takeNotes(tester);
        await startLesson(tester);

        expect(find.text(entry.value), findsOneWidget);
        // 他の落ち方の文言が混ざっていないこと。
        for (final String other in detailByOutcome.values.where((String it) => it != entry.value)) {
          expect(find.text(other), findsNothing, reason: '別の落ち方の文言が出ている');
        }
      });
    }

    testWidgets('打った問題文が、そのまま先輩に渡る', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, problemOutcome: 'not_found', calls: calls);
      await takeNotes(tester);
      await startLesson(tester);

      await typeProblem(tester, '円 x^2 + y^2 = 9 と直線の共有点の個数を求めよ。');

      // 打った時点で「読めた」に変わり、読み合わせの側が出る。
      expect(find.text(ja.captureProblemTitle), findsOneWidget);
      expect(find.textContaining('共有点の個数'), findsOneWidget);
      expect(find.text(ja.captureProblemUnreadTitle), findsNothing);

      // **写真は撮り直していない。** 送ったのはテキストだけ。
      expect(pickedPaths, hasLength(1));
      expect(
        calls.where((http.BaseRequest call) => call.url.path.endsWith('/problem')),
        hasLength(1),
      );
    });

    /// 打った文が通らないのは直せる失敗なので、**画面ごと差し替えない。**
    /// 全画面のエラーへ飛ばすと、書いた文が消える。
    testWidgets('通らなかった入力は、画面を壊さずその場で言う', (WidgetTester tester) async {
      await pumpCapture(tester, problemOutcome: 'not_found', rejectTypedProblem: true);
      await takeNotes(tester);
      await startLesson(tester);

      await typeProblem(
        tester,
        'x^2 - 3x + 2 = 0',
        until: find.text('問題文として読み取れませんでした。'),
      );

      // サーバの文言が入力欄の隣に出て、入力は開いたまま。
      expect(find.text('問題文として読み取れませんでした。'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      // 撮り直しには戻していない(直せるものは手元のテキストのほうにある)。
      expect(pickedPaths, hasLength(1));
    });
  });

  /// 誤読の訂正。**授業の頭を1往復使わずに直せるようにする。**
  ///
  /// これまでの保険は「ちがっていれば会話の最初に本人が言う」だけだった。
  testWidgets('読み取れた問題文も、始める前に直せる', (WidgetTester tester) async {
    await pumpCapture(
      tester,
      problem: <String, dynamic>{'text': '別の問題を読んでしまった', 'source': 'notes_photo'},
    );
    await takeNotes(tester);
    await startLesson(tester);

    expect(find.text(ja.captureProblemEdit), findsOneWidget);
    await typeProblem(tester, '円と直線の共有点の個数を求めよ。', open: ja.captureProblemEdit);

    expect(find.textContaining('円と直線の共有点'), findsOneWidget);
    expect(find.text('別の問題を読んでしまった'), findsNothing);
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
    await pumpCapture(tester, calls: calls, failStart: true);
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
}
