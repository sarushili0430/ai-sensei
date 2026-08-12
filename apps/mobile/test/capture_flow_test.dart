import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 撮影 → 単元の確認 → 会話開始。
///
/// 不具合報告: 写真を撮って単元を確かめただけで「今日のセッションは終わり」と出た。
/// **今日の1回を数えるのは会話が始まったとき**(`POST /v1/sessions/{id}/start`)に
/// 変えてあるので、ここで見るのは「どの操作でどの入口を叩くか」。

/// 写真を読んだ応答。**部屋の鍵は入らない。** 入っていたら、鍵を持っている =
/// いつでも始められる になり、数える位置を移した意味が消える。
Map<String, dynamic> _analysisJson(
  String sessionId,
  List<String> topicIds, {
  Map<String, dynamic>? problem,
}) {
  return <String, dynamic>{
    'session_id': sessionId,
    'kind': 'new',
    'problem': problem,
    'detected_topics': <Map<String, dynamic>>[
      for (final String topicId in topicIds)
        <String, dynamic>{
          'topic_id': topicId,
          'course': '数学I',
          'unit': '2次関数',
          'topic': topicId,
          'label': '数学I',
          // 2つ目以降は確信度を低くして、はじめから外れている状態を作る
          'confidence': topicId == topicIds.first ? 0.92 : 0.41,
        },
    ],
  };
}

/// 会話を始めた応答。**この応答が返った時点で今日の1回を使っている。**
Map<String, dynamic> _startJson(String sessionId) {
  return <String, dynamic>{
    'session_id': sessionId,
    'kind': 'new',
    'livekit': <String, dynamic>{
      'url': 'wss://test.livekit.cloud',
      'token': 'token',
      'room': sessionId,
    },
    'limits': <String, dynamic>{'max_seconds': 1200, 'lesson_allowed_today': false},
  };
}

