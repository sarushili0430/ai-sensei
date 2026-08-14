import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../features/karte/domain/karte.dart';
import '../features/parent_report/domain/parent_report.dart';
import '../features/plan/domain/study_plan.dart';
import '../features/session/domain/session.dart';
import 'device_id.dart';

part 'api_client.g.dart';

/// Talks to backend/api.
///
/// Auth is the anonymous device ID (`X-Device-Id`) alone; no account needed.
class ApiClient {
  ApiClient({
    required this.baseUrl,
    required this.deviceId,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String baseUrl;
  final String deviceId;
  final http.Client _client;

  /// Per-request ceiling.
  ///
  /// `http` waits forever by default. On a failing signal a connection can stay
  /// open and never return, freezing the screen; failing instead lets the layer
  /// above offer a retry.
  static const Duration _timeout = Duration(seconds: 15);

  /// Photo uploads have a large body, so they get their own longer timeout.
  static const Duration _uploadTimeout = Duration(seconds: 45);

  Map<String, String> get _headers => <String, String>{'x-device-id': deviceId};

  /// Creates a session from a photo. Review (kind=review) sends no photo.
  ///
  /// The response carries only the analysis, never the room key: the daily
  /// allowance is spent by [startSession] when the conversation begins, so the
  /// photo can be retaken freely up to that point.
  ///
  /// The two photos travel in separate parts because their lifetimes differ
  /// (`sessionPhotoParts` in `api.ts`):
  ///
  /// | Part | Content | Storage |
  /// | --- | --- | --- |
  /// | `photo` | the student's notes (their own work) | kept in R2 |
  /// | `problem_photo` | textbook or workbook page (someone else's work) | discarded after analysis |
  ///
  /// The part is the only thing telling them apart: send a problem page in the
  /// notes part and the server stores it as notes. Choosing the part is the
  /// UI's responsibility; this method just forwards what it is given.
  Future<SessionAnalysis> createSession({
    File? photo,
    File? problemPhoto,
    String kind = 'new',
    String locale = 'ja',
    /// School stage, sent to narrow the topic search (`schoolStages` in
    /// `packages/contract`). Omitted, the server defaults to senior high.
    String schoolStage = 'high_school',
    String? holeId,
    List<String>? topicIds,
  }) async {
    final http.MultipartRequest request =
        http.MultipartRequest('POST', Uri.parse('$baseUrl/v1/sessions'))
          ..headers.addAll(_headers)
          ..fields['meta'] = jsonEncode(<String, dynamic>{
            'kind': kind,
            'locale': locale,
            'school_stage': schoolStage,
            // A null value drops the whole element (Dart 3.12 null-aware element)
            'hole_id': ?holeId,
            if (topicIds != null && topicIds.isNotEmpty) 'topic_ids': topicIds,
          });

    // Without a Content-Type this is sent as application/octet-stream. Once
    // image_picker has applied imageQuality the photo is JPEG, so say so (the
    // server still decides from the bytes).
    if (photo != null) {
      request.files.add(
        await http.MultipartFile.fromPath(
          'photo',
          photo.path,
          contentType: MediaType('image', 'jpeg'),
        ),
      );
    }
    if (problemPhoto != null) {
      request.files.add(
        await http.MultipartFile.fromPath(
          'problem_photo',
          problemPhoto.path,
          contentType: MediaType('image', 'jpeg'),
        ),
      );
    }

    final http.Response response = await http.Response.fromStream(
      await _client.send(request),
    ).timeout(_uploadTimeout);
    return SessionAnalysis.fromJson(_decode(response));
  }

  /// Pushes topics deselected in the chip UI to the server.
  ///
  /// The session is not recreated: that would re-run the same photo through the
  /// vision LLM and double-count against the analysis limit.
  Future<SessionAnalysis> updateSessionTopics({
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
          body: jsonEncode(<String, dynamic>{
            'locale': locale,
            'topic_ids': topicIds,
          }),
        )
        .timeout(_timeout);
    return SessionAnalysis.fromJson(_decode(response));
  }

  /// Starts the conversation. This is where the day's single use is spent.
  ///
  /// The room key exists only in this response. Reserving the slot and issuing
  /// the token are one server-side operation, so a key means the slot is held;
  /// otherwise `free_limit_reached` / `fair_use_limit_reached` comes back.
  ///
  /// Retrying within the same session is not double-counted (the server keeps
  /// the slot it first reserved and reissues only the token), so it is safe to
  /// resend after a dropped connection.
  Future<SessionStart> startSession({
    required String sessionId,
    String locale = 'ja',
  }) async {
    final http.Response response = await _client
        .post(
          Uri.parse('$baseUrl/v1/sessions/$sessionId/start'),
          headers: <String, String>{
            ..._headers,
            'content-type': 'application/json; charset=utf-8',
          },
          // locale only sets the error-message language; the conversation's
          // language comes from the topic's curriculum.
          body: jsonEncode(<String, dynamic>{'locale': locale}),
        )
        .timeout(_timeout);
    return SessionStart.fromJson(_decode(response));
  }

  /// Fetches the post-conversation result. The server returns 202 until the
  /// karte is generated, so this returns null and lets the caller wait.
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

  /// Waits for the karte to be ready.
  ///
  /// After the conversation ends, the agent takes seconds to tens of seconds to
  /// write the karte with an LLM and post it to `/complete`. Callers should wait
  /// in short slices: waiting it out on the conversation screen creates a
  /// stretch where taps do nothing. Whatever is left over is picked up by the
  /// celebration screen.
  ///
  /// No wait after the final attempt — that would freeze the screen for one
  /// extra `interval` after we have already decided to give up.
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

  Future<ParentReportResponse> fetchParentReport() async {
    final http.Response response = await _client
        .get(Uri.parse('$baseUrl/v1/me/parent-report'), headers: _headers)
        .timeout(_timeout);
    return ParentReportResponse.fromJson(_decode(response));
  }

  /// Self-reported quiz result. No voice, no connection, zero cost.
  Future<ReviewAnswer> answerReview(
    String holeId,
    ReviewOutcome outcome,
  ) async {
    final http.Response response = await _client
        .post(
          Uri.parse('$baseUrl/v1/me/reviews/$holeId'),
          headers: <String, String>{
            ..._headers,
            'content-type': 'application/json; charset=utf-8',
          },
          body: jsonEncode(<String, dynamic>{
            'outcome': switch (outcome) {
              ReviewOutcome.saidIt => 'said_it',
              ReviewOutcome.notYet => 'not_yet',
            },
          }),
        )
        .timeout(_timeout);
    return ReviewAnswer.fromJson(_decode(response));
  }

  /// Opens the voice room for planning. Separate from a lesson session, so it
  /// sends neither photo nor kind.
  Future<PlanSessionStart> createPlanSession({
    String locale = 'ja',
    String schoolStage = 'high_school',
  }) async {
    final http.Response response = await _client
        .post(
          Uri.parse('$baseUrl/v1/plans'),
          headers: <String, String>{
            ..._headers,
            'content-type': 'application/json; charset=utf-8',
          },
          body: jsonEncode(<String, dynamic>{
            'locale': locale,
            // Planning has no photo, so the stage is the only way to narrow.
            'school_stage': schoolStage,
          }),
        )
        .timeout(_timeout);
    return PlanSessionStart.fromJson(_decode(response));
  }

  /// The current plan. Not created yet means `plan: null`, not 404, so the
  /// caller can go straight into the creation flow.
  Future<StudyPlan?> fetchPlan() async {
    final http.Response response = await _client
        .get(Uri.parse('$baseUrl/v1/me/plan'), headers: _headers)
        .timeout(_timeout);
    final Map<String, dynamic> body = _decode(response);
    final Map<String, dynamic>? plan = body['plan'] as Map<String, dynamic>?;
    return plan == null ? null : StudyPlan.fromJson(plan);
  }

  Map<String, dynamic> _decode(http.Response response) {
    final Map<String, dynamic> body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    if (response.statusCode >= 400) {
      final Map<String, dynamic> error =
          body['error'] as Map<String, dynamic>? ?? const {};
      throw ApiException(
        code: error['code'] as String? ?? 'internal_error',
        // Show the server's wording as is; it is written not to nag.
        message: error['message'] as String? ?? '',
        retryAfterSeconds: error['retry_after_seconds'] as int?,
      );
    }
    return body;
  }
}

class ApiException implements Exception {
  const ApiException({
    required this.code,
    required this.message,
    this.retryAfterSeconds,
  });

  final String code;
  final String message;
  final int? retryAfterSeconds;

  bool get isFreeLimitReached => code == 'free_limit_reached';
  bool get isFairUseLimitReached => code == 'fair_use_limit_reached';
  bool get isPremiumRequired => code == 'premium_required';
  bool get isPhotoUnreadable =>
      code == 'photo_unreadable' || code == 'out_of_scope';
  bool get isHoleNotFound => code == 'hole_not_found';

  /// The session is gone (someone else's, already completed, or retried past
  /// the time limit). Retrying the same ID returns the same 404, so discard the
  /// held ID and create a new session.
  bool get isSessionNotFound => code == 'session_not_found';

  @override
  String toString() => 'ApiException($code): $message';
}

/// Exposes just the code check the billing flow needs, without leaking the API
/// exception type. Parsing `toString()` upstream would break the branch as soon
/// as the wording changed.
bool isPremiumRequiredApiError(Object error) =>
    error is ApiException && error.isPremiumRequired;

/// Overridden with `--dart-define=API_BASE_URL=...`.
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:8787',
);

@Riverpod(keepAlive: true)
ApiClient apiClient(Ref ref) {
  return ApiClient(baseUrl: apiBaseUrl, deviceId: ref.watch(deviceIdProvider));
}
