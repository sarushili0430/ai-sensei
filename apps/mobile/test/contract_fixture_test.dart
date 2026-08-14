import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/parent_report/domain/parent_report.dart';
import 'package:ai_sensei/src/features/plan/domain/study_plan.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:flutter_test/flutter_test.dart';

/// Contract drift detection, Dart side.
///
/// On the TypeScript side, `packages/contract/src/fixtures.test.ts` parses the
/// same files with zod. The contract is only aligned when both pass; changing
/// the schema on one side alone fails here or there.
Map<String, dynamic> loadFixture(String name) {
  final File file = File('../../packages/contract/fixtures/$name.json');
  expect(file.existsSync(), isTrue, reason: '${file.path} が見つかりません');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  group('カルテのfixture', () {
    test('karte.json をパースできる', () {
      final Karte karte = Karte.fromJson(loadFixture('karte'));

      expect(karte.id, isNotEmpty);
      expect(karte.saidWell, isNotEmpty);
      expect(karte.holes, hasLength(1));
      expect(karte.holes.first.topicId, 'M1-NIJI-HANBETSU');
      expect(karte.holes.first.severity, HoleSeverity.medium);
      expect(karte.holes.first.status, HoleStatus.open);
      expect(karte.holes.first.filledAt, isNull);
    });

    test('あと追い質問がnullでも読める(無料ユーザー)', () {
      expect(Karte.fromJson(loadFixture('karte')).followupQuestion, isNull);
    });

    // The international curricula (Algebra 1, Algebra 2, ...). Their topic_id
    // prefixes differ, so a failure here means English sessions' kartes cannot
    // render.
    test('karte.en.json をパースできる', () {
      final Karte karte = Karte.fromJson(loadFixture('karte.en'));

      expect(karte.topicIds, containsAll(<String>['A2-COORD-CIRCLE', 'A1-QUAD-SOLVE']));
      expect(karte.holes.first.topicId, 'A1-QUAD-SOLVE');
      expect(
        karte.holes.first.description,
        'the explanation stopped at why the discriminant is used',
      );
    });
  });

  group('セッションのfixture', () {
    test('create-session-response.json をパースできる', () {
      final SessionAnalysis analysis = SessionAnalysis.fromJson(
        loadFixture('create-session-response'),
      );

      expect(analysis.sessionId, isNotEmpty);
      expect(analysis.detectedTopics, hasLength(2));
    });

    // The analysis response carries no room key: including it would make holding
    // a key mean being able to start any time, defeating counting at the start.
    test('start-session-response.json をパースできる(部屋の鍵はこちらだけ)', () {
      final SessionStart session = SessionStart.fromJson(loadFixture('start-session-response'));

      expect(session.sessionId, isNotEmpty);
      expect(session.livekit.room, session.sessionId);
      // Shared fixtures verify the contract's shape; operational defaults belong
      // to server config, so they are not pinned.
      expect(session.limits.maxSeconds, isPositive);
      expect(session.limits.lessonAllowedToday, isFalse);
    });

    test('create-session-response.en.json をパースできる(海外向けの課程)', () {
      final SessionAnalysis analysis = SessionAnalysis.fromJson(
        loadFixture('create-session-response.en'),
      );

      expect(analysis.detectedTopics.first.topicId, 'A2-COORD-CIRCLE');
      // The chip shows the subject name the server returned, untranslated.
      expect(analysis.detectedTopics.first.course, 'Algebra 2');
    });

    // The problem text. A failure here leaves the pre-lesson read-back empty and a
    // misreading does not surface until 15 minutes in.
    test('読み取った問題文を、出どころつきで読める', () {
      final SessionAnalysis analysis = SessionAnalysis.fromJson(
        loadFixture('create-session-response'),
      );

      expect(analysis.problem, isNotNull);
      expect(analysis.problem!.text, contains('共有点の個数'));
      // Read from the second photo (the problem), which is discarded after
      // analysis.
      expect(analysis.problem!.source, ProblemSource.problemPhoto);
    });

    test('1枚に両方写っていた場合は、出どころがノートの写真になる', () {
      final SessionAnalysis analysis = SessionAnalysis.fromJson(
        loadFixture('create-session-response.en'),
      );

      expect(analysis.problem!.source, ProblemSource.notesPhoto);
      expect(analysis.problem!.text, contains('number of intersection points'));
    });

    // The unreadable case. There is no fixture, so the key is dropped instead:
    // `packages/contract` is read-only here, so no fixture is added. What matters
    // is that assembly does not stop without a value; the key's presence
    // (`nullable()`) is checked on the TypeScript side.
    test('問題文が読めなくても、セッションは組み立てられる', () {
      final Map<String, dynamic> json = loadFixture('create-session-response')
        ..['problem'] = null;
      expect(SessionAnalysis.fromJson(json).problem, isNull);

      json.remove('problem');
      expect(SessionAnalysis.fromJson(json).problem, isNull);
    });

    test('確信度の低い候補を見分けられる(チップの初期選択に使う)', () {
      final SessionAnalysis analysis = SessionAnalysis.fromJson(
        loadFixture('create-session-response'),
      );

      expect(analysis.detectedTopics.first.isConfident, isTrue);
      expect(analysis.detectedTopics.last.isConfident, isFalse);
    });

    test('complete-session-response.json をパースできる', () {
      final SessionResult result = SessionResult.fromJson(
        loadFixture('complete-session-response'),
      );

      expect(result.karte.holes, hasLength(1));
      expect(result.progress.streakDays, 3);
      expect(result.progress.filledHoles, 4);
      expect(result.showPaywall, isTrue);
    });
  });

  group('進捗と復習のfixture', () {
    test('progress-response.json をパースできる', () {
      final Progress progress = Progress.fromJson(
        loadFixture('progress-response')['progress'] as Map<String, dynamic>,
      );

      expect(progress.streakDays, 3);
      expect(progress.openHoles, 1);
      expect(progress.lastSessionDate, '2026-08-03');
    });

    test('review-queue-response.json をパースできる', () {
      final ReviewQueue queue = ReviewQueue.fromJson(loadFixture('review-queue-response'));

      expect(queue.items, hasLength(2));
      expect(queue.items.first.daysSince, 3);
      expect(queue.items.first.prompt, contains('いまなら説明できますか'));
      expect(queue.items.first.quiz, contains('平方完成をする理由'));
    });
  });

  group('親レポートのfixture', () {
    test('parent-report.json をパースできる', () {
      final ParentReportResponse response = ParentReportResponse.fromJson(
        loadFixture('parent-report'),
      );

      expect(response.requiresPremium, isFalse);
      expect(response.report, isNotNull);
      expect(response.report!.filledHoles, 2);
      expect(response.report!.streakDays, 4);
      expect(response.report!.explainedTopics.first.topicId, 'M1-NIJI-HANBETSU');
      expect(response.report!.quotes.first, contains('判別式'));
    });

    test('parent-report.en.json をパースできる(海外向け課程)', () {
      final ParentReportResponse response = ParentReportResponse.fromJson(
        loadFixture('parent-report.en'),
      );

      expect(response.report!.explainedTopics.first.topicId, 'A1-QUAD-SOLVE');
      expect(response.report!.explainedTopics.first.name, contains('discriminant'));
      expect(response.report!.quotes.first, contains('real solutions'));
    });
  });

  group('学習計画のfixture', () {
    test('日ごとの項目・休む日・口頭での組み直しを読める', () {
      final StudyPlan plan = StudyPlan.fromJson(loadFixture('study-plan'));

      expect(plan.source, PlanSource.senpai);
      expect(plan.intake.scope.topicIds, contains('M2-SANKAKU-KAHO'));
      expect(plan.days.where((PlanDay day) => day.items.isEmpty), isNotEmpty);
      expect(plan.days.first.items.first.status, PlanItemStatus.done);
      expect(plan.revisions.single.reason, PlanRevisionReason.behind);
      expect(plan.revisions.single.said, '風邪ひいて3日できなかった');
    });

    // Falling back to a template is not a failure but a supported path where
    // senpai offers a standard plan and ends the conversation. If Flutter could
    // read only `senpai`, the saved plan would be unreadable exactly when it is
    // needed most, so the English fixture pins it too.
    test('英語のテンプレート計画を読める', () {
      final StudyPlan plan = StudyPlan.fromJson(loadFixture('study-plan.en'));

      expect(plan.source, PlanSource.template);
      expect(plan.intake.examName, 'the fall midterm');
      expect(plan.days.expand((PlanDay day) => day.items), isNotEmpty);
    });

    test('計画セッションの接続情報を読める', () {
      final PlanSessionStart session = PlanSessionStart.fromJson(
        loadFixture('create-plan-session-response'),
      );

      expect(session.planSessionId, isNotEmpty);
      expect(session.livekit.room, session.planSessionId);
      expect(session.currentPlan, isNull);
    });

    test('現在の計画レスポンスを読める', () {
      final StudyPlan plan = StudyPlan.fromJson(
        loadFixture('plan-response')['plan'] as Map<String, dynamic>,
      );

      expect(plan.intake.examDate, '2026-09-10');
      expect(plan.days.single.items.single.minutes, 40);
    });
  });

  group('設計上の約束', () {
    // If a score field appears, catch it here before it reaches a fixture.
    test('カルテのfixtureに点数・正答率のキーがない', () {
      final Map<String, dynamic> karte = loadFixture('karte');

      for (final String forbidden in <String>['score', 'accuracy', 'rate', 'points', 'level']) {
        expect(karte.containsKey(forbidden), isFalse, reason: '$forbidden は持たない');
      }
    });

    test('進捗が数えるのは連続日数と穴だけ', () {
      final Map<String, dynamic> progress =
          loadFixture('progress-response')['progress'] as Map<String, dynamic>;

      expect(
        progress.keys.toSet(),
        <String>{'streak_days', 'filled_holes', 'open_holes', 'last_session_date'},
      );
    });

    test('親レポートが持つ数値は埋めた穴と連続日数だけ', () {
      final Map<String, dynamic> report =
          loadFixture('parent-report')['report'] as Map<String, dynamic>;

      expect(
        report.keys.toSet(),
        <String>{'period', 'filled_holes', 'streak_days', 'explained_topics', 'quotes'},
      );
      for (final String forbidden in <String>[
        'score',
        'accuracy',
        'deviation_score',
        'understanding_score',
        'study_time_rank',
        'percentile',
      ]) {
        expect(report.containsKey(forbidden), isFalse, reason: '$forbidden は親へ渡さない');
      }
    });

    test('学習計画に点数・正答率・達成率のキーがない', () {
      final Map<String, dynamic> plan = loadFixture('study-plan');
      final String encoded = jsonEncode(plan);

      for (final String forbidden in <String>[
        'score',
        'accuracy',
        'rate',
        'percent',
        'percentage',
        'points',
        'level',
      ]) {
        expect(
          encoded.contains('"$forbidden"'),
          isFalse,
          reason: '$forbidden は持たない',
        );
      }
    });
  });

  group('板書のfixture(LLMが出す形)', () {
    test('board-lesson.json をパースできる', () {
      final BoardLesson lesson = BoardLesson.fromJson(loadFixture('board-lesson'));

      expect(lesson.title, '判別式で解の個数を見る');
      expect(lesson.topicIds, <String>['M1-NIJI-HANBETSU']);
      expect(lesson.steps, hasLength(7));

      // Steps with a null board (acknowledgements, checks) parse.
      expect(lesson.steps[2].board, isNull);

      // The `kind` discriminated union dispatches correctly.
      expect(lesson.steps[0].board, isA<LatexElement>());
      expect((lesson.steps[0].board! as LatexElement).tex, 'x^2 - 3x + 2 = 0');
      expect(lesson.steps[1].board, isA<TextElement>());
      expect((lesson.steps[1].board! as TextElement).body, 'a = 1, b = -3, c = 2');

      // The invariant (sequential index) should be intact.
      expect(() => ensureSequentialStepIndices(lesson), returnsNormally);
    });

    // The board for English curricula. Its elements (sentence, compare) do not
    // overlap with maths, so without this nothing on the Dart side checks their
    // shape.
    test('board-lesson.english.json をパースできる(sentence / compare)', () {
      final BoardLesson lesson = BoardLesson.fromJson(loadFixture('board-lesson.english'));
      final List<BoardElement> elements =
          lesson.steps.map((BoardStep s) => s.board).whereType<BoardElement>().toList();
      expect(elements.whereType<SentenceElement>(), isNotEmpty);
      expect(elements.whereType<CompareElement>(), isNotEmpty);

      final SentenceElement sentence = elements.whereType<SentenceElement>().first;
      // focus is part of text (an invariant JSON Schema cannot carry).
      expect(sentence.focus, isNotNull);
      expect(sentence.text.contains(sentence.focus!), isTrue);

      final CompareElement compare = elements.whereType<CompareElement>().first;
      expect(compare.columns, hasLength(2));
      for (final List<String> row in compare.rows) {
        expect(row, hasLength(2));
      }
    });

    test('board-lesson.en.json をパースできる(海外向けの課程・plotを含む)', () {
      final BoardLesson lesson = BoardLesson.fromJson(loadFixture('board-lesson.en'));

      expect(lesson.topicIds, <String>['A2-INEQ-QUADRATIC', 'A1-QUAD-SOLVE']);

      final BoardElement? plotElement = lesson.steps[3].board;
      expect(plotElement, isA<PlotElement>());
      final PlotElement plot = plotElement! as PlotElement;
      expect(plot.fn, 'x^2 - 3*x + 2');
      expect(plot.domain.min, -1);
      expect(plot.domain.max, 4);
      expect(plot.marks, hasLength(2));
      expect(plot.marks!.first.label, 'x = 1');

      // The fixture's domain should be intact (min < max).
      expect(() => ensureValidDomain(plot.domain), returnsNormally);
    });

    test('circle要素をパースできる(board-channel-log.jsonから。円のlabelsは2つ)', () {
      final BoardChannelLog log = BoardChannelLog.fromJson(loadFixture('board-channel-log'));
      final BoardStepMessage circleStepMessage =
          log.messages.firstWhere(
                (BoardChannelMessage m) =>
                    m is BoardStepMessage && m.step.board is CircleElement,
              )
              as BoardStepMessage;
      final CircleElement circle = circleStepMessage.step.board! as CircleElement;

      expect(circle.center.x, 0);
      expect(circle.center.y, 0);
      expect(circle.r, 5);
      expect(circle.labels, <String>['O', 'r = 5']);
    });
  });

  group('板書のfixture(data channelを流れる形)', () {
    test('board-channel-log.json をパースできる(2枚の板書・open→step*→close)', () {
      final BoardChannelLog log = BoardChannelLog.fromJson(loadFixture('board-channel-log'));

      expect(log.messages, hasLength(9));
      expect(log.messages.first, isA<BoardOpenMessage>());
      expect((log.messages.first as BoardOpenMessage).title, '判別式で解の個数を見る');

      // The first board: three steps, then close (step_count=3, completed).
      final BoardCloseMessage firstClose = log.messages[4] as BoardCloseMessage;
      expect(firstClose.stepCount, 3);
      expect(firstClose.reason, BoardCloseReason.completed);

      // The second board: two steps, then close (step_count=2, interrupted).
      final BoardCloseMessage secondClose = log.messages.last as BoardCloseMessage;
      expect(secondClose.stepCount, 2);
      expect(secondClose.reason, BoardCloseReason.interrupted);
    });

    test('board-channel-log.json は BoardChannelReceiver をそのまま最後まで通せる', () {
      final BoardChannelLog log = BoardChannelLog.fromJson(loadFixture('board-channel-log'));
      final BoardChannelReceiver receiver = BoardChannelReceiver(
        sessionId: log.messages.first.sessionId,
      );

      for (final BoardChannelMessage message in log.messages) {
        receiver.accept(message);
      }

      // The second board closed last, so the receiver should be in the closed
      // state.
      expect(receiver.isOpen, isFalse);
    });
  });

  // ---------------------------------------------------------------------
  // Invariants JSON Schema cannot carry (the table in
  // packages/contract/README.md).
  //
  // From here on the tests show not that valid input parses but that broken
  // input is judged broken. Happy paths alone are not enough, so each way of
  // breaking it gets its own test.
  // ---------------------------------------------------------------------
  group('不変条件: plot.domain は min < max', () {
    test('min < max なら通る', () {
      expect(
        () => ensureValidDomain(const BoardDomain(min: -1, max: 4)),
        returnsNormally,
      );
    });

    test('min == max は壊れている', () {
      expect(
        () => ensureValidDomain(const BoardDomain(min: 2, max: 2)),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('min > max は壊れている(取り違え)', () {
      expect(
        () => ensureValidDomain(const BoardDomain(min: 4, max: -1)),
        throwsA(isA<BoardContractViolation>()),
      );
    });
  });

  group('不変条件: triangle.vertices はちょうど3点', () {
    const BoardPoint p = BoardPoint(x: 0, y: 0);

    test('3点なら通る', () {
      expect(
        () => ensureValidTriangle(const <BoardPoint>[p, p, p], null),
        returnsNormally,
      );
    });

    test('2点しか無いのは壊れている', () {
      expect(
        () => ensureValidTriangle(const <BoardPoint>[p, p], null),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('labelsが2つしか無いのも壊れている(3つ揃わない三角形)', () {
      expect(
        () => ensureValidTriangle(const <BoardPoint>[p, p, p], const <String>['A', 'B']),
        throwsA(isA<BoardContractViolation>()),
      );
    });
  });

  group('不変条件: board-lesson の index は0始まりで1ずつ', () {
    BoardLesson lessonWithIndices(List<int> indices) {
      return BoardLesson(
        title: 'テスト',
        topicIds: const <String>['M1-NIJI-HANBETSU'],
        steps: <BoardStep>[
          for (final int i in indices)
            BoardStep(index: i, speech: 'てすと', board: null),
        ],
      );
    }

    test('0,1,2,... なら通る', () {
      expect(
        () => ensureSequentialStepIndices(lessonWithIndices(<int>[0, 1, 2])),
        returnsNormally,
      );
    });

    test('先頭が1始まりは壊れている', () {
      expect(
        () => ensureSequentialStepIndices(lessonWithIndices(<int>[1, 2, 3])),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('途中が飛ぶのは壊れている(0,1,3)', () {
      expect(
        () => ensureSequentialStepIndices(lessonWithIndices(<int>[0, 1, 3])),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('重複しているのは壊れている(0,1,1)', () {
      expect(
        () => ensureSequentialStepIndices(lessonWithIndices(<int>[0, 1, 1])),
        throwsA(isA<BoardContractViolation>()),
      );
    });
  });

  group('BoardChannelReceiver: 封筒の順序規約(欠落検知そのもの)', () {
    // Reuses only the fixture's first board, with three valid step messages.
    const BoardChannelMessage open = BoardChannelMessage.boardOpen(
      v: 1,
      sessionId: 'ses_1',
      boardId: 'brd_1',
      seq: 0,
      title: '判別式で解の個数を見る',
      topicIds: <String>['M1-NIJI-HANBETSU'],
    );

    BoardChannelMessage step(int seq, int index) => BoardChannelMessage.boardStep(
      v: 1,
      sessionId: 'ses_1',
      boardId: 'brd_1',
      seq: seq,
      step: BoardStep(index: index, speech: 'てすと', board: null),
    );

    BoardChannelMessage stepWithBoard(int seq, int index, BoardElement board) =>
        BoardChannelMessage.boardStep(
          v: 1,
          sessionId: 'ses_1',
          boardId: 'brd_1',
          seq: seq,
          step: BoardStep(index: index, speech: 'てすと', board: board),
        );

    BoardChannelMessage close(int seq, int stepCount) => BoardChannelMessage.boardClose(
      v: 1,
      sessionId: 'ses_1',
      boardId: 'brd_1',
      seq: seq,
      stepCount: stepCount,
      reason: BoardCloseReason.completed,
    );

    test('正常な列(open→step→step→close)は最後まで通り、盤面に手順が積まれる', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');

      receiver.accept(open);
      expect(receiver.isOpen, isTrue);
      receiver.accept(step(1, 0));
      receiver.accept(step(2, 1));
      expect(receiver.currentSteps, hasLength(2));
      receiver.accept(close(3, 2));

      expect(receiver.isOpen, isFalse);
    });

    test('seqが飛ぶと検知できる(1個欠落)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // seq=0
      expect(
        () => receiver.accept(step(2, 0)), // seq=1 missing; 2 arrived first
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('seqが重複しても検知できる', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // seq=0
      receiver.accept(step(1, 0)); // seq=1
      expect(
        () => receiver.accept(step(1, 1)), // seq still 1 (duplicate send)
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('手順のindexが飛ぶと検知できる(板書内の欠落)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // seq=0
      expect(
        () => receiver.accept(step(1, 1)), // expected index=0, got index=1
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('末尾の手順が欠落すると step_count の不一致で検知できる', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // seq=0
      receiver.accept(step(1, 0)); // seq=1, index=0 (the first of two steps)
      // The second step (index=1) is missing entirely when close arrives, while
      // step_count still honestly reports that there were two steps.
      expect(
        () => receiver.accept(close(2, 2)),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('別セッション宛てのメッセージは拒否される(部屋の取り違え。README表には無いが追加した検査)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      const BoardChannelMessage otherSessionOpen = BoardChannelMessage.boardOpen(
        v: 1,
        sessionId: 'ses_other', // not the expected session
        boardId: 'brd_1',
        seq: 0,
        title: '判別式で解の個数を見る',
        topicIds: <String>['M1-NIJI-HANBETSU'],
      );
      expect(() => receiver.accept(otherSessionOpen), throwsA(isA<BoardContractViolation>()));
    });

    test('board_openされていないboard_idのstepは拒否される(取り違え配送)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // board_id: brd_1
      const BoardChannelMessage wrongBoardStep = BoardChannelMessage.boardStep(
        v: 1,
        sessionId: 'ses_1',
        boardId: 'brd_other', // addressed to a board that is not open
        seq: 1,
        step: BoardStep(index: 0, speech: 'てすと', board: null),
      );
      expect(() => receiver.accept(wrongBoardStep), throwsA(isA<BoardContractViolation>()));
    });

    test('board_closeされる前に次のboard_openが来ると検知できる', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // brd_1 left open
      const BoardChannelMessage secondOpen = BoardChannelMessage.boardOpen(
        v: 1,
        sessionId: 'ses_1',
        boardId: 'brd_2',
        seq: 1,
        title: '別の問題',
        topicIds: <String>['M2-ZUKEI-ENCHOKU'],
      );
      expect(() => receiver.accept(secondOpen), throwsA(isA<BoardContractViolation>()));
    });

    test('board_open は前の板書の手順を消す(それ以外では消えない)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open); // brd_1
      receiver.accept(step(1, 0));
      receiver.accept(step(2, 1));
      expect(receiver.currentSteps, hasLength(2)); // kept until close
      receiver.accept(close(3, 2));

      const BoardChannelMessage secondOpen = BoardChannelMessage.boardOpen(
        v: 1,
        sessionId: 'ses_1',
        boardId: 'brd_2',
        seq: 4,
        title: '別の問題',
        topicIds: <String>['M2-ZUKEI-ENCHOKU'],
      );
      receiver.accept(secondOpen);

      // Leaving the previous board's two steps would mix old content into the new
      // board.
      expect(receiver.currentSteps, isEmpty);
    });

    // ---------------------------------------------------------------------
    // accept() itself must reject element-level invariant violations.
    //
    // Do not delete these three as duplicates of the "plot.domain min < max" and
    // "triangle.vertices exactly 3 points" groups. Those two call
    // ensureValidDomain / ensureValidTriangle directly and check that the
    // validators judge correctly. These pass a BoardStepMessage carrying a broken
    // element to accept() instead, checking not the judgement but that the gate
    // is still wired up — that _ensureValidElement(step.board) has not fallen out
    // of accept(). Deleting that one line from accept() in board.dart leaves the
    // other two groups entirely green; only these three catch that regression.
    // ---------------------------------------------------------------------

    test('accept() は domain が min>=max の plot要素を弾く(検査関数を直接呼ばない)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open);

      const BoardElement brokenPlot = BoardElement.plot(
        fn: 'x',
        domain: BoardDomain(min: 5, max: 1), // swapped: min > max
      );
      expect(
        () => receiver.accept(stepWithBoard(1, 0, brokenPlot)),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('accept() は頂点が2点しか無い triangle要素を弾く(検査関数を直接呼ばない)', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open);

      const BoardPoint p = BoardPoint(x: 0, y: 0);
      const BoardElement brokenTriangle = BoardElement.triangle(vertices: <BoardPoint>[p, p]);
      expect(
        () => receiver.accept(stepWithBoard(1, 0, brokenTriangle)),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    /// `sentence.focus` must be a substring of `text`. It could not be written
    /// with `.refine()`, so the contract checks shape only and this
    /// receiver-side check is the only guard; without it, it silently degrades to
    /// "the underline just isn't drawn".
    test('accept() は focus が text に無い sentence要素を弾く', () {
      expect(
        () => ensureValidSentence('I have lived here.', '現在完了'),
        throwsA(isA<BoardContractViolation>()),
      );
      expect(() => ensureValidSentence('I have lived here.', 'have lived'), returnsNormally);
    });

    test('accept() は列が3つある compare要素を弾く', () {
      expect(
        () => ensureValidCompare(
          <String>['a', 'b', 'c'],
          <List<String>>[
            <String>['1', '2', '3'],
          ],
        ),
        throwsA(isA<BoardContractViolation>()),
      );
    });

    test('accept() は正常な plot要素(min<max)は素通しする', () {
      final BoardChannelReceiver receiver = BoardChannelReceiver(sessionId: 'ses_1');
      receiver.accept(open);

      const BoardElement validPlot = BoardElement.plot(
        fn: 'x^2',
        domain: BoardDomain(min: -1, max: 1),
      );
      expect(() => receiver.accept(stepWithBoard(1, 0, validPlot)), returnsNormally);
      expect(receiver.currentSteps, hasLength(1));
    });
  });
}
