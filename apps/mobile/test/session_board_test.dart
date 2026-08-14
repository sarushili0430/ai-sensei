import 'dart:convert';

import 'package:ai_sensei/src/common_widgets/senpai_face.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/session/application/board_inbox.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_style.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// Getting the board onto the conversation screen.
///
/// What is checked here is the board's lifetime, not how it looks:
///   - lines stack one at a time and earlier lines are never erased
///   - only moving to another problem (`board_open`) clears it; `board_close`
///     does not
///   - on a gap, it stops there and says so rather than silently leaving holes
///
/// Rendering itself (how formulas and figures look) is the goldens' job.
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const String sessionId = 'ses_1';

  BoardChannelMessage open(int seq, {String boardId = 'brd_1', String title = '判別式'}) =>
      BoardChannelMessage.boardOpen(
        v: 1,
        sessionId: sessionId,
        boardId: boardId,
        seq: seq,
        title: title,
        topicIds: const <String>['jp.math1.quadratic.discriminant'],
      );

  BoardChannelMessage step(
    int seq,
    int index, {
    String boardId = 'brd_1',
    String body = 'a = 1, b = -3, c = 2',
  }) => BoardChannelMessage.boardStep(
    v: 1,
    sessionId: sessionId,
    boardId: boardId,
    seq: seq,
    step: BoardStep(index: index, speech: 'ここ、見て', board: BoardElement.text(body: body)),
  );

  BoardChannelMessage close(int seq, int stepCount, {String boardId = 'brd_1'}) =>
      BoardChannelMessage.boardClose(
        v: 1,
        sessionId: sessionId,
        boardId: boardId,
        seq: seq,
        stepCount: stepCount,
        reason: BoardCloseReason.completed,
      );

  group('板書の受信(BoardInbox)', () {
    test('手順は1行ずつ積まれ、前の行は消えない', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);

      expect(inbox.snapshot.hasBoard, isFalse);
      inbox.accept(open(0));
      expect(inbox.snapshot.title, '判別式');
      // The heading alone enters lesson mode, rather than staying on the face
      // until the first step arrives.
      expect(inbox.snapshot.hasBoard, isTrue);

      inbox.accept(step(1, 0, body: 'x^2 の係数'));
      inbox.accept(step(2, 1, body: 'D = 9 - 8'));
      expect(inbox.snapshot.steps.length, 2);
      expect((inbox.snapshot.steps.first.board! as TextElement).body, 'x^2 の係数');
    });

    /// A board lives for one problem, not one explanation (`board.ts`). Clearing
    /// here would wipe it on every conversational turn.
    test('board_close では何も消えない', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));
      inbox.accept(step(2, 1));
      inbox.accept(close(3, 2));

      expect(inbox.snapshot.steps.length, 2);
      expect(inbox.snapshot.title, '判別式');
      expect(inbox.snapshot.hasGap, isFalse);
    });

    test('board_open は前の板書を消す(別の問題に移るとき)', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));
      inbox.accept(close(2, 1));

      inbox.accept(open(3, boardId: 'brd_2', title: '三角比'));
      expect(inbox.snapshot.steps, isEmpty);
      expect(inbox.snapshot.title, '三角比');
    });

    /// Never swallowed. Stacking past a gap leaves the student learning a method
    /// with a hole in it, unable to tell anything is missing.
    test('seq が飛んだら、とぎれた印がついて、そこから先は積まれない', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));

      // seq=2 was lost.
      expect(inbox.accept(step(3, 1)), isTrue);
      expect(inbox.snapshot.hasGap, isTrue);
      expect(inbox.snapshot.gapReason, contains('seq'));

      // Stacked lines remain; nothing past the gap is added.
      expect(inbox.snapshot.steps.length, 1);
      expect(inbox.accept(step(4, 2)), isFalse);
      expect(inbox.snapshot.steps.length, 1);
    });

    /// A lost tail cannot be seen from `seq` (it is indistinguishable from "not
    /// arrived yet"), so the closing `step_count` is reconciled instead.
    test('締めの step_count が合わなければ、末尾の欠落として検知する', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));
      inbox.accept(close(2, 3));

      expect(inbox.snapshot.hasGap, isTrue);
      expect(inbox.snapshot.steps.length, 1);
    });

    test('とぎれても、次の board_open で復帰する(1問ぶんで終わりにする)', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));
      inbox.accept(step(3, 1)); // seq=2 was lost
      expect(inbox.snapshot.hasGap, isTrue);

      inbox.accept(open(9, boardId: 'brd_2', title: '三角比'));
      expect(inbox.snapshot.hasGap, isFalse);
      expect(inbox.snapshot.title, '三角比');
      expect(inbox.snapshot.steps, isEmpty);

      // Gaps after recovery are still detected; recounting does not disable the
      // check.
      inbox.accept(step(10, 0, boardId: 'brd_2'));
      expect(inbox.snapshot.steps.length, 1);
      inbox.accept(step(12, 1, boardId: 'brd_2'));
      expect(inbox.snapshot.hasGap, isTrue);
    });

    test('別のセッション宛ての封筒は受け取らない', () {
      final BoardInbox inbox = BoardInbox(sessionId: 'ses_2');
      inbox.accept(open(0));

      expect(inbox.snapshot.hasGap, isTrue);
      expect(inbox.snapshot.hasBoard, isFalse);
    });

    test('JSONのまま受け取れる(1封筒 = 1ストリームの readAll がそのまま入る)', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.acceptPayload(jsonEncode(open(0).toJson()));
      inbox.acceptPayload(jsonEncode(step(1, 0, body: '底の変換').toJson()));

      expect(inbox.snapshot.title, '判別式');
      expect((inbox.snapshot.steps.single.board! as TextElement).body, '底の変換');
    });

    test('読めない封筒も黙って捨てない(何が抜けたか分からないため)', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.acceptPayload(jsonEncode(open(0).toJson()));
      inbox.acceptPayload('{ここでJSONが壊れている');

      expect(inbox.snapshot.hasGap, isTrue);
    });
  });

  group('会話画面の板書', () {
    Future<FakeSessionController> pumpSession(
      WidgetTester tester,
      SessionState state, {
      Locale locale = const Locale('ja'),
      Size size = phoneSurface,
      SessionProblem? problem,
    }) async {
      await pumpApp(
        tester,
        const SessionScreen(),
        locale: locale,
        size: size,
        overrides: <Object?>[
          captureControllerProvider.overrideWith(() => FakeCaptureController(problem)),
          sessionControllerProvider.overrideWith(() => FakeSessionController(state)),
        ],
      );
      final ProviderContainer container = ProviderScope.containerOf(
        tester.element(find.byType(SessionScreen)),
        listen: false,
      );
      return container.read(sessionControllerProvider.notifier) as FakeSessionController;
    }

    SessionState teaching(List<String> lines, {String? gapReason}) => SessionState(
      phase: SessionPhase.senpaiTeaching,
      remainingSeconds: 1200,
      board: BoardSnapshot(
        title: '判別式',
        gapReason: gapReason,
        steps: <BoardStep>[
          for (int i = 0; i < lines.length; i++)
            BoardStep(index: i, speech: 'ここ、見て', board: BoardElement.text(body: lines[i])),
        ],
      ),
    );

    testWidgets('届いた手順ぶん、板書が積まれる', (WidgetTester tester) async {
      await pumpSession(tester, teaching(<String>['x^2 - 3x + 2 = 0', 'a = 1, b = -3, c = 2']));

      expect(find.byType(BoardElementView), findsNWidgets(2));
      expect(find.text('x^2 - 3x + 2 = 0'), findsOneWidget);
      // The heading (which problem it is) appears too.
      expect(find.text('判別式'), findsOneWidget);
    });

    /// Earlier lines are never erased — that is the board's whole value.
    testWidgets('行が増えても、前の行は消えない', (WidgetTester tester) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        teaching(<String>['1行目', '2行目']),
      );
      expect(find.byType(BoardElementView), findsNWidgets(2));

      controller.push(teaching(<String>['1行目', '2行目', '3行目']));
      await tester.pumpAndSettle();

      expect(find.byType(BoardElementView), findsNWidgets(3));
      expect(find.text('1行目'), findsOneWidget);
      expect(find.text('3行目'), findsOneWidget);
    });

    /// Teaching back: it hands over to the mic with the board still up.
    testWidgets('教え返し中も板書は残り、「説明してみて」が出る', (WidgetTester tester) async {
      final SessionState taught = teaching(<String>['D = 9 - 8 = 1 > 0']);
      await pumpSession(
        tester,
        SessionState(
          phase: SessionPhase.explainBack,
          remainingSeconds: 1200,
          board: taught.board,
        ),
      );

      expect(find.byType(BoardElementView), findsOneWidget);
      expect(find.text(ja.sessionExplainBack), findsOneWidget);
      // It waits with a listening face, not an examiner's.
      final SenpaiFace face = tester.widget(find.byType(SenpaiFace));
      expect(face.mood, SenpaiMood.listening);
    });

    /// Nothing on screen said what was being solved.
    ///
    /// Only `board.title` (senpai's heading) was shown, and the problem itself
    /// vanished on leaving capture. It is what people most want to re-read while
    /// teaching back, so it sits above the board for the whole lesson.
    testWidgets('解いている問題が、板書の上に出る', (WidgetTester tester) async {
      await pumpSession(
        tester,
        teaching(<String>['x^2 - 3x + 2 = 0']),
        problem: const SessionProblem(
          text: 'x^2 - 4x + k = 0 が異なる2つの実数解をもつような定数 k の値の範囲を求めよ。',
          source: ProblemSource.problemPhoto,
        ),
      );

      expect(find.text(ja.sessionProblemTitle), findsOneWidget);
      expect(find.textContaining('異なる2つの実数解'), findsOneWidget);
      // The board still leads; adding the problem must not eat its width.
      expect(tester.getSize(find.byType(BoardView)).width, greaterThanOrEqualTo(340));
    });

    /// A failed read is never announced. "Could not read the problem" sends the
    /// student off to retake before senpai can ask them to read it out.
    testWidgets('問題文が読めていなければ、何も出さない', (WidgetTester tester) async {
      await pumpSession(tester, teaching(<String>['x^2 - 3x + 2 = 0']));

      expect(find.text(ja.sessionProblemTitle), findsNothing);
    });

    /// The contract allows 600 characters; showing all of it would push the board
    /// off screen, so it collapses to three lines with "read more".
    testWidgets('長い問題文は畳まれ、開いても板書が残る', (WidgetTester tester) async {
      await pumpSession(
        tester,
        teaching(<String>['x^2 - 3x + 2 = 0']),
        problem: SessionProblem(
          text: '次の問いに答えよ。${'円と直線の位置関係について、中心と直線の距離を用いて説明せよ。' * 8}',
          source: ProblemSource.notesPhoto,
        ),
      );

      expect(find.text(ja.sessionProblemExpand), findsOneWidget);
      await tester.tap(find.text(ja.sessionProblemExpand));
      await tester.pumpAndSettle();

      expect(find.text(ja.sessionProblemCollapse), findsOneWidget);
      // Expanding keeps the board on screen rather than pushing it out.
      expect(find.byType(BoardElementView), findsOneWidget);
    });

    testWidgets('とぎれたら、板書は残したままそのことを出す', (WidgetTester tester) async {
      await pumpSession(
        tester,
        teaching(<String>['x^2 - 3x + 2 = 0'], gapReason: 'seq は0始まりで1ずつ'),
      );

      expect(find.byType(BoardElementView), findsOneWidget);
      expect(find.text(ja.sessionBoardGap), findsOneWidget);
      // The technical reason never reaches the screen.
      expect(find.textContaining('seq'), findsNothing);
    });

    /// The screen must not eat the board's width.
    ///
    /// The 70% floor in `board_style.dart` was measured at an effective width of
    /// 340pt (iPhone 15's 393pt minus board padding). Adding a card or inner
    /// padding drops below that and pushes formulas that measured as fitting into
    /// horizontal scrolling — invisible by eye (it only reaches `debugPrint`), so
    /// the width itself is watched.
    testWidgets('板書の実効幅は、実測の前提(340pt)を下回らない', (WidgetTester tester) async {
      await setSurface(tester);
      await pumpSession(tester, teaching(<String>['x^2 - 3x + 2 = 0']));

      expect(tester.getSize(find.byType(BoardView)).width, greaterThanOrEqualTo(340));
    });

    /// The board must not be missing from narration.
    ///
    /// Both `Math.tex` and `CustomPaint` are invisible to VoiceOver unwrapped.
    /// The board is the heart of the product, so missing it means a blind student
    /// has no lesson at all.
    testWidgets('板書の1行ごとに、読み上げ用の1文が付いている', (WidgetTester tester) async {
      await pumpSession(
        tester,
        const SessionState(
          phase: SessionPhase.senpaiTeaching,
          remainingSeconds: 1200,
          board: BoardSnapshot(
            title: '判別式',
            steps: <BoardStep>[
              BoardStep(
                index: 0,
                speech: 'まず、式をそのまま書くね',
                board: BoardElement.latex(tex: 'x^2 - 3x + 2 = 0'),
              ),
              BoardStep(
                index: 1,
                speech: '円はこう',
                board: BoardElement.circle(
                  center: BoardPoint(x: 0, y: 0),
                  r: 5,
                  labels: <String>['O'],
                ),
              ),
            ],
          ),
        ),
      );

      // Formulas narrate as one sentence, not symbol by symbol.
      expect(
        find.bySemanticsLabel('x の 2 乗 マイナス 3x プラス 2 イコール 0'),
        findsOneWidget,
      );
      // Figures narrate what is drawn; unwrapped, not a character is read.
      expect(find.bySemanticsLabel(RegExp(r'円。半径 5')), findsOneWidget);
    });

    /// Narrow devices must not report "not enough width".
    ///
    /// The 340pt premise assumes iPhone 15 (393pt). An iPhone SE (375pt) can only
    /// ever reach 375 - 48 = 327pt, so using 340 as the threshold would report on
    /// every SE user. A narrow device is not a layout fault, and reporting it
    /// would bury what we actually want to see: our own layout eating the width.
    group('板書の幅の見張り', () {
      test('iPhone 15 では実測の前提(340pt)がそのまま閾値', () {
        expect(BoardStyle.expectedWidth(393), 340);
      });

      test('iPhone SE では、その端末で取れる幅(327pt)が閾値', () {
        expect(BoardStyle.expectedWidth(375), 327);
      });

      // Measured when the board sat in a card outside a lesson. That is layout
      // eating the width, so it falls below the threshold on any device and is
      // reported.
      test('版組が食った幅は、狭い端末でも閾値を下回る', () {
        expect(311, lessThan(BoardStyle.expectedWidth(375)));
        expect(311, lessThan(BoardStyle.expectedWidth(393)));
      });
    });

    /// Whether the board overflows on a narrow device (continuing
    /// `layout_overflow_test.dart`).
    ///
    /// The sweep test renders every screen but this one, because the scaffolding
    /// for conversation state lives here. It is also the most valuable to cover:
    ///
    ///   - the board stacks steps, so this is the only screen whose height is
    ///     decided at runtime
    ///   - teaching back keeps the board and adds the mic UI below, making the
    ///     fixed block thickest
    ///   - a truncation line stacks on top of that
    ///
    /// Leaving it uncovered means it surfaces during the release gate instead.
    for (final Locale locale in <Locale>[const Locale('ja'), const Locale('en')]) {
      final String lang = locale.languageCode;

      /// A lesson with as many steps as possible; a real board caps at 12.
      SessionState packed({SessionPhase phase = SessionPhase.senpaiTeaching, String? gapReason}) =>
          SessionState(
            phase: phase,
            remainingSeconds: 1200,
            board: BoardSnapshot(
              title: '判別式で解の個数を見る',
              gapReason: gapReason,
              steps: <BoardStep>[
                for (int i = 0; i < 12; i++)
                  BoardStep(
                    index: i,
                    speech: 'ここ、見て',
                    board: BoardElement.latex(tex: 'D_{$i} = (-4)^2 - 4k > 0'),
                  ),
              ],
            ),
          );

      void expectNoOverflow(WidgetTester tester, String what) {
        expect(
          tester.takeException(),
          isNull,
          reason: '$what が $lang で '
              '${smallPhoneSurface.width.toInt()}x${smallPhoneSurface.height.toInt()} から溢れています',
        );
      }

      testWidgets('狭い端末: 授業中に板書が積まれても溢れない ($lang)', (WidgetTester tester) async {
        await pumpSession(tester, packed(), locale: locale, size: smallPhoneSurface);
        // Do not pass vacuously: with no board lines drawn, not overflowing is
        // trivial and this check sees nothing.
        expect(find.byType(BoardElementView), findsNWidgets(12));
        expectNoOverflow(tester, '授業中');
      });

      // The state with the thickest fixed block (board plus mic UI).
      testWidgets('狭い端末: 教え返し中も溢れない ($lang)', (WidgetTester tester) async {
        await pumpSession(
          tester,
          packed(phase: SessionPhase.explainBack),
          locale: locale,
          size: smallPhoneSurface,
        );
        expectNoOverflow(tester, '教え返し中');
      });

      // A truncation line stacks on top of the thickest state.
      testWidgets('狭い端末: とぎれた一行が乗っても溢れない ($lang)', (WidgetTester tester) async {
        await pumpSession(
          tester,
          packed(phase: SessionPhase.explainBack, gapReason: 'seq は0始まりで1ずつ'),
          locale: locale,
          size: smallPhoneSurface,
        );
        expectNoOverflow(tester, 'とぎれた状態');
      });

      /// An overflow hit on device (BOTTOM OVERFLOWED landed on "done for today").
      ///
      /// Board-less conversations sandwiched face and captions between `Spacer`s.
      /// In-lesson `speech` is capped at 120 characters by the contract, but once
      /// teaching back begins the other side is a conversational LLM with no cap.
      /// A long reply became fixed height and pushed the controls off screen.
      testWidgets('狭い端末: 板書が無いまま長く喋られても溢れない ($lang)', (WidgetTester tester) async {
        await pumpSession(
          tester,
          SessionState(
            phase: SessionPhase.listening,
            remainingSeconds: 1029,
            lastSenpaiText: '円順列は、回転は同じと見なす。でもじゅず順列は、それに加えて裏返しも同じと見なすんだよ。' * 4,
          ),
          locale: locale,
          size: smallPhoneSurface,
        );

        expect(find.byType(SenpaiFace), findsOneWidget);
        expectNoOverflow(tester, '板書なしで長い字幕');
      });

      /// With a board too, the bottom bar must not grow and push it out.
      testWidgets('狭い端末: 板書つきで長く喋られても溢れない ($lang)', (WidgetTester tester) async {
        final SessionState state = packed(phase: SessionPhase.explainBack);
        await pumpSession(
          tester,
          SessionState(
            phase: state.phase,
            remainingSeconds: state.remainingSeconds,
            lastSenpaiText: 'そっだね。図があるといいよね。いま図は描けないんだけど、イメージとしては。' * 4,
            board: state.board,
          ),
          locale: locale,
          size: smallPhoneSurface,
        );

        expect(find.byType(BoardElementView), findsNWidgets(12));
        expectNoOverflow(tester, '板書つきで長い字幕');
      });
    }

    /// Conversations with no board (existing review) still lead with the face.
    testWidgets('板書が無ければ、画面はこれまでのまま', (WidgetTester tester) async {
      await pumpSession(
        tester,
        const SessionState(phase: SessionPhase.listening, remainingSeconds: 1200),
      );

      expect(find.byType(BoardElementView), findsNothing);
      final SenpaiFace face = tester.widget(find.byType(SenpaiFace));
      expect(face.size, 160);
    });
  });
}

/// A stand-in that only lets the conversation screen see a session.
///
/// Passing [problem] puts the analysis in a state where it read the text.
class FakeCaptureController extends CaptureController {
  FakeCaptureController([this.problem]);

  final SessionProblem? problem;

  @override
  CaptureState build() => CaptureState(
    analysis: SessionAnalysis(
      sessionId: 'ses_1',
      kind: 'new',
      detectedTopics: const <DetectedTopic>[],
      problem: problem,
    ),
    session: const SessionStart(
      sessionId: 'ses_1',
      kind: 'new',
      livekit: LiveKitConnection(url: 'wss://example', token: 't', room: 'ses_1'),
      limits: SessionLimits(maxSeconds: 1200, lessonAllowedToday: true),
    ),
  );
}

/// A stand-in whose state can be set from outside; it never connects LiveKit.
class FakeSessionController extends SessionController {
  FakeSessionController(this._initial);

  final SessionState _initial;

  @override
  SessionState build() => _initial;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}

  /// Reproduces one more board line arriving.
  void push(SessionState next) => state = next;
}
