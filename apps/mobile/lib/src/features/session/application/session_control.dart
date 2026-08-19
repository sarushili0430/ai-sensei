import 'dart:convert';

import 'package:livekit_client/livekit_client.dart';

/// TypeScript契約 `sessionControlRpcMethod` の写し。fixtureテストで同じ値を検査する。
const String sessionControlRpcMethod = 'ai-sensei.session-control';
const int sessionControlProtocolVersion = 1;

typedef PerformSessionRpc = Future<String> Function(PerformRpcParams params);

/// app → agent の制御通知。
///
/// 本人の発話ではないので `lk.chat` は使わない。payloadに問題文・解析結果・
/// 許可単元を入れるメソッド自体を用意せず、agentが内部APIから正本を読み直す。
class SessionControlClient {
  const SessionControlClient(this._performRpc);

  final PerformSessionRpc _performRpc;

  Future<void> problemPhotoAnalyzing({
    required String destinationIdentity,
    required String sessionId,
  }) => _send(
    destinationIdentity: destinationIdentity,
    body: <String, dynamic>{
      'v': sessionControlProtocolVersion,
      'type': 'problem_photo_analyzing',
      'session_id': sessionId,
    },
  );

  Future<void> contextUpdated({
    required String destinationIdentity,
    required String sessionId,
    required int contextRevision,
  }) => _send(
    destinationIdentity: destinationIdentity,
    body: <String, dynamic>{
      'v': sessionControlProtocolVersion,
      'type': 'context_updated',
      'session_id': sessionId,
      'context_revision': contextRevision,
    },
  );

  Future<void> problemPhotoFailed({
    required String destinationIdentity,
    required String sessionId,
  }) => _send(
    destinationIdentity: destinationIdentity,
    body: <String, dynamic>{
      'v': sessionControlProtocolVersion,
      'type': 'problem_photo_failed',
      'session_id': sessionId,
    },
  );

  Future<void> _send({
    required String destinationIdentity,
    required Map<String, dynamic> body,
  }) async {
    final String raw = await _performRpc(
      PerformRpcParams(
        destinationIdentity: destinationIdentity,
        method: sessionControlRpcMethod,
        payload: jsonEncode(body),
        // SDKは8秒未満を8秒に丸める。API再読込まで含むので既定15秒を明示する。
        responseTimeoutMs: const Duration(seconds: 15),
      ),
    );
    final Object? decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic> ||
        decoded['v'] != sessionControlProtocolVersion ||
        decoded['accepted'] != true) {
      throw const FormatException('agentからの制御RPC応答が契約と一致しません');
    }
  }
}
