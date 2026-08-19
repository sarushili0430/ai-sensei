import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/features/session/application/session_control.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart';

Map<String, dynamic> loadControlFixture() =>
    jsonDecode(
          File(
            '../../packages/contract/fixtures/session-control-request.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

void main() {
  test('context更新は専用RPCへrevisionだけを送り、問題文を混ぜない', () async {
    PerformRpcParams? sent;
    final SessionControlClient client = SessionControlClient((
      PerformRpcParams params,
    ) async {
      sent = params;
      return jsonEncode(<String, dynamic>{'v': 1, 'accepted': true});
    });
    final Map<String, dynamic> fixture = loadControlFixture();

    await client.contextUpdated(
      destinationIdentity: 'agent_1',
      sessionId: fixture['session_id'] as String,
      contextRevision: fixture['context_revision'] as int,
    );

    expect(sent?.method, sessionControlRpcMethod);
    expect(sent?.destinationIdentity, 'agent_1');
    final Map<String, dynamic> payload =
        jsonDecode(sent!.payload) as Map<String, dynamic>;
    expect(payload, fixture);
    expect(payload, isNot(contains('problem_text')));
    expect(payload, isNot(contains('allowed_topic_ids')));
  });

  test('解析開始と失敗もlk.chatではなく同じ制御RPCを使う', () async {
    final List<PerformRpcParams> calls = <PerformRpcParams>[];
    final SessionControlClient client = SessionControlClient((
      PerformRpcParams params,
    ) async {
      calls.add(params);
      return '{"v":1,"accepted":true}';
    });

    await client.problemPhotoAnalyzing(
      destinationIdentity: 'agent_1',
      sessionId: 'ses_1',
    );
    await client.problemPhotoFailed(
      destinationIdentity: 'agent_1',
      sessionId: 'ses_1',
    );

    expect(
      calls.map((PerformRpcParams call) => call.method),
      everyElement(sessionControlRpcMethod),
    );
    expect(
      calls.map(
        (PerformRpcParams call) =>
            (jsonDecode(call.payload) as Map<String, dynamic>)['type'],
      ),
      <String>['problem_photo_analyzing', 'problem_photo_failed'],
    );
  });

  test('壊れたackを成功扱いにしない', () async {
    final SessionControlClient client = SessionControlClient((_) async => '{}');
    await expectLater(
      client.problemPhotoAnalyzing(
        destinationIdentity: 'agent_1',
        sessionId: 'ses_1',
      ),
      throwsFormatException,
    );
  });
}
