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
import 'package:image_picker/image_picker.dart';

import 'support/harness.dart';

/// 1x1 のPNG。サムネイルが描ければよいので、これ以上小さくする必要はない。
final Uint8List _onePixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// 撮影画面。見ているのは見た目ではなく、**4つの約束が画面として成立しているか**。
///
///   - **カメラを勝手に開かない。** 何を撮るかを先に選ばせる。ノートが無い生徒が
///     「ノートは無い」をシャッターの前に言えるのは、ここしかない
///   - どちらか1枚で授業を始められる(§4-1)
///   - **撮る以外の入口がある。** 手元にある1枚が、いま撮れるとは限らない
///     (塾で撮ったノート・送られてきた問題の画像)。ただし**枠は変わらない**
///   - 読み取った問題文は**授業の前に見せる**。読めなかったときは黙って進める
///
/// カメラもアルバムも `plugins.flutter.io/image_picker` を差し替えて、
/// 選んだことにする。
void main() {
  const MethodChannel pickerChannel = MethodChannel('plugins.flutter.io/image_picker');
  const AppStrings ja = AppStrings(Locale('ja'));

  late Directory tempDir;
  late List<String> pickedPaths;

  /// 開いた入口(カメラ / アルバム)を、開いた順に。
  /// **やめた回・断られた回も残す** — どこを開いたかは押した時点で決まっている。
  late List<ImageSource> openedSources;

  /// カメラを閉じるまでに撮らずに帰る回数。0なら毎回撮る。
  late int cancelCount;

  /// 次に開いたときに投げる image_picker のエラーコード。
  /// iOSは許可が無いと **null を返さず例外を投げる**ので、そこを再現する。
  String? throwCode;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('capture_screen_test');
    pickedPaths = <String>[];
    openedSources = <ImageSource>[];
    cancelCount = 0;
    throwCode = null;

    // 開くたびに別のファイルを返す(ノートと問題を取り違えないため)。
    //
    // **中身は本物の画像でないといけない。** 選んだものは画面にサムネイルとして
    // 出るので、デコードできないバイト列を返すと `Image.file` がそこで落ちる。
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      pickerChannel,
      (MethodCall call) async {
        // どちらの入口から開いたか。`source` は ImageSource の並び順で来る
        // (0=カメラ / 1=アルバム)。
        final Map<Object?, Object?> arguments = call.arguments as Map<Object?, Object?>;
        openedSources.add(ImageSource.values[arguments['source']! as int]);

        final String? code = throwCode;
        if (code != null) throw PlatformException(code: code);

        // 何も選ばずに帰る(image_picker は null を返す)。
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
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,
  }) {
    final MockClient client = MockClient((http.Request request) async {
      calls?.add(request);
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
      final Map<String, dynamic> body = <String, dynamic>{
        'session_id': 'ses_1',
        'kind': 'new',
        'livekit': <String, dynamic>{
          'url': 'wss://test.livekit.cloud',
          'token': 'token',
          'room': 'ses_1',
        },
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
        'limits': <String, dynamic>{'max_seconds': 1200, 'lesson_allowed_today': false},
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
    List<Map<String, dynamic>>? topics,
    List<http.BaseRequest>? calls,
    String? errorCode,
    String? errorMessage,
    Size size = phoneSurface,
    Locale locale = const Locale('ja'),
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
      ),
      size: size,
      locale: locale,
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

  /// アルバムの入口は**枠ごとに1つずつ**ある。画面に出る文字は2つとも同じなので、
  /// 読み上げのラベル(枠の名前つき)で見分ける — 見分けられること自体が、
  /// 選んだ1枚の行き先が見えているという条件そのもの。
  Future<void> chooseFrom(WidgetTester tester, String slotLabel) async {
    await tester.tap(find.bySemanticsLabel('$slotLabel・${ja.capturePickFromLibrary}'));
    await tester.pumpAndSettle();
  }

  Future<void> chooseNotes(WidgetTester tester) => chooseFrom(tester, ja.capturePhotoNotes);
  Future<void> chooseProblem(WidgetTester tester) => chooseFrom(tester, ja.capturePhotoProblem);

  /// 送られた multipart から「パート名 → ファイル名」を取り出す。
  ///
  /// **パート名だけでは取り違えを見つけられない。**「2枚とも送った」は分かるが、
  /// **どちらの1枚がどちらのパートに入ったか**は分からない。ノート枠はR2に
  /// 保存され、問題の枠は解析後に捨てられる — 入れ替わる事故はここにしか出ない。
  /// カメラもアルバムも開いた順に `shot0.jpg`, `shot1.jpg` を返すので、
  /// ファイル名が**どの操作で入った1枚か**を指す。
  Map<String, String> partFilenames(http.BaseRequest request) {
    final String body = utf8.decode(
      (request as http.Request).bodyBytes,
      allowMalformed: true,
    );
    return <String, String>{
      for (final RegExpMatch part
          in RegExp(r'name="(\w+)"; filename="([^"]+)"').allMatches(body))
        part.group(1)!: part.group(2)!,
    };
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

  /// **手元にある1枚が、いま撮れるとは限らない。** 塾で撮ってきたノート、
  /// 送られてきた問題のスクリーンショット、机を離れてから思い出した問題 —
  /// 入口が「撮る」だけだと、紙を持ち直して撮り直すか、諦めるかになる。
  ///
  /// ただし**入口が2つになっても、枠は2つのまま。** 写真の寿命は撮り方ではなく
  /// **どちらの枠に入れたか**で決まる(ノートは保存・問題の紙面は解析後に破棄)。
  group('アルバムから選ぶ', () {
    testWidgets('枠ごとに入口があり、枠のタップは撮るのまま', (WidgetTester tester) async {
      await pumpCapture(tester);

      // 1つにまとめると、選んだ1枚がどちらの枠に入るのかが消える。
      expect(find.text(ja.capturePickFromLibrary), findsNWidgets(2));

      await takeNotes(tester);
      // **増やしたのは道であって手数ではない。** 撮る人は今までどおり1タップ。
      expect(openedSources, <ImageSource>[ImageSource.camera]);
    });

    testWidgets('ノートの枠から選んだ1枚は、保存されるほう(photo)へ入る',
        (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);

      await chooseNotes(tester);
      await startLesson(tester);

      expect(openedSources, <ImageSource>[ImageSource.gallery]);
      final String body = utf8.decode(
        (calls.single as http.Request).bodyBytes,
        allowMalformed: true,
      );
      expect(body, contains('name="photo"'));
      expect(body, isNot(contains('name="problem_photo"')));
    });

    /// **ここが逆になると、破棄の約束が静かに破れる。** アルバムから選んだ
    /// 紙面がノート枠に入れば、他者の著作物がR2に残る。
    testWidgets('問題の枠から選んだ1枚は、消えるほう(problem_photo)へ入る',
        (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);

      await chooseProblem(tester);
      await startLesson(tester);

      expect(openedSources, <ImageSource>[ImageSource.gallery]);
      final String body = utf8.decode(
        (calls.single as http.Request).bodyBytes,
        allowMalformed: true,
      );
      expect(body, contains('name="problem_photo"'));
      expect(body, isNot(contains('name="photo"')));
    });

    // ノートは目の前にあるが、問題は送られてきた画像 — いちばんありそうな組み合わせ。
    testWidgets('撮るのと混ぜられる(ノートは撮って、問題はアルバムから)',
        (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);

      await takeNotes(tester);
      await chooseProblem(tester);
      await startLesson(tester);

      expect(openedSources, <ImageSource>[ImageSource.camera, ImageSource.gallery]);
      expect(partFilenames(calls.single), <String, String>{
        'photo': 'shot0.jpg', // 先に撮ったノート
        'problem_photo': 'shot1.jpg', // あとからアルバムで選んだ問題
      });
    });

    /// **入る枠を決めるのは押したボタンで、選んだ順ではない。**
    ///
    /// 上のテストと同じ2枚を、逆の順で入れる。ここが順番に引きずられると、
    /// 問題の紙面がノート枠(= R2に保存されるほう)に入り、
    /// 「読み取ったあとに消えます」が画面の上だけの言葉になる。
    testWidgets('先に問題を選んでも、順番で入れ替わらない', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);

      await chooseProblem(tester); // 1枚目 = shot0.jpg
      await takeNotes(tester); // 2枚目 = shot1.jpg
      await startLesson(tester);

      expect(partFilenames(calls.single), <String, String>{
        'problem_photo': 'shot0.jpg',
        'photo': 'shot1.jpg',
      });
    });

    /// 選び直しても、**あとから入れた1枚が残る**。
    /// 1枚目を捨て損ねると、確認した写真と送る写真がずれる。
    testWidgets('同じ枠で選び直したら、あとの1枚が送られる', (WidgetTester tester) async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      await pumpCapture(tester, calls: calls);

      await takeNotes(tester); // shot0.jpg
      await chooseNotes(tester); // shot1.jpg(選び直し)
      await startLesson(tester);

      expect(partFilenames(calls.single), <String, String>{'photo': 'shot1.jpg'});
    });

    /// **やめただけの人を、許可の画面に落とさない。**
    ///
    /// いまのAndroid(フォトピッカー)もiOS(PHPicker)も、選ぶだけなら
    /// アプリに許可が要らない。要らない許可を照会すると「未許可」が返るので、
    /// カメラと同じ扱いにすると**アルバムをやめるたびに**設定へ促すことになる。
    testWidgets('やめただけなら、許可の話にしない', (WidgetTester tester) async {
      cancelCount = 1;
      mockPermissionHandler(status: permissionDenied);
      await pumpCapture(tester);

      await chooseNotes(tester);

      expect(find.text(ja.capturePhotosDenied), findsNothing);
      expect(find.text(ja.captureCameraDenied), findsNothing);
      // 枠に戻って、選び直せる。
      expect(find.text(ja.captureTakeNotes), findsOneWidget);
      expect(find.text(ja.capturePickFromLibrary), findsNWidgets(2));
    });

    /// 本当に断られる経路は例外で来る(iOSは許可が無いと null を返さない)。
    /// **カメラの文言を使い回さない** — 設定アプリで探すものが変わる。
    testWidgets('断られたら、写真の文言で設定へ促す', (WidgetTester tester) async {
      throwCode = 'photo_access_denied';
      await pumpCapture(tester);

      await chooseNotes(tester);

      expect(find.text(ja.capturePhotosDenied), findsOneWidget);
      expect(find.text(ja.captureCameraDenied), findsNothing);
      expect(find.text(ja.captureOpenSettings), findsOneWidget);
    });

    // 逆向きも固定する。アルバムを開いたあとにカメラで断られたら、カメラの文言。
    testWidgets('カメラで断られたら、カメラの文言に戻る', (WidgetTester tester) async {
      await pumpCapture(tester);
      await chooseNotes(tester); // 直前の入口をアルバムにしておく

      throwCode = 'camera_access_denied';
      await takeProblem(tester);

      expect(find.text(ja.captureCameraDenied), findsOneWidget);
      expect(find.text(ja.capturePhotosDenied), findsNothing);
    });

    // 枠は画面の半分しかない。英語は日本語の1.5〜2倍に伸びるので、
    // 入口を1行足した時点でいちばん狭い実機を見ておく。
    testWidgets('狭い端末の英語でも、2つの入口が枠から溢れない', (WidgetTester tester) async {
      const AppStrings en = AppStrings(Locale('en'));
      await pumpCapture(tester, size: smallPhoneSurface, locale: const Locale('en'));

      expect(tester.takeException(), isNull, reason: '枠から溢れています');
      expect(find.text(en.capturePickFromLibrary), findsNWidgets(2));
      expect(
        tester.getBottomLeft(find.text(en.captureStart)).dy,
        lessThan(smallPhoneSurface.height),
      );
    });
  });

  // 読めなかったことを警告として出すと、任意のはずの2枚目が事実上の必須になる。
  testWidgets('読み取れなかったときは、何も言わずに進める', (WidgetTester tester) async {
    await pumpCapture(tester);
    await takeNotes(tester);

    await startLesson(tester);

    expect(find.text(ja.captureProblemTitle), findsNothing);
    // 行き止まりにもしない。単元の確認まで進んでいる。
    expect(find.text(ja.captureConfirmHint), findsOneWidget);
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
