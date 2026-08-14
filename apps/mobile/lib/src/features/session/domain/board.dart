import 'package:freezed_annotation/freezed_annotation.dart';

part 'board.freezed.dart';
part 'board.g.dart';

/// Model for the board — the lines senpai stacks on screen.
///
/// `packages/contract` (zod + JSON Schema, `src/board.ts`) is the source of
/// truth. The Dart side uses freezed, and `test/contract_fixture_test.dart`
/// parses the same fixtures to catch contract drift, as in `karte.dart`.
///
/// No rendering lives here. This file parses the received contract and checks
/// the invariants JSON Schema cannot express (see "invariants not in JSON
/// Schema" in `packages/contract/README.md`); drawing (`CustomPaint`,
/// `flutter_math_fork`) is a separate concern.
///
/// It carries two shapes, for the same reasons as `board.ts`:
///   1. what the LLM emits (`BoardLesson`) — a whole board at once
///   2. what flows over the data channel (`BoardChannelMessage`) — one step per
///      envelope

/// A point on the board. `board.ts` bounds coordinates to finite values within
/// the board (|v| <= 1000), and that check survives as JSON Schema
/// `minimum`/`maximum`, so the freezed type alone is enough here.
@freezed
abstract class BoardPoint with _$BoardPoint {
  const factory BoardPoint({required double x, required double y}) = _BoardPoint;

  factory BoardPoint.fromJson(Map<String, dynamic> json) => _$BoardPointFromJson(json);
}

/// A mark on a graph — only the single point worth looking at, such as an
/// intersection or a vertex.
@freezed
abstract class PlotMark with _$PlotMark {
  const factory PlotMark({required BoardPoint at, String? label}) = _PlotMark;

  factory PlotMark.fromJson(Map<String, dynamic> json) => _$PlotMarkFromJson(json);
}

/// `plot.domain`. `min < max` is an invariant JSON Schema cannot carry, and
/// parsing here only checks types, so always call [ensureValidDomain] before use.
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

/// An angle mark on a triangle; `vertex` indexes `vertices` (0-2).
@freezed
abstract class AngleMark with _$AngleMark {
  const factory AngleMark({required int vertex, required AngleMarkKind kind, String? label}) =
      _AngleMark;

  factory AngleMark.fromJson(Map<String, dynamic> json) => _$AngleMarkFromJson(json);
}

/// One element on the board: a discriminated union on `kind`, mirroring
/// `boardElementSchema` in `board.ts`.
///
/// There is no freehand drawing. No branch can be added ad hoc, and anything not
/// listed here cannot be expressed.
@Freezed(unionKey: 'kind')
abstract class BoardElement with _$BoardElement {
  /// A formula drawn by flutter_math_fork; one line.
  const factory BoardElement.latex({required String tex}) = LatexElement;

  /// A non-formula line: heading, note or paraphrase.
  const factory BoardElement.text({required String body}) = TextElement;

  /// A function plot; `domain.min < domain.max` is checked by [ensureValidDomain].
  const factory BoardElement.plot({
    required String fn,
    required BoardDomain domain,
    List<PlotMark>? marks,
  }) = PlotElement;

  /// A triangle. `vertices` is always 3 points: `board.ts` uses `z.tuple`, but
  /// freezed/json_serializable has no fixed-length tuple, so the Dart side
  /// checks the length separately in [ensureValidTriangle].
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

  /// An English example sentence; `focus` is a substring of `text` (checked by
  /// [ensureValidSentence]).
  const factory BoardElement.sentence({
    required String text,
    String? gloss,
    String? focus,
  }) = SentenceElement;

  /// A two-column comparison. Exactly two `columns`, and two cells per row;
  /// `board.ts` uses `z.tuple`, so [ensureValidCompare] carries the check here,
  /// as with `triangle.vertices`.
  const factory BoardElement.compare({
    required List<String> columns,
    required List<List<String>> rows,
    String? title,
  }) = CompareElement;

