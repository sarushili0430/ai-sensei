import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 撮影 → 単元の確認 → 会話開始。
///
/// 不具合報告: この「会話開始」の瞬間に「今日のセッションは終わり」と出た。
/// 単元を確認しただけでセッションを作り直していたため、写真解析で押さえた
/// 1回に加えてもう1回を要求し、無料枠(1日1回)に自分でぶつかっていた。

Map<String, dynamic> _sessionJson(String sessionId, List<String> topicIds) {
  return <String, dynamic>{
    'session_id': sessionId,
    'kind': 'new',
    'livekit': <String, dynamic>{
      'url': 'wss://test.livekit.cloud',
      'token': 'token-for-${topicIds.join("+")}',
      'room': sessionId,
    },
    'detected_topics': <Map<String, dynamic>>[
      for (final String topicId in topicIds)
        <String, dynamic>{
          'topic_id': topicId,
          'course': '数学I',
          'unit': '2次関数',
          'topic': topicId,
          // 2つ目以降は確信度を低くして、はじめから外れている状態を作る
          'confidence': topicId == topicIds.first ? 0.92 : 0.41,
        },
    ],
    'limits': <String, dynamic>{'max_seconds': 300, 'remaining_sessions_today': 0},
  };
}

void main() {
  late Directory tempDir;
  late File photo;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('capture_flow_test');
    photo = File('${tempDir.path}/note.jpg')..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0x00]);
  });

  tearDown(() => tempDir.deleteSync(recursive: true));

  /// 呼ばれたリクエストを順に記録するAPIクライアント。
  ProviderContainer containerWith(List<http.BaseRequest> calls) {
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
        return json(_sessionJson('ses_1', topicIds), 200);
      }
      return json(_sessionJson('ses_1', <String>['M1-NIJI-GURAFU', 'M1-NIJI-HANBETSU']), 201);
    });

    // Riverpod 3 は `Override` 型を公開APIに出していないので、`cast()` の型は
    // ProviderContainer 側から推論させる(test/support/harness.dart と同じ理由)。
    final List<Object?> overrides = <Object?>[
      apiClientProvider.overrideWithValue(
        ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: client),
      ),
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
    // 同じセッションのまま。ここが2本目のPOSTだと無料枠を使い切ってしまう
    expect(session!.sessionId, 'ses_1');
    expect(calls.length, 2);
    expect(calls[0].method, 'POST');
    expect(calls[0].url.path, '/v1/sessions');
    expect(calls[1].method, 'PATCH');
    expect(calls[1].url.path, '/v1/sessions/ses_1/topics');
  });

  test('単元をひとつも外していなければ、サーバへは行かない', () async {
    final List<http.BaseRequest> calls = <http.BaseRequest>[];
    final ProviderContainer container = containerWith(calls);
    addTearDown(container.dispose);

    final CaptureController controller = container.read(captureControllerProvider.notifier);
    controller.setPhoto(photo);
    await controller.analyze();
    // 外れていた候補を戻して、解析どおりの状態にする
    controller.toggleTopic('M1-NIJI-HANBETSU');

    await controller.confirmAndStart();

    expect(calls.length, 1);
  });
}
