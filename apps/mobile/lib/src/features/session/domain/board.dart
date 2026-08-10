import 'package:freezed_annotation/freezed_annotation.dart';

part 'board.freezed.dart';
part 'board.g.dart';

/// 板書(先輩が画面に積んでいく行)のモデル。
///
/// 正は `packages/contract`(zod + JSON Schema、`src/board.ts`)。Dart側はfreezedで書き、
/// `test/contract_fixture_test.dart` が同じfixtureをパースして契約ドリフトを検知する
/// (`karte.dart` と同じ方針)。
///
/// **描画の実装はここには無い。** ここにあるのは受信した契約をパースし、
/// JSON Schemaに現れない不変条件(`packages/contract/README.md` 「JSON Schema に
/// 現れない不変条件」を参照)を検査するところまで。描画(`CustomPaint`・`flutter_math_fork`)は
/// 別のタスク。
///
/// このファイルも2つの形を持つ(理由は `board.ts` の冒頭コメントと同じ):
///   1. **LLMが出す形**(`BoardLesson`)— 板書1枚まるごと
///   2. **data channel を流れる形**(`BoardChannelMessage`)— 1手順ずつの封筒

/// 盤面上の点。座標は `board.ts` 側で有限・盤面内(絶対値1000以内)に縛られているが、
/// その検査はJSON Schemaの `minimum`/`maximum` に残るので、freezedの型だけで足りる
/// (Dart側で追加のrefineは不要)。
@freezed
abstract class BoardPoint with _$BoardPoint {
  const factory BoardPoint({required double x, required double y}) = _BoardPoint;

  factory BoardPoint.fromJson(Map<String, dynamic> json) => _$BoardPointFromJson(json);
}

/// グラフに打つ印。交点・頂点など「見てほしい一点」だけ。
@freezed
abstract class PlotMark with _$PlotMark {
  const factory PlotMark({required BoardPoint at, String? label}) = _PlotMark;

  factory PlotMark.fromJson(Map<String, dynamic> json) => _$PlotMarkFromJson(json);
}

/// `plot.domain`。**`min < max` はJSON Schemaに残らない不変条件**
/// (`packages/contract/README.md`)。パースはここでは失敗しない(型だけの検査)ので、
/// 使う前に必ず [ensureValidDomain] を呼ぶこと。
@freezed
abstract class BoardDomain with _$BoardDomain {
  const factory BoardDomain({required double min, required double max}) = _BoardDomain;

  factory BoardDomain.fromJson(Map<String, dynamic> json) => _$BoardDomainFromJson(json);
}

enum AngleMarkKind {
  @JsonValue('angle')
  angle,
  @JsonValue('right_angle')
  rightAngle,
}

/// 三角形の角の印。`vertex` は `vertices` のインデックス(0〜2)。
@freezed
abstract class AngleMark with _$AngleMark {
  const factory AngleMark({required int vertex, required AngleMarkKind kind, String? label}) =
      _AngleMark;

  factory AngleMark.fromJson(Map<String, dynamic> json) => _$AngleMarkFromJson(json);
}

/// 板書に積む1要素。`kind` の discriminated union(`board.ts` の `boardElementSchema` と対応)。
///
/// **自由描画は無い。** 増やせる枝は無く、ここに無いプリミティブは表現できない
/// (`board.ts` 冒頭コメント「自由描画をさせない」と同じ理由)。
@Freezed(unionKey: 'kind')
abstract class BoardElement with _$BoardElement {
  /// flutter_math_fork が描く数式。1行ぶん。
  const factory BoardElement.latex({required String tex}) = LatexElement;

  /// 数式にしない一行。見出し・注記・言い換え。
  const factory BoardElement.text({required String body}) = TextElement;

  /// 関数グラフ。`domain.min < domain.max` は [ensureValidDomain] で検査する。
  const factory BoardElement.plot({
    required String fn,
    required BoardDomain domain,
    List<PlotMark>? marks,
  }) = PlotElement;

  /// 三角形。`vertices` は必ず3点(`board.ts` は `z.tuple` で縛っているが、
  /// freezed/json_serializableに固定長タプルは無いので、Dart側は長さの検査を別に持つ
  /// = [ensureValidTriangle])。
  const factory BoardElement.triangle({
    required List<BoardPoint> vertices,
    List<String>? labels,
    List<AngleMark>? marks,
  }) = TriangleElement;

  const factory BoardElement.circle({
    required BoardPoint center,
    required double r,
    List<String>? labels,
  }) = CircleElement;