  /// A construction. The device only draws [svg].
  ///
  /// [items] declares the construction ("B at distance 6 from A, bearing -20°",
  /// "D at the intersection of two lines"); solving the coordinates into SVG is
  /// the server's job (`@ai-sensei/figure`). The SVG arriving here is always
  /// generated from validated [items] — there is no path by which senpai's own
  /// SVG could enter.
  ///
  /// [items] is carried to the device for two reasons:
  ///   - accessibility and validation need to know what was drawn (SVG cannot
  ///     say)
  ///   - it keeps the option of redrawing on device later (SVG alone is one-way)
  /// It is not used for rendering today.
  ///
  /// [svg] / [alt] are `null` only in the shape the LLM emits, before the server
  /// fills them in; anything off the wire always has them (see
  /// [ensureValidFigure]).
  const factory BoardElement.figure({
    required List<Map<String, dynamic>> items,
    String? svg,
    String? alt,
  }) = FigureElement;

  factory BoardElement.fromJson(Map<String, dynamic> json) => _$BoardElementFromJson(json);
}

/// `plot.domain` must satisfy `min < max` — the first invariant JSON Schema
/// cannot carry.
///
/// Easy to forget when called directly. The real call site is inside
/// [BoardChannelReceiver.accept] (`_ensureValidElement`), which every wire
/// `BoardElement` passes through. It stays public only for tests (building a
/// broken domain directly) and paths that skip `accept()`, such as validating
/// fixtures.
void ensureValidDomain(BoardDomain domain) {
  if (!(domain.min < domain.max)) {
    throw BoardContractViolation(
      'domain は min < max である必要があります(min=${domain.min}, max=${domain.max})',
    );
  }
}

/// `triangle.vertices` must be exactly 3 points, and `labels`, if present, must
/// have 3 entries — the Dart counterpart of `z.tuple([_, _, _])` in `board.ts`.
/// It is not in the README table, but `z.tuple` survives only as
/// `minItems`/`maxItems` in JSON Schema and freezed's `List<BoardPoint>` cannot
/// express "exactly 3", so it is treated like the other invariants.
///
/// As with [ensureValidDomain], the real call site is inside
/// [BoardChannelReceiver.accept].
void ensureValidTriangle(List<BoardPoint> vertices, List<String>? labels) {
  if (vertices.length != 3) {
    throw BoardContractViolation('triangle.vertices は3点である必要があります(実際は${vertices.length}点)');
  }
  if (labels != null && labels.length != 3) {
    throw BoardContractViolation('triangle.labels を付けるなら3つ揃えてください(実際は${labels.length}個)');
  }
}

/// `sentence.focus` must be a substring of `text` — another invariant JSON
/// Schema cannot carry.
///
/// It could not be written with `.refine()`: `boardElementSchema` is a
/// `discriminatedUnion` whose branches must be `ZodObject`, and `.refine()`
/// disqualifies them. So the contract checks shape only, and both Dart and the
/// agent carry this condition.
///
/// As with [ensureValidDomain], the real call site is inside
/// [BoardChannelReceiver.accept].
void ensureValidSentence(String text, String? focus) {
  if (focus != null && !text.contains(focus)) {
    throw BoardContractViolation('sentence.focus は text の一部である必要があります(focus=$focus)');
  }
}

/// `compare.columns` must be exactly 2, with 1-4 rows of 2 cells each.
///
/// Two columns is fixed because three do not fit an effective width of 340pt
/// (see `compareElementSchema` in `board.ts`); a broken table is unreadable even
/// when drawn.
void ensureValidCompare(List<String> columns, List<List<String>> rows) {
  if (columns.length != 2) {
    throw BoardContractViolation('compare.columns は2つである必要があります(実際は${columns.length}個)');
  }
  if (rows.isEmpty) {
    throw const BoardContractViolation('compare.rows が空です');
  }
  for (final List<String> row in rows) {
    if (row.length != 2) {
      throw BoardContractViolation('compare.rows の各行は2マスである必要があります(実際は${row.length}マス)');
    }
  }
}

