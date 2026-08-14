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

/// Capture -> topic confirmation -> conversation start.
///
/// Reported bug: shooting a photo and confirming the topic alone reported
/// "today's session is over". The day's use is now counted when the conversation
/// starts (`POST /v1/sessions/{id}/start`), so these tests check which action
/// hits which endpoint.

/// The photo-analysis response. It carries no room key: holding one would mean
/// being able to start any time, defeating the move of where use is counted.
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
          // Lower confidence from the second onwards, so they start deselected.
          'confidence': topicId == topicIds.first ? 0.92 : 0.41,
        },
    ],
  };
}

/// The conversation-start response. Receiving it spends the day's use.
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

  /// Where the school stage is stored. It is sent as `school_stage` at session
  /// creation, so without it `schoolStageControllerProvider` cannot start and no
  /// request goes out.
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

  /// An API client recording requests in order.
  ///
  /// [failStartTimes] fails the conversation start for the first n attempts,
  /// reproducing a dropped connection, so a retry can be checked not to recreate
  /// the session.
  ProviderContainer containerWith(
    List<http.BaseRequest> calls, {
    Map<String, dynamic>? problem,
    int failStartTimes = 0,
    String? startErrorCode,
  }) {
    int startCalls = 0;
    // The server returns UTF-8 (topic names contain Japanese). `http.Response`'s
    // string form is latin1, so it must be returned as bytes or this breaks.
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
        startCalls += 1;
        if (startCalls <= failStartTimes) {
          // A response with no code becomes internal_error in ApiClient, the
          // same as being offline.
          return json(
            startErrorCode == null
                ? <String, dynamic>{}
                : <String, dynamic>{
                    'error': <String, dynamic>{
                      'code': startErrorCode,
                      'message': 'このセッションは見つかりませんでした。',
                    },
                  },
            startErrorCode == null ? 500 : 404,
          );
        }
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

    // Riverpod 3 does not expose the `Override` type, so `cast()`'s type is
    // inferred from ProviderContainer (as in test/support/harness.dart).
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

    // Low-confidence candidates start deselected, so the start must push them.
    expect(container.read(captureControllerProvider).excludedTopicIds, <String>{
      'M1-NIJI-HANBETSU',
    });

    final SessionStart? session = await controller.confirmAndStart();

    expect(session, isNotNull);
    // Still the same session. A second POST /v1/sessions here would re-run the
    // same photo through the vision LLM.
    expect(session!.sessionId, 'ses_1');
    expect(calls.length, 3);
    expect(calls[0].method, 'POST');
    expect(calls[0].url.path, '/v1/sessions');
    expect(calls[1].method, 'PATCH');
    expect(calls[1].url.path, '/v1/sessions/ses_1/topics');
    // The room key comes only from here, so this is where the day's use is spent.
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
    // Re-select the deselected candidate, matching the analysis exactly.
    controller.toggleTopic('M1-NIJI-HANBETSU');

    await controller.confirmAndStart();

    expect(calls.map((http.BaseRequest call) => call.url.path), <String>[
      '/v1/sessions',
      '/v1/sessions/ses_1/start',
    ]);
  });

  /// Only the conversation start failed (a dropped connection).
  ///
  /// A retry must not recreate the session. The server does not double-count the
  /// same ID, so recreating is the risky path: if the first start had arrived, it
  /// throws that use away.
  group('会話の開始で切れたとき', () {
    test('押し直しは、同じセッションを始め直す', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls, failStartTimes: 1);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();

      expect(await controller.confirmAndStart(), isNull);
      // The analysis is retained; discarding it would force a retake.
      expect(container.read(captureControllerProvider).analysis, isNotNull);

      final SessionStart? session = await controller.confirmAndStart();

      expect(session, isNotNull);
      expect(
        calls.where((http.BaseRequest call) => call.url.path == '/v1/sessions').length,
        1,
        reason: 'セッションを作り直すと、押さえた枠を捨てることになる',
      );
      expect(
        calls.where((http.BaseRequest call) => call.url.path.endsWith('/start')).length,
        2,
      );
    });

    test('復習も、同じセッションを始め直す', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(calls, failStartTimes: 1);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      expect(await controller.startReview('hol_1'), isNull);
      expect(await controller.startReview('hol_1'), isNotNull);

      expect(
        calls.where((http.BaseRequest call) => call.url.path == '/v1/sessions').length,
        1,
        reason: '作り直すと、Premiumの枠をもう1回使ってしまう',
      );
    });

    /// A retry past the time limit gets a 404. Holding the same ID would make
    /// every retry repeat that 404, a dead end.
    test('セッションが消えていたら、握っている解析ごと捨てる', () async {
      final List<http.BaseRequest> calls = <http.BaseRequest>[];
      final ProviderContainer container = containerWith(
        calls,
        failStartTimes: 1,
        startErrorCode: 'session_not_found',
      );
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();
      expect(await controller.confirmAndStart(), isNull);

      final CaptureState state = container.read(captureControllerProvider);
      expect(state.analysis, isNull);
      expect(state.error?.isSessionNotFound, isTrue);
      // The photo is kept, so it restarts from analysis rather than a retake.
      expect(state.photo, isNotNull);
    });
  });

  /// The reported bug itself: shooting and confirming the topic consumed the
  /// day's use. Not calling `/start` until the conversation begins is exactly
  /// what "not counted" means.
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

  /// The two photos' parts (`sessionPhotoParts` in `api.ts`).
  ///
  /// Notes are the student's own work and are stored in R2; the problem page is
  /// someone else's and is discarded after analysis. The part is the only thing
  /// the server can tell them apart by, so if this breaks, textbook pages are
  /// silently stored forever.
  group('問題の写真の枠', () {
    /// Extracts part names from the multipart body. `MockClient` finalizes the
    /// `BaseRequest` into a `Request`, so the body arrives as raw multipart.
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

    /// Notes are no longer required (see `sessionPhotoParts` in `api.ts`).
    ///
    /// While they were, a student who brought an untouched problem had no way to
    /// send it but the notes slot, and our own UI constraint broke the
    /// discard-after-analysis promise.
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

    /// Shooting the problem first and then retaking notes must not lose it.
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

    /// Adding one later would not be re-read, so it is only allowed before
    /// analysis.
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

    /// A failed read is not surfaced; it carries on silently. As a warning it
    /// would make the optional second photo effectively mandatory.
    test('読めなければ null のまま。撮影をやり直させない', () async {
      final ProviderContainer container = containerWith(<http.BaseRequest>[]);
      addTearDown(container.dispose);

      final CaptureController controller = container.read(captureControllerProvider.notifier);
      controller.setPhoto(photo);
      await controller.analyze();

      final CaptureState state = container.read(captureControllerProvider);
      expect(state.problem, isNull);
      // The conversation still starts; an unreadable problem is not a dead end.
      expect(state.canStart, isTrue);
    });
  });
}
