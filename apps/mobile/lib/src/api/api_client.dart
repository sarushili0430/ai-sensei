import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../features/karte/domain/karte.dart';
import '../features/session/domain/session.dart';
import 'device_id.dart';

part 'api_client.g.dart';

/// backend/api との通信。
///
/// 認証は匿名デバイスID(`X-Device-Id`)だけ。アカウント作成を要求しない。
class ApiClient {
  ApiClient({required this.baseUrl, required this.deviceId, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl;
  final String deviceId;
  final http.Client _client;

  Map<String, String> get _headers => <String, String>{'x-device-id': deviceId};

  /// 写真を送ってセッションを作る。復習(kind=review)では写真を送らない。
  Future<SessionStart> createSession({
    File? photo,
    String kind = 'new',
    String locale = 'ja',
    String? holeId,
    List<String>? topicIds,
  }) async {
    final http.MultipartRequest request =
        http.MultipartRequest('POST', Uri.parse('$baseUrl/v1/sessions'))
          ..headers.addAll(_headers)
          ..fields['meta'] = jsonEncode(<String, dynamic>{
            'kind': kind,
            'locale': locale,
            // 値が null なら要素ごと落ちる(Dart 3.12 の null-aware element)
            'hole_id': ?holeId,
            if (topicIds != null && topicIds.isNotEmpty) 'topic_ids': topicIds,
          });

    if (photo != null) {
      request.files.add(await http.MultipartFile.fromPath('photo', photo.path));
    }

    final http.Response response =
        await http.Response.fromStream(await _client.send(request));
    return SessionStart.fromJson(_decode(response));
  }

  /// 会話後の結果を取りに行く。カルテ生成が終わるまでサーバは202を返すので、
  /// 生成中は null を返して呼び出し側に待たせる。
  Future<SessionResult?> fetchSessionResult(String sessionId) async {
    final http.Response response = await _client.get(
      Uri.parse('$baseUrl/v1/sessions/$sessionId/result'),
      headers: _headers,
    );
    if (response.statusCode == 202) return null;
    return SessionResult.fromJson(_decode(response));
  }

  /// カルテができるまで待つ。会話の直後は数秒かかる。
  Future<SessionResult?> awaitSessionResult(
    String sessionId, {
    Duration interval = const Duration(seconds: 2),
    int attempts = 15,
  }) async {
    for (int i = 0; i < attempts; i++) {
      final SessionResult? result = await fetchSessionResult(sessionId);
      if (result != null) return result;
      await Future<void>.delayed(interval);
    }
    return null;
  }

  Future<Progress> fetchProgress() async {
    final http.Response response = await _client.get(
      Uri.parse('$baseUrl/v1/me/progress'),
      headers: _headers,
    );
    return Progress.fromJson(_decode(response)['progress'] as Map<String, dynamic>);
  }

  Future<ReviewQueue> fetchReviews() async {
    final http.Response response = await _client.get(
      Uri.parse('$baseUrl/v1/me/reviews'),
      headers: _headers,
    );
    return ReviewQueue.fromJson(_decode(response));
  }

  Map<String, dynamic> _decode(http.Response response) {
    final Map<String, dynamic> body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    if (response.statusCode >= 400) {
      final Map<String, dynamic> error = body['error'] as Map<String, dynamic>? ?? const {};
      throw ApiException(
        code: error['code'] as String? ?? 'internal_error',
        // サーバの文言をそのまま出す。煽らない文体で書かれている。
        message: error['message'] as String? ?? '',
        retryAfterSeconds: error['retry_after_seconds'] as int?,
      );
    }
    return body;
  }
}

class ApiException implements Exception {
  const ApiException({required this.code, required this.message, this.retryAfterSeconds});

  final String code;
  final String message;
  final int? retryAfterSeconds;

  bool get isFreeLimitReached => code == 'free_limit_reached';
  bool get isPremiumRequired => code == 'premium_required';
  bool get isPhotoUnreadable => code == 'photo_unreadable' || code == 'out_of_scope';

  @override
  String toString() => 'ApiException($code): $message';
}

/// `--dart-define=API_BASE_URL=...` で差し替える。
const String apiBaseUrl =
    String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:8787');

@Riverpod(keepAlive: true)
ApiClient apiClient(Ref ref) {
  return ApiClient(baseUrl: apiBaseUrl, deviceId: ref.watch(deviceIdProvider));
}
