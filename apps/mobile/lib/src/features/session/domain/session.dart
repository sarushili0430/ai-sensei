import 'package:freezed_annotation/freezed_annotation.dart';

import '../../karte/domain/karte.dart';

part 'session.freezed.dart';
part 'session.g.dart';

/// セッション関連のモデル。正は `packages/contract`。

@freezed
abstract class DetectedTopic with _$DetectedTopic {
  const DetectedTopic._();

  const factory DetectedTopic({
    @JsonKey(name: 'topic_id') required String topicId,
    required String course,
    required String unit,
    required String topic,

    /// チップに出す短い課程名。「中1」「数学I」「Algebra 2」。
    ///
    /// **サーバが計算したものをそのまま出す。** topic_id の接頭辞から
    /// 端末側で引く作りにすると、接頭辞の対応表がここで4か所目になる。
    required String label,

    /// 0..1。低いものは選択済みにせず、候補として並べるだけにする。
    required double confidence,
  }) = _DetectedTopic;

  factory DetectedTopic.fromJson(Map<String, dynamic> json) => _$DetectedTopicFromJson(json);

  bool get isConfident => confidence >= 0.5;
}

/// 問題文をどの写真から読んだか(`api.ts` の `problemSources`)。
///
/// **画面の出しわけには使っていない。** 読めたときは出どころに関係なく
/// 問題文をそのまま見せる([SessionProblem] 参照)。ここを持っているのは、
/// 契約が `text` と `source` を1オブジェクトで縛っているから
/// (「本文はあるが出どころが無い」を表現できなくするため)と、
/// **実際に何割の生徒が2枚送っているかが、この値でしか観測できない**ため。
enum ProblemSource {
  @JsonValue('problem_photo')
  problemPhoto,
  @JsonValue('notes_photo')
  notesPhoto,

  /// 生徒が自分で打ち直したもの。**写真ではない。**
  ///
  /// 読めなかったときの救済と、誤読の訂正がここに入る
  /// ([ApiClient.updateSessionProblem])。
  @JsonValue('manual')
  manual,
}

/// 写真から問題文を取り出せたか。取り出せなかったなら、**どう落ちたか**
/// (`api.ts` の `problemOutcomes`)。
///
/// **画面の文言がこれで変わる。** 「読み取れませんでした」だけを返すと、
/// 生徒には直しようのない行き止まりに見える。紙面を丸ごと撮っているのか
/// ([tooLong])、解答まで写っているのか([solutionIncluded])が分かれば、
/// 次の一手を名指しできる。
enum ProblemOutcome {
  @JsonValue('read')
  read,
  @JsonValue('not_found')
  notFound,
  @JsonValue('too_long')
  tooLong,
  @JsonValue('solution_included')
  solutionIncluded,
  @JsonValue('not_a_problem')
  notAProblem,
}

/// 問題文の上限。**正は `packages/contract` の `problemTextMaxLength`。**
///
/// ここに写しを置いているのは、入力欄がこの数で止まるため。サーバに弾かれてから
/// 直すのでは往復が1つ増える。契約側を動かしたら、ここも一緒に動かすこと。
const int problemTextMaxLength = 600;

/// このセッションが扱う問題。**読み取れたときだけ存在する。**
///
/// 授業を始める前に画面へ出す。**誤読が表面化するのがここで最も早い**からで、
/// 15分教わったあとに「それ別の問題です」となるのと、開始前に気づくのとでは
/// 価値がまったく違う(計画書 §1-1「AIが理解している建て付けのアプリほど
/// 誤読が致命傷になる」への、授業前の手当て)。
@freezed
abstract class SessionProblem with _$SessionProblem {
  const factory SessionProblem({
    required String text,
    required ProblemSource source,
  }) = _SessionProblem;

  factory SessionProblem.fromJson(Map<String, dynamic> json) => _$SessionProblemFromJson(json);
}

@freezed
abstract class LiveKitConnection with _$LiveKitConnection {
  const factory LiveKitConnection({
    required String url,
    required String token,
    required String room,
  }) = _LiveKitConnection;

  factory LiveKitConnection.fromJson(Map<String, dynamic> json) =>
      _$LiveKitConnectionFromJson(json);
}

@freezed
abstract class SessionLimits with _$SessionLimits {
  const factory SessionLimits({
    @JsonKey(name: 'max_seconds') required int maxSeconds,

    /// この応答時点から、今日さらに授業を始められるか。
    @JsonKey(name: 'lesson_allowed_today') required bool lessonAllowedToday,
  }) = _SessionLimits;

  factory SessionLimits.fromJson(Map<String, dynamic> json) => _$SessionLimitsFromJson(json);
}

/// 写真を読んだ結果。**まだ部屋の鍵は入っていない。**
///
/// 単元と問題文を確かめる画面のための値で、ここまでは**今日の1回を使わない**
/// (数えるのは会話が始まったとき = [SessionStart])。撮って単元を見ただけで
/// 「今日はここまで」になっていたのを直したときに、応答ごと2つに分けた。
@freezed
abstract class SessionAnalysis with _$SessionAnalysis {
  const factory SessionAnalysis({
    @JsonKey(name: 'session_id') required String sessionId,
    required String kind,
    @JsonKey(name: 'detected_topics') required List<DetectedTopic> detectedTopics,

    /// 読み取れた問題文。読めなければ null。
    ///
    /// **`required` にしない。** 契約上はキーが必ず来る(`nullable()`)が、
    /// 復習セッション(`kind: review`)のように写真を送らない経路もあるので、
    /// キーの有無ではなく値の有無だけを見る。
    SessionProblem? problem,

    /// [problem] がこうなった理由。**写真を読んだセッションにだけ入る**
    /// (復習は写真を使わないので null)。
    ///
    /// 知らない値が来たら null に落とす。サーバが落ち方を増やしたときに、
    /// **古いアプリが確認画面ごと落ちる**のを避ける(文言が1つ減るだけで済む)。
    @JsonKey(
      name: 'problem_outcome',
      unknownEnumValue: JsonKey.nullForUndefinedEnumValue,
    )
    ProblemOutcome? problemOutcome,
  }) = _SessionAnalysis;

  factory SessionAnalysis.fromJson(Map<String, dynamic> json) => _$SessionAnalysisFromJson(json);
}

/// 始まった会話。**この応答が返った時点で、今日の1回を使っている。**
///
/// 部屋の鍵(`livekit`)と上限がここにしか無いのは仕様で、枠の確保と
/// トークンの発行がサーバ側の同じ1操作になっている(`api.ts` の
/// `startSessionResponseSchema`)。解析の時点で鍵を配ると、
/// 鍵を持っている = いつでも始められる になり、数える位置を移した意味が消える。
@freezed
abstract class SessionStart with _$SessionStart {
  const factory SessionStart({
    @JsonKey(name: 'session_id') required String sessionId,
    required String kind,
    required LiveKitConnection livekit,
    required SessionLimits limits,
  }) = _SessionStart;

  factory SessionStart.fromJson(Map<String, dynamic> json) => _$SessionStartFromJson(json);
}

/// セッション終了後に受け取る結果。
@freezed
abstract class SessionResult with _$SessionResult {
  const factory SessionResult({
    required Karte karte,
    required Progress progress,

    /// 初回カルテで穴が見えた直後だけ true。
    @JsonKey(name: 'show_paywall') required bool showPaywall,
  }) = _SessionResult;

  factory SessionResult.fromJson(Map<String, dynamic> json) => _$SessionResultFromJson(json);
}
