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

/// backend/api との通信。
///
/// 認証は匿名デバイスID(`X-Device-Id`)だけ。アカウント作成を要求しない。
class ApiClient {
  ApiClient({
    required this.baseUrl,
    required this.deviceId,
    http.Client? client,
  }) : _client = client ?? http.Client();

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
  ///
  /// **返るのは解析の結果だけで、部屋の鍵は入っていない。**
  /// 日次の持ち時間を押さえるのは [startSession](= 会話が始まったとき)なので、
  /// ここまでは何度でも撮り直せる。
  ///
  /// **2枚の写真は別のパートで送る。寿命が違うから**(`api.ts` の `sessionPhotoParts`):
  ///
  /// | パート | 中身 | 保存 |
  /// | --- | --- | --- |
  /// | `photo` | 生徒のノート(本人の著作物) | R2に保存する |
  /// | `problem_photo` | 教科書・問題集の紙面(**他者の著作物**) | **解析後に破棄する** |
  ///
  /// **どちらの枠に入れたかでしか区別できない。** 問題の紙面をノート枠で送ると、
  /// サーバはそれをノートとして保存する。だから枠の選択はUIの責務で、
  /// ここは渡されたものをそのまま対応するパートに載せるだけにしてある。
  Future<SessionAnalysis> createSession({
    File? photo,
    File? problemPhoto,
    String kind = 'new',
    String locale = 'ja',
    /// 学校段階。単元を探す範囲を絞るために送る(`packages/contract` の
    /// `schoolStages`)。省略するとサーバ側の既定「高校生」になる。
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
            // 値が null なら要素ごと落ちる(Dart 3.12 の null-aware element)
            'hole_id': ?holeId,
            if (topicIds != null && topicIds.isNotEmpty) 'topic_ids': topicIds,
          });

    // Content-Type を渡さないと application/octet-stream で送られる。
    // 撮った写真は image_picker が imageQuality を掛けた時点でJPEGなので、
    // そう伝える(サーバ側は最終的に中身を見て判断する)。
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

  /// チップUIで外した単元をサーバへ反映する。
  ///
  /// セッションは作り直さない。作り直すと同じ写真をもう一度Vision LLMに通すことになり、
  /// 解析の回数だけを見ている上限にも二重に当たる。
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

  /// 問題文を、生徒が打ち直したもので置き換える。
  ///
  /// **読めなかったときの救済と、誤読の訂正。** 問題の紙面は解析後に破棄されるので、
  /// あとから機械が読み直す手段は無い — ここが**授業が始まる前に直せる唯一の口**。
  /// これが無かったとき、読めなかったセッションは
  /// 「問題、読んでもらってもいい?」から始まり、**画面に見えている問題を、
  /// 生徒がもう一度声で入れ直させられていた。**
  ///
  /// **写真は送らない。** サーバもVision LLMを回さないので、解析の枠を消費しない。
  ///
  /// 本文はサーバ側のガードレールを通る(解答が混ざっていれば `problem_unreadable`)。
  /// **落ちたときに黙って進めない**ので、[ApiException] はそのまま投げる。
  Future<SessionAnalysis> updateSessionProblem({
    required String sessionId,
    required String text,
    String locale = 'ja',
  }) async {
    final http.Response response = await _client
        .patch(
          Uri.parse('$baseUrl/v1/sessions/$sessionId/problem'),
          headers: <String, String>{
            ..._headers,
            'content-type': 'application/json; charset=utf-8',
          },
          body: jsonEncode(<String, dynamic>{
            'locale': locale,
            'text': text,
          }),
        )
        .timeout(_timeout);
    return SessionAnalysis.fromJson(_decode(response));
  }

  /// 会話を始める。**ここで日次の持ち時間を仮押さえする。**
  ///
  /// 部屋の鍵はこの応答にしか無い。枠の確保とトークンの発行はサーバ側の
  /// 同じ1操作なので、鍵が返ってきたなら時間は取れているし、取れなければ
  /// `free_limit_reached` / `fair_use_limit_reached` が返る。
  ///
  /// **同じセッションで押し直しても二重には確保しない**(サーバが最初に押さえた
  /// 時間のままトークンだけ出し直す)ので、通信が切れたときはそのまま再送してよい。
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
          // locale はエラー文言の言語だけ。会話の言語は単元の課程で決まる。
          body: jsonEncode(<String, dynamic>{'locale': locale}),
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

  Future<ParentReportResponse> fetchParentReport() async {
    final http.Response response = await _client
        .get(Uri.parse('$baseUrl/v1/me/parent-report'), headers: _headers)
        .timeout(_timeout);
    return ParentReportResponse.fromJson(_decode(response));
  }

  /// 小テストの自己申告。**声も接続も使わない**(原価ゼロ)。
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

  /// 計画を作る音声ルームを開く。授業セッションとは別なので写真もkindも送らない。
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
            // 計画は写真が無いので、段でしか範囲を絞れない。
            'school_stage': schoolStage,
          }),
        )
        .timeout(_timeout);
    return PlanSessionStart.fromJson(_decode(response));
  }

  /// 現行計画。未作成は404ではなく `plan: null` なので、そのまま作成導線へ移れる。
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
        // サーバの文言をそのまま出す。煽らない文体で書かれている。
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

  /// セッションが消えている(他人のもの・完了済み・上限時間を過ぎた押し直し)。
  /// **同じIDで押し直しても同じ404が返る**ので、握っているIDは捨てて作り直す。
  bool get isSessionNotFound => code == 'session_not_found';

  @override
  String toString() => 'ApiException($code): $message';
}

/// API例外の型をファイル外へ漏らさず、課金導線に必要なcode判定だけを公開する。
/// 文字列の `toString()` を上位で解析すると、文言を直しただけで分岐が壊れるため。
bool isPremiumRequiredApiError(Object error) =>
    error is ApiException && error.isPremiumRequired;

/// `--dart-define=API_BASE_URL=...` で差し替える。
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:8787',
);

@Riverpod(keepAlive: true)
ApiClient apiClient(Ref ref) {
  return ApiClient(baseUrl: apiBaseUrl, deviceId: ref.watch(deviceIdProvider));
}