  factory BoardElement.fromJson(Map<String, dynamic> json) => _$BoardElementFromJson(json);
}

/// `plot.domain` は `min < max`。README「JSON Schema に現れない不変条件」の1行目。
///
/// **単体では呼び忘れられる。** 実際の呼び出し口は [BoardChannelReceiver.accept] の
/// 内部(`_ensureValidElement`)で、ワイヤーから届く `BoardElement` は必ずここを通る。
/// この関数を公開したままにしているのは、テスト(壊れたdomainを直接作って検査する)と、
/// `accept()` を経由しない経路(fixtureの直接検証など)のためだけ。
void ensureValidDomain(BoardDomain domain) {
  if (!(domain.min < domain.max)) {
    throw BoardContractViolation(
      'domain は min < max である必要があります(min=${domain.min}, max=${domain.max})',
    );
  }
}

/// `triangle.vertices` はちょうど3点、`labels` を付けるなら3つ揃っていること。
/// `board.ts` の `z.tuple([_, _, _])` に対応するDart側の検査
/// (READMEには表として明記されていないが、`z.tuple` はJSON Schemaでは
/// `minItems`/`maxItems` にしか残らず、`z.tuple` が持つ「ちょうど3」という保証を
/// freezedの `List<BoardPoint>` は型では表現できないため、他の不変条件と同じ扱いにする)。
///
/// [ensureValidDomain] と同じ理由で、単体では呼び忘れられる。
/// 実際の呼び出し口は [BoardChannelReceiver.accept] の内部。
void ensureValidTriangle(List<BoardPoint> vertices, List<String>? labels) {
  if (vertices.length != 3) {
    throw BoardContractViolation('triangle.vertices は3点である必要があります(実際は${vertices.length}点)');
  }
  if (labels != null && labels.length != 3) {
    throw BoardContractViolation('triangle.labels を付けるなら3つ揃えてください(実際は${labels.length}個)');
  }
}

/// ワイヤーから届いた `BoardElement` を検査する。**唯一の呼び出し口は
/// [BoardChannelReceiver.accept]。** ここを通さずに描画へ渡す経路を作らないこと
/// (作った瞬間、[ensureValidDomain] / [ensureValidTriangle] は「存在するが効かない
/// 検査関数」に戻ってしまう)。
void _ensureValidElement(BoardElement? element) {
  element?.when(
    latex: (String tex) {},
    text: (String body) {},
    plot: (String fn, BoardDomain domain, List<PlotMark>? marks) => ensureValidDomain(domain),
    triangle: (List<BoardPoint> vertices, List<String>? labels, List<AngleMark>? marks) =>
        ensureValidTriangle(vertices, labels),
    circle: (BoardPoint center, double r, List<String>? labels) {},
  );
}

/// 手順1つ = 「先輩がひとこと言いながら、板書を1行足す」単位。
@freezed
abstract class BoardStep with _$BoardStep {
  const factory BoardStep({
    /// 板書内での通し番号。0始まりで1ずつ増える(`ensureSequentialStepIndices` で検査)。
    required int index,
    required String speech,

    /// null なら音声のみ(相づち・確認)。
    required BoardElement? board,
  }) = _BoardStep;

  factory BoardStep.fromJson(Map<String, dynamic> json) => _$BoardStepFromJson(json);
}

/// LLMが出す形 — 板書1枚まるごと。session_id / board_id は持たない(意図的。`board.ts` 参照)。
@freezed
abstract class BoardLesson with _$BoardLesson {
  const factory BoardLesson({
    required String title,
    @JsonKey(name: 'topic_ids') required List<String> topicIds,
    required List<BoardStep> steps,
  }) = _BoardLesson;

  factory BoardLesson.fromJson(Map<String, dynamic> json) => _$BoardLessonFromJson(json);
}