/// Validates a `BoardElement` off the wire. [BoardChannelReceiver.accept] is the
/// only call site; never add a path that reaches rendering without it, or
/// [ensureValidDomain] / [ensureValidTriangle] become checks that exist but do
/// nothing.
///
/// A `figure` must carry `svg` by the time it reaches the wire. The contract
/// marks it `optional` (the LLM's shape has none), but anything reaching the
/// device always has it. Passing one through without it leaves the figure's
/// place silently blank, and a line vanishing mid-lesson is worse than a slow
/// one.
///
/// As with [ensureValidDomain], the real call site is inside
/// [BoardChannelReceiver.accept].
void ensureValidFigure(String? svg) {
  if (svg == null || svg.isEmpty) {
    throw const BoardContractViolation('figure に svg がありません(サーバが解いて詰めるはずのもの)');
  }
}

void _ensureValidElement(BoardElement? element) {
  element?.when(
    latex: (String tex) {},
    text: (String body) {},
    plot: (String fn, BoardDomain domain, List<PlotMark>? marks) => ensureValidDomain(domain),
    triangle: (List<BoardPoint> vertices, List<String>? labels, List<AngleMark>? marks) =>
        ensureValidTriangle(vertices, labels),
    circle: (BoardPoint center, double r, List<String>? labels) {},
    sentence: (String text, String? gloss, String? focus) => ensureValidSentence(text, focus),
    compare: (List<String> columns, List<List<String>> rows, String? title) =>
        ensureValidCompare(columns, rows),
    figure: (List<Map<String, dynamic>> items, String? svg, String? alt) => ensureValidFigure(svg),
  );
}

/// One step: senpai says a line while adding one line to the board.
@freezed
abstract class BoardStep with _$BoardStep {
  const factory BoardStep({
    /// Position within the board, from 0 in steps of 1 (checked by
    /// `ensureSequentialStepIndices`).
    required int index,
    required String speech,

    /// Null means voice only (an acknowledgement or a check).
    required BoardElement? board,
  }) = _BoardStep;

  factory BoardStep.fromJson(Map<String, dynamic> json) => _$BoardStepFromJson(json);
}

/// The shape the LLM emits: a whole board. It deliberately carries no
/// session_id or board_id (see `board.ts`).
@freezed
abstract class BoardLesson with _$BoardLesson {
  const factory BoardLesson({
    required String title,
    @JsonKey(name: 'topic_ids') required List<String> topicIds,
    required List<BoardStep> steps,
  }) = _BoardLesson;

  factory BoardLesson.fromJson(Map<String, dynamic> json) => _$BoardLessonFromJson(json);
}

/// Checks that `steps[i].index` runs from 0 in steps of 1 (mirroring
/// `boardLessonSchema.superRefine` in `board.ts`).
///
/// Never called on mobile's production path. `BoardLesson` is what the LLM emits
/// to the agent; only envelopes (`BoardChannelMessage`) travel the wire, and
/// mobile always receives one `BoardStepMessage` at a time. This function exists
/// solely to validate `board-lesson*.json` fixtures, which is why it has no
/// single call site like [BoardChannelReceiver.accept].
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
/* data channel (envelopes)                                                   */
/* -------------------------------------------------------------------------- */

/// The LiveKit topic; mobile reads only this topic as board content. Mirrored
/// from `boardChannelTopic` in `board.ts`, because a mismatch delivers not one
/// line.
///
/// Received through the Text Streams API (`registerTextStreamHandler` plus this
/// topic), never raw `publishData`, whose LOSSY default silently drops board
/// lines if forgotten.
const String boardChannelTopic = 'board';

enum BoardCloseReason {
  @JsonValue('completed')
  completed,
  @JsonValue('interrupted')
  interrupted,
  @JsonValue('error')
  error,
}

/// Messages flowing one at a time over the data channel: a discriminated union
/// on `type`, mirroring `boardChannelMessageSchema` in `board.ts`.
///
/// `unionValueCase: FreezedUnionCase.snake` maps Dart's camelCase constructor
/// names to the wire's snake_case `type` values (`board_open` and friends).
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

/// Reads the shared envelope fields. All three union branches have them, but a
/// freezed union has no common base, so this helper pulls them out via `.when`.
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

