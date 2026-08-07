import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
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

  /// 1リクエストの上限。
  ///
  /// `http` は既定で待ち続ける。電波が切れかけている場所では接続が張られたまま
  /// 返ってこないことがあり、そのまま待つと**画面が固まる**。
  /// 失敗として返せば、上の層が「もう一度」を出せる。
  static const Duration _timeout = Duration(seconds: 15);

  /// 写真のアップロードは本文が大きいぶん長い。ここだけ別に持つ。
  static const Duration _uploadTimeout = Duration(seconds: 45);

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
      // Content-Type を渡さないと application/octet-stream で送られる。
      // 撮った写真は image_picker が imageQuality を掛けた時点でJPEGなので、
      // そう伝える(サーバ側は最終的に中身を見て判断する)。
      request.files.add(
        await http.MultipartFile.fromPath(
          'photo',
          photo.path,
          contentType: MediaType('image', 'jpeg'),
        ),
      );
    }

    final http.Response response = await http.Response
        .fromStream(await _client.send(request))
        .timeout(_uploadTimeout);
    return SessionStart.fromJson(_decode(response));
  }

  /// チップUIで外した単元をサーバへ反映する。
  ///
  /// セッションは作り直さない。作り直すと同じ写真で2回目のセッションになり、
  /// 無料枠(1日1回)を使い切って、会話を始める瞬間に「今日はここまで」と
  /// 返されてしまう。
  Future<SessionStart> updateSessionTopics({
    required String sessionId,
    required List<String> topicIds,
    String locale = 'ja',
  }) async {
    final http.Response response = await _client
        .patch(
          Uri.parse('$baseUrl/v1/sessions/$sessionId/topics'),
          headers: <String, String>{
            ..._headers,
            'content-type': 'application/json; charset=utf-8',
          },
          body: jsonEncode(<String, dynamic>{'locale': locale, 'topic_ids': topicIds}),
        )
        .timeout(_timeout);
    return SessionStart.fromJson(_decode(response));
  }

  /// 会話後の結果を取りに行く。カルテ生成が終わるまでサーバは202を返すので、
  /// 生成中は null を返して呼び出し側に待たせる。
  Future<SessionResult?> fetchSessionResult(String sessionId) async {
    final http.Response response = await _client
        .get(
          Uri.parse('$baseUrl/v1/sessions/$sessionId/result'),
          headers: _headers,
        )
        .timeout(_timeout);
    if (response.statusCode == 202) return null;
    return SessionResult.fromJson(_decode(response));
  }

  /// カルテができるまで待つ。
  ///
  /// 会話が終わってから、エージェントがLLMでカルテを書いて `/complete` に送るまで
  /// 数秒〜十数秒かかる。**呼ぶ側は短く区切って待つこと**(会話画面で待ちきると、
  /// 終わってから画面が変わるまで押しても何も起きない時間になる)。
  /// 待ちきれなかったぶんは、祝福画面が受け取りに行く。
  ///
  /// 最後の1回のあとには待たない。待つと、諦めると決めたあとに
  /// `interval` ぶんだけ余計に画面が止まる。
  Future<SessionResult?> awaitSessionResult(
    String sessionId, {
    Duration interval = const Duration(seconds: 2),
    int attempts = 5,
  }) async {
    for (int i = 0; i < attempts; i++) {
      final SessionResult? result = await fetchSessionResult(sessionId);
      if (result != null) return result;
      if (i < attempts - 1) await Future<void>.delayed(interval);
    }
    return null;
  }

  Future<ProgressSummary> fetchProgress() async {
    final http.Response response = await _client
        .get(Uri.parse('$baseUrl/v1/me/progress'), headers: _headers)
        .timeout(_timeout);
    return ProgressSummary.fromJson(_decode(response));
  }

  Future<ReviewQueue> fetchReviews() async {
    final http.Response response = await _client
        .get(Uri.parse('$baseUrl/v1/me/reviews'), headers: _headers)
        .timeout(_timeout);
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