/// `steps[i].index` が0始まりで1ずつ増えているか検査する
/// (`board.ts` の `boardLessonSchema.superRefine` と対応)。
///
/// **モバイルの本番経路(data channel)では呼ばれない。** `BoardLesson` はLLMがagentに
/// 出す形で、ワイヤーを流れるのは封筒(`BoardChannelMessage`)だけ(`board.ts` 冒頭コメント)。
/// モバイルが受け取るのは常に1手順ずつの `BoardStepMessage` で、`BoardLesson` を
/// 直接受け取ることはない。**この関数は `board-lesson*.json` fixture の検証専用**
/// ([BoardChannelReceiver.accept] のような「唯一の呼び出し口」を持たないのは、
/// そもそも本番コードから呼ばれる経路が無いため)。
void ensureSequentialStepIndices(BoardLesson lesson) {
  for (int position = 0; position < lesson.steps.length; position++) {
    final int index = lesson.steps[position].index;
    if (index != position) {
      throw BoardContractViolation(
        'index は0始まりで1ずつ増やしてください($position番目のstepがindex=$index)',
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* data channel(封筒)                                                        */
/* -------------------------------------------------------------------------- */

enum BoardCloseReason {
  @JsonValue('completed')
  completed,
  @JsonValue('interrupted')
  interrupted,
  @JsonValue('error')
  error,
}

/// data channel を1件ずつ流れるメッセージ。`type` の discriminated union
/// (`board.ts` の `boardChannelMessageSchema` と対応)。
///
/// `unionValueCase: FreezedUnionCase.snake` で、Dartのコンストラクタ名(camelCase)を
/// ワイヤー上の `type` 値(snake_case: `board_open` 等)に自動変換する。
@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
abstract class BoardChannelMessage with _$BoardChannelMessage {
  const factory BoardChannelMessage.boardOpen({
    required int v,
    @JsonKey(name: 'session_id') required String sessionId,
    @JsonKey(name: 'board_id') required String boardId,
    required int seq,
    required String title,
    @JsonKey(name: 'topic_ids') required List<String> topicIds,
  }) = BoardOpenMessage;

  const factory BoardChannelMessage.boardStep({
    required int v,
    @JsonKey(name: 'session_id') required String sessionId,
    @JsonKey(name: 'board_id') required String boardId,
    required int seq,
    required BoardStep step,
  }) = BoardStepMessage;

  const factory BoardChannelMessage.boardClose({
    required int v,
    @JsonKey(name: 'session_id') required String sessionId,
    @JsonKey(name: 'board_id') required String boardId,
    required int seq,
    @JsonKey(name: 'step_count') required int stepCount,
    required BoardCloseReason reason,
  }) = BoardCloseMessage;

  factory BoardChannelMessage.fromJson(Map<String, dynamic> json) =>
      _$BoardChannelMessageFromJson(json);
}

/// 共通envelopeフィールドの取り出し。3つのunion枝それぞれに同名フィールドがあるが、
/// freezedのunionは共通基底を持たないので、`.when` でまとめて取り出す小さなヘルパー。
extension BoardChannelMessageEnvelope on BoardChannelMessage {
  int get seq => when(
    boardOpen: (v, sessionId, boardId, seq, title, topicIds) => seq,
    boardStep: (v, sessionId, boardId, seq, step) => seq,
    boardClose: (v, sessionId, boardId, seq, stepCount, reason) => seq,
  );

  String get boardId => when(
    boardOpen: (v, sessionId, boardId, seq, title, topicIds) => boardId,
    boardStep: (v, sessionId, boardId, seq, step) => boardId,
    boardClose: (v, sessionId, boardId, seq, stepCount, reason) => boardId,
  );

  String get sessionId => when(
    boardOpen: (v, sessionId, boardId, seq, title, topicIds) => sessionId,
    boardStep: (v, sessionId, boardId, seq, step) => sessionId,
    boardClose: (v, sessionId, boardId, seq, stepCount, reason) => sessionId,
  );
}

/// 1セッションぶんの配送ログ。**ワイヤー上には現れない**(fixtureとgolden testのための入れ物)。
/// `board.ts` の `boardChannelLogSchema` と対応。
@freezed
abstract class BoardChannelLog with _$BoardChannelLog {
  const factory BoardChannelLog({required List<BoardChannelMessage> messages}) = _BoardChannelLog;

  factory BoardChannelLog.fromJson(Map<String, dynamic> json) => _$BoardChannelLogFromJson(json);
}

/// 板書の契約が破られたときに投げる例外。
///
/// **「板書が虫食いのまま黙って表示される」を防ぐためのシグナル。**
/// JSON Schemaでは表現できない不変条件(README「JSON Schema に現れない不変条件」)は
/// 全てこれを投げる。呼び出し側(将来の描画層)は、これを捕まえて
/// エラー状態を出す責務を持つ(黙って無視してはいけない)。
class BoardContractViolation implements Exception {
  const BoardContractViolation(this.message);

  final String message;

  @override
  String toString() => 'BoardContractViolation: $message';
}

/// data channel(封筒)の順序規約を検査する、ステートフルな受信側。
///
/// `board.ts` の `boardChannelLogSchema.superRefine` は「配送ログ全体」を一括で検査するが、
/// 実機では LiveKit の Text Streams から**1件ずつ**届く(計画書 §3-5)。
/// このクラスはその受信の形に合わせて、[accept] を1件ずつ呼ぶ設計にしてある。
///
/// 検査する不変条件(README表と対応):
///   - `seq` は0始まりで1ずつ増える(種別をまたいで)
///   - 手順は `board_open` と `board_close` の間にしか来ない
///   - `board_id` が一致しないメッセージは(未開封として)拒否する
///   - `index` は板書ごとに0始まりで1ずつ増える
///   - `board_close.step_count` が実際に届いた手順数と一致する(末尾の欠落の検知)
///   - `board_open` は前の板書を消す([currentSteps] が空になる。それ以外では消えない)
///
/// **README表には無いが追加した検査が1つある**: `session_id` の一貫性。
/// `board.ts` の `boardChannelLogSchema.superRefine` には実装されている
/// (「1つのログに複数のセッションを混ぜないでください」)が、README表の6行には
/// 載っていない。`session_id` のコメント(`board.ts:341`)が「宛先の確認。
/// 部屋を取り違えた配送を受信側で落とせる」と明記しているので、
/// **モバイル側の取り違え検知として持たせる方が安全**と判断し、追加した。
class BoardChannelReceiver {
  BoardChannelReceiver({required this.sessionId});

  /// 受信側が期待するセッション。接続時に決まる(LiveKitのRoomは1セッション1部屋)。
  final String sessionId;

  int _expectedSeq = 0;
  String? _openBoardId;
  int _receivedSteps = 0;
  final List<BoardStep> _currentSteps = <BoardStep>[];

  /// いま開いている板書に、これまで積まれた手順。
  /// `board_open` を受けるとここが空にリセットされる(それ以外では消えない)。
  List<BoardStep> get currentSteps => List<BoardStep>.unmodifiable(_currentSteps);

  /// いま板書が開いているか(= `board_open` は来たが `board_close` がまだ)。
  bool get isOpen => _openBoardId != null;

  /// 1件処理する。契約違反があれば [BoardContractViolation] を投げる。
  ///
  /// **例外を握りつぶさないこと。** ここで検出できなかった欠落は、
  /// 板書が虫食いのまま画面に出る(README冒頭の警告そのもの)。
  void accept(BoardChannelMessage message) {
    if (message.sessionId != sessionId) {
      throw BoardContractViolation(
        '別のセッション宛てのメッセージです(session_id=${message.sessionId}, 期待値=$sessionId)',
      );
    }
    if (message.seq != _expectedSeq) {
      throw BoardContractViolation(
        'seq は0始まりで1ずつ増やしてください(seq=${message.seq}, 期待値=$_expectedSeq)',
      );
    }
    _expectedSeq += 1;

    message.when(
      boardOpen: (v, sessionId, boardId, seq, title, topicIds) {
        if (_openBoardId != null) {
          throw BoardContractViolation('板書 $_openBoardId が board_close されていません');
        }
        _openBoardId = boardId;
        _receivedSteps = 0;
        _currentSteps.clear();
      },
      boardStep: (v, sessionId, boardId, seq, step) {
        if (boardId != _openBoardId) {
          throw BoardContractViolation('board_open されていない板書のメッセージです(board_id=$boardId)');
        }
        if (step.index != _receivedSteps) {
          throw BoardContractViolation(
            'index は板書ごとに0始まりで1ずつ増やしてください($_receivedSteps を期待して ${step.index})',
          );
        }
        // 要素レベルの不変条件(domainのmin<max・triangleの頂点数)。
        // ここを通さない限り、壊れた要素は描画層まで無検査で届いてしまう。
        _ensureValidElement(step.board);
        _receivedSteps += 1;
        _currentSteps.add(step);
      },
      boardClose: (v, sessionId, boardId, seq, stepCount, reason) {
        if (boardId != _openBoardId) {
          throw BoardContractViolation('board_open されていない板書のメッセージです(board_id=$boardId)');
        }
        if (stepCount != _receivedSteps) {
          throw BoardContractViolation(
            'step_count が実際に届いた手順数($_receivedSteps)と違います(step_count=$stepCount)。'
            '末尾の手順が欠落している可能性があります',
          );
        }
        _openBoardId = null;
      },
    );
  }
}