/// A delivery log for one session. It never appears on the wire — it is a
/// container for fixtures and golden tests, mirroring `boardChannelLogSchema`.
@freezed
abstract class BoardChannelLog with _$BoardChannelLog {
  const factory BoardChannelLog({required List<BoardChannelMessage> messages}) = _BoardChannelLog;

  factory BoardChannelLog.fromJson(Map<String, dynamic> json) => _$BoardChannelLogFromJson(json);
}

/// Thrown when the board contract is violated.
///
/// The signal that prevents a hole-riddled board from being displayed silently.
/// Every invariant JSON Schema cannot express throws this, and callers (the
/// rendering layer) are responsible for catching it and surfacing an error state
/// — never for ignoring it.
class BoardContractViolation implements Exception {
  const BoardContractViolation(this.message);

  final String message;

  @override
  String toString() => 'BoardContractViolation: $message';
}

/// Stateful receiver validating the data channel's ordering rules.
///
/// `boardChannelLogSchema.superRefine` in `board.ts` checks a whole delivery log
/// at once, but on device the LiveKit Text Streams arrive one at a time, so this
/// class is built around calling [accept] per message.
///
/// Invariants checked (matching the README table):
///   - `seq` runs from 0 in steps of 1, across all message kinds
///   - steps only arrive between `board_open` and `board_close`
///   - messages with a mismatched `board_id` are rejected as unopened
///   - `index` runs from 0 in steps of 1 within each board
///   - `board_close.step_count` matches the number of steps received (catching a
///     truncated tail)
///   - `board_open` clears the previous board ([currentSteps] empties; nothing
///     else clears it)
///
/// One check is not in the README table: `session_id` consistency. It is
/// implemented in `boardChannelLogSchema.superRefine` ("do not mix sessions in
/// one log") but missing from the table's six rows. Since the `session_id`
/// comment in `board.ts` states it exists so the receiver can drop deliveries
/// for the wrong room, carrying that check on mobile is the safer choice.
class BoardChannelReceiver {
  BoardChannelReceiver({required this.sessionId});

  /// The entry point for recovering from a gap: restart counting from a given
  /// `seq`.
  ///
  /// `seq` is a running number within the session, so one lost message makes
  /// every later one an ordering violation and the receiver never accepts
  /// anything again. Using `board_open` (moving to another problem) as the
  /// recovery point and recounting from that envelope's `seq` keeps later gaps
  /// detectable.
  ///
  /// A broken receiver is rebuilt rather than repaired, so partially stacked
  /// steps do not carry into the recovered board (`board_open` is also the
  /// signal to clear it).
  ///
  /// [sessionId] comes from the caller rather than the `board_open` contents, so
  /// an envelope cannot vouch for its own destination: recovering from a
  /// misaddressed `board_open` would let the `session_id` check pass unnoticed.
  ///
  /// When it is safe to recover is not decided here — that belongs to the
  /// receiving path in the application layer.
  factory BoardChannelReceiver.resumingAt({required String sessionId, required int seq}) =>
      BoardChannelReceiver(sessionId: sessionId).._expectedSeq = seq;

  /// The session this receiver expects, fixed at connect time (one LiveKit Room
  /// per session).
  final String sessionId;

  int _expectedSeq = 0;
  String? _openBoardId;
  int _receivedSteps = 0;
  final List<BoardStep> _currentSteps = <BoardStep>[];

  /// Steps stacked so far on the open board. Receiving `board_open` clears this;
  /// nothing else does.
  List<BoardStep> get currentSteps => List<BoardStep>.unmodifiable(_currentSteps);

  /// Whether a board is open (`board_open` seen, `board_close` not yet).
  bool get isOpen => _openBoardId != null;

  /// The ID of the open board.
  ///
  /// Needed to throttle degradation reports to one per board: a lesson streams
  /// dozens of steps, and without it one board's gap reports over and over.
  String? get openBoardId => _openBoardId;

  /// Handles one message, throwing [BoardContractViolation] on any violation.
  ///
  /// Never swallow that exception: a gap missed here reaches the screen as a
  /// hole-riddled board.
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
        // Element-level invariants (domain min < max, triangle vertex count).
        // Without this, broken elements reach rendering unchecked.
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
