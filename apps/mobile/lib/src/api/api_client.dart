import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../features/karte/domain/karte.dart';
import '../features/session/domain/session.dart';
import 'device_id.dart';

/// workers/api との通信。
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
            if (holeId != null) 'hole_id': holeId,
            if (topicIds != null && topicIds.isNotEmpty) 'topic_ids': topicIds,
          });

    if (photo != null) {
      request.files.add(await http.MultipartFile.fromPath('photo', photo.path));
    }

    final http.Response response =
        await http.Response.fromStream(await _client.send(request));
    return SessionStart.fromJson(_decode(response));
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

final Provider<ApiClient> apiClientProvider = Provider<ApiClient>((Ref ref) {
  final String deviceId = ref.watch(deviceIdProvider);
  return ApiClient(baseUrl: apiBaseUrl, deviceId: deviceId);
});