void main() {
  late Directory tempDir;
  late File photo;
  late File problemPhoto;

  /// 学校段階の保存先。セッション作成時に `school_stage` として送るので、
  /// ここが無いと `schoolStageControllerProvider` が起動できずリクエストが飛ばない。
  late SharedPreferences preferences;

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    preferences = await SharedPreferences.getInstance();
    tempDir = Directory.systemTemp.createTempSync('capture_flow_test');
    photo = File('${tempDir.path}/note.jpg')..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0x00]);
    problemPhoto = File('${tempDir.path}/problem.jpg')
      ..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0x01]);
  });

  tearDown(() => tempDir.deleteSync(recursive: true));

  /// 呼ばれたリクエストを順に記録するAPIクライアント。
  ProviderContainer containerWith(
    List<http.BaseRequest> calls, {
    Map<String, dynamic>? problem,
  }) {
    // サーバは UTF-8 で返す(単元名に日本語が入る)。`http.Response` の文字列版は
    // latin1 なので、バイト列で返さないとここで落ちる。
    http.Response json(Map<String, dynamic> body, int status) =>
        http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: <String, String>{
          'content-type': 'application/json; charset=utf-8',
        });

    final MockClient client = MockClient((http.Request request) async {
      calls.add(request);
      if (request.method == 'PATCH') {
        final Map<String, dynamic> body = jsonDecode(request.body) as Map<String, dynamic>;
        final List<String> topicIds = (body['topic_ids'] as List<dynamic>).cast<String>();
        return json(_analysisJson('ses_1', topicIds), 200);
      }
      if (request.url.path.endsWith('/start')) {
        return json(_startJson('ses_1'), 200);
      }
      return json(
        _analysisJson(
          'ses_1',
          <String>['M1-NIJI-GURAFU', 'M1-NIJI-HANBETSU'],
          problem: problem,
        ),
        201,
      );
    });

    // Riverpod 3 は `Override` 型を公開APIに出していないので、`cast()` の型は
    // ProviderContainer 側から推論させる(test/support/harness.dart と同じ理由)。
    final List<Object?> overrides = <Object?>[
      apiClientProvider.overrideWithValue(
        ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: client),
      ),
      preferencesProvider.overrideWithValue(preferences),
    ];
    return ProviderContainer(overrides: overrides.cast());
  }

  test('単元を外して会話を始めても、セッションは作り直さない', () async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    final ProviderContainer container = containerWith(calls);
    addTearDown(container.dispose);

    final CaptureController controller = container.read(captureControllerProvider.notifier);
    controller.setPhoto(photo);
    await controller.analyze();

    // 確信度の低い候補は、はじめから外れている = 会話開始時に必ず反映が要る
    expect(container.read(captureControllerProvider).excludedTopicIds, <String>{
      'M1-NIJI-HANBETSU',
    });

    final SessionStart? session = await controller.confirmAndStart();

    expect(session, isNotNull);
    // 同じセッションのまま。ここが2本目の POST /v1/sessions だと、同じ写真を
    // もう一度Vision LLMに通すことになる
    expect(session!.sessionId, 'ses_1');
    expect(calls.length, 3);
    expect(calls[0].method, 'POST');
    expect(calls[0].url.path, '/v1/sessions');
    expect(calls[1].method, 'PATCH');
    expect(calls[1].url.path, '/v1/sessions/ses_1/topics');
    // 部屋の鍵はここでしか出ない = 今日の1回を使うのもここ
    expect(calls[2].method, 'POST');
    expect(calls[2].url.path, '/v1/sessions/ses_1/start');
  });

  test('単元をひとつも外していなければ、単元の反映には行かない', () async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    final ProviderContainer container = containerWith(calls);
    addTearDown(container.dispose);

    final CaptureController controller = container.read(captureControllerProvider.notifier);
    controller.setPhoto(photo);
    await controller.analyze();
    // 外れていた候補を戻して、解析どおりの状態にする
    controller.toggleTopic('M1-NIJI-HANBETSU');

    await controller.confirmAndStart();

    expect(calls.map((http.BaseRequest call) => call.url.path), <String>[
      '/v1/sessions',
      '/v1/sessions/ses_1/start',
    ]);
  });

  /// **不具合報告そのもの。** 撮って単元を確かめただけで今日の1回が消えていた。
  /// 会話を始めるまで `/start` を叩かないことが、そのまま「数えない」の中身。
  test('撮って単元を確かめただけでは、会話の開始を呼ばない', () async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    final ProviderContainer container = containerWith(calls);
    addTearDown(container.dispose);

    final CaptureController controller = container.read(captureControllerProvider.notifier);
    controller.setPhoto(photo);
    await controller.analyze();
    controller.toggleTopic('M1-NIJI-GURAFU');

    expect(calls.map((http.BaseRequest call) => call.url.path), <String>['/v1/sessions']);
    expect(container.read(captureControllerProvider).session, isNull);
  });

  /// 2枚の写真の**枠**(計画書 §4-1・`api.ts` の `sessionPhotoParts`)。
  ///
  /// ノートは本人の著作物なのでR2に保存され、問題の紙面は他者の著作物なので
  /// 解析後に破棄される。**サーバはどちらの枠に入っていたかでしか区別できない。**
  /// つまりここが崩れると、教科書の紙面が黙って保存され続ける。
  group('問題の写真の枠', () {
    /// multipart の本文からパート名を拾う。`MockClient` は `BaseRequest` を
    /// 確定させて `Request` に詰め直すので、本文は生のmultipartのまま届く。
    Set<String> partNames(http.BaseRequest request) {
      final String body = utf8.decode(
        (request as http.Request).bodyBytes,
        allowMalformed: true,
      );
      return RegExp(r'name="([^"]+)"')
          .allMatches(body)
          .map((RegExpMatch m) => m.group(1)!)
          .toSet();
    }

    test('問題の写真を足すと、ノートとは別の枠で送る', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      controller.setProblemPhoto(problemPhoto);
      await controller.analyze();

      expect(partNames(calls.single), containsAll(<String>['photo', 'problem_photo']));
    });

    test('足さなければ、問題の枠は送らない(2枚目は任意)', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();

      final Set<String> names = partNames(calls.single);
      expect(names, contains('photo'));
      expect(names, isNot(contains('problem_photo')));
    });

    /// **ノートの必須をやめた**(PM判断。`api.ts` の `sessionPhotoParts` 参照)。
    ///
    /// 必須にしているかぎり、手も付けていない問題を持ってきた生徒は
    /// 紙面をノート枠に入れる以外に送る手段がなく、**解析後破棄の約束が
    /// 自分たちのUI制約で破られていた**。
    test('問題だけでも解析に出せる(ノート枠は送らない)', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setProblemPhoto(problemPhoto);
      await controller.analyze();

      final Set<String> names = partNames(calls.single);
      expect(names, contains('problem_photo'));
      expect(
        names,
        isNot(contains('photo')),
        reason: 'ノートが無いのにノート枠を作ると、そこに何かが入る余地ができる',
      );
    });

    test('どちらも無ければ、サーバへは行かない', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls);
      addTearDown(container.dispose);

      await container.read(captureControllerProvider.notifier).analyze();

      expect(calls, isEmpty);
      expect(container.read(captureControllerProvider).hasAnyPhoto, isFalse);
    });

    /// 先に問題を撮ってからノートを撮り直したときに、2枚目が消えないこと。
    test('ノートを撮り直しても、問題の写真は残る', () async {
      final ProviderContainer container = containerWith(<http.BaseRequest>[]);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setProblemPhoto(problemPhoto);
      controller.setPhoto(photo);

      final CaptureState state = container.read(captureControllerProvider);
      expect(state.photo, isNotNull);
      expect(state.problemPhoto, isNotNull);
    });

    /// あとから足しても写真は読み直されないので、足せるのは解析の前だけにしてある。
    test('解析したあとは、問題の写真を足せない', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();
      controller.setProblemPhoto(problemPhoto);

      expect(container.read(captureControllerProvider).problemPhoto, isNull);
      expect(calls.length, 1);
    });
  });

  group('読み取った問題文', () {
    test('読めていれば、授業の前に見せられる', () async {
      final ProviderContainer container = containerWith(
        <http.BaseRequest>[],
        problem: <String, dynamic>{
          'text': '円 x^2 + y^2 = 5 と直線 y = x + k の共有点の個数を求めよ。',
          'source': 'problem_photo',
        },
      );
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();

      final SessionProblem? problem = container.read(captureControllerProvider).problem;
      expect(problem, isNotNull);
      expect(problem!.text, contains('共有点の個数'));
      expect(problem.source, ProblemSource.problemPhoto);
    });

    /// **読めなかったことを画面に出さない**(黙って進める)。
    /// 警告として出すと、任意のはずの2枚目が事実上の必須になる。
    test('読めなければ null のまま。撮影をやり直させない', () async {
      final ProviderContainer container = containerWith(<http.BaseRequest>[]);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();

      final CaptureState state = container.read(captureControllerProvider);
      expect(state.problem, isNull);
      // 会話には進める。問題文が読めないことは行き止まりの理由にしない。
      expect(state.canStart, isTrue);
    });
  });
}
