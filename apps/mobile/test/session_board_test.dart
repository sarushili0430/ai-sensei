import 'dart:convert';

import 'package:ai_sensei/src/common_widgets/chunky_button.dart';
import 'package:ai_sensei/src/common_widgets/senpai_face.dart';
import 'package:ai_sensei/src/common_widgets/speaking_wave.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/session/application/board_inbox.dart';
import 'package:ai_sensei/src/features/session/application/session_control.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_element_view.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_style.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_view.dart';
import 'package:ai_sensei/src/features/session/presentation/session_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart';

import 'support/harness.dart';

/// 板書が会話画面に出るまで(計画書§3-2 / §3-5)。
///
/// ここで見ているのは描画の出来ではなく、**板書の寿命**:
///   - 1行ずつ積まれ、**前の行は消えない**
///   - 消えるのは別の問題に移るとき(`board_open`)だけ。`board_close` では消えない
///   - 欠落したら**黙って虫食いにせず**、そこで止めて画面に出す
///
/// 描画そのもの(数式・図形の見た目)は golden の担当なので、ここでは触らない。
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const String sessionId = 'ses_1';

  BoardChannelMessage open(
    int seq, {
    String boardId = 'brd_1',
    String title = '判別式',
  }) => BoardChannelMessage.boardOpen(
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
    bool? awaitsSolving,
  }) => BoardChannelMessage.boardStep(
    v: 1,
    sessionId: sessionId,
    boardId: boardId,
    seq: seq,
    step: BoardStep(
      index: index,
      speech: 'ここ、見て',
      board: BoardElement.text(body: body),
      awaitsSolving: awaitsSolving,
    ),
  );

  BoardChannelMessage close(
    int seq,
    int stepCount, {
    String boardId = 'brd_1',
  }) => BoardChannelMessage.boardClose(
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
      // 見出しだけで授業モードに入る(1手順目が届くまで顔のままにしない)。
      expect(inbox.snapshot.hasBoard, isTrue);

      inbox.accept(step(1, 0, body: 'x^2 の係数'));
      inbox.accept(step(2, 1, body: 'D = 9 - 8'));
      expect(inbox.snapshot.steps.length, 2);
      expect(
        (inbox.snapshot.steps.first.board! as TextElement).body,
        'x^2 の係数',
      );
    });

    /// 板書の寿命は「1回の説明」ではなく **「1つの問題」**(契約 `board.ts`)。
    /// ここで消すと、会話が1往復するたびに板書が消える。
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

    test('最後の手順だけから、類題を解いている状態を読める', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0, awaitsSolving: true));
      expect(inbox.snapshot.awaitsSolving, isTrue);

      inbox.accept(step(2, 1));
      expect(inbox.snapshot.awaitsSolving, isFalse);
    });

    test('board_open は前の板書を消す(別の問題に移るとき)', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0, body: '1問目', awaitsSolving: true));
      expect(inbox.snapshot.awaitsSolving, isTrue);
      inbox.accept(close(2, 1));

      inbox.accept(open(3, boardId: 'brd_2', title: '三角比'));
      expect(inbox.snapshot.steps, isEmpty);
      expect(inbox.snapshot.title, '三角比');
      // #152 の解答待ちは1問目の状態。2枚目を開いた時点で必ず消える。
      expect(inbox.snapshot.awaitsSolving, isFalse);

      inbox.accept(step(4, 0, boardId: 'brd_2', body: 'sin 30° = 1/2'));
      expect(inbox.snapshot.steps, hasLength(1));
      expect(
        (inbox.snapshot.steps.single.board! as TextElement).body,
        'sin 30° = 1/2',
      );
    });

    /// **黙って握りつぶさない。**抜けたまま積むと、生徒は
    /// 「抜けている」ことに気づけないまま間違ったやり方を覚える。
    test('seq が飛んだら、とぎれた印がついて、そこから先は積まれない', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));

      // seq=2 が落ちた。
      expect(inbox.accept(step(3, 1)), isTrue);
      expect(inbox.snapshot.hasGap, isTrue);
      expect(inbox.snapshot.gapReason, contains('seq'));

      // 積まれた行は残る。とぎれた先は積まれない。
      expect(inbox.snapshot.steps.length, 1);
      expect(inbox.accept(step(4, 2)), isFalse);
      expect(inbox.snapshot.steps.length, 1);
    });

    /// 末尾が落ちた場合は `seq` では分からない(「まだ来ていない」と区別できない)。
    /// 締めの `step_count` で突き合わせる。
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
      inbox.accept(step(3, 1)); // seq=2 が落ちた
      expect(inbox.snapshot.hasGap, isTrue);

      inbox.accept(open(9, boardId: 'brd_2', title: '三角比'));
      expect(inbox.snapshot.hasGap, isFalse);
      expect(inbox.snapshot.title, '三角比');
      expect(inbox.snapshot.steps, isEmpty);

      // 復帰後の欠落もひきつづき検知できること(数え直しただけで、検査は生きている)。
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
      bool controlFails = false,
    }) async {
      final SessionState initial = problem == null
          ? state
          : state.copyWith(problem: problem);
      await pumpApp(
        tester,
        const SessionScreen(),
        locale: locale,
        size: size,
        overrides: <Object?>[
          captureControllerProvider.overrideWith(
            () => FakeCaptureController(problem),
          ),
          sessionControllerProvider.overrideWith(
            () => FakeSessionController(initial, controlFails: controlFails),
          ),
        ],
      );
      final ProviderContainer container = ProviderScope.containerOf(
        tester.element(find.byType(SessionScreen)),
        listen: false,
      );
      return container.read(sessionControllerProvider.notifier)
          as FakeSessionController;
    }

    SessionState teaching(List<String> lines, {String? gapReason}) =>
        SessionState(
          phase: SessionPhase.senpaiTeaching,
          remainingSeconds: 1200,
          board: BoardSnapshot(
            title: '判別式',
            gapReason: gapReason,
            steps: <BoardStep>[
              for (int i = 0; i < lines.length; i++)
                BoardStep(
                  index: i,
                  speech: 'ここ、見て',
                  board: BoardElement.text(body: lines[i]),
                ),
            ],
          ),
        );

    testWidgets('届いた手順ぶん、板書が積まれる', (WidgetTester tester) async {
      await pumpSession(
        tester,
        teaching(<String>['x^2 - 3x + 2 = 0', 'a = 1, b = -3, c = 2']),
      );

      expect(find.byType(BoardElementView), findsNWidgets(2));
      expect(find.text('x^2 - 3x + 2 = 0'), findsOneWidget);
      // 見出し(何の問題か)も出る。
      expect(find.text('判別式'), findsOneWidget);
    });

    testWidgets('「わかった」を連打しても制御RPCは1回だけ送り、すぐ無効にする', (
      WidgetTester tester,
    ) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        teaching(<String>['D = 9 - 8 = 1']),
      );

      final Finder understood = find.widgetWithText(
        ChunkyButton,
        ja.sessionUnderstood,
      );
      expect(understood, findsOneWidget);

      // 再buildを待たず同じフレームで二度押しても、controller側の門で1通にする。
      await tester.tap(understood);
      await tester.tap(understood);
      await tester.pump();

      expect(controller.controlCalls, hasLength(1));
      final Map<String, dynamic> payload =
          jsonDecode(controller.controlCalls.single.payload)
              as Map<String, dynamic>;
      expect(payload, <String, dynamic>{
        'v': 1,
        'type': 'understood',
        'session_id': 'ses_1',
      });
      final ChunkyButton disabled = tester.widget(understood);
      expect(disabled.onPressed, isNull);
      expect(find.text(ja.sessionVoiceStopped), findsOneWidget);

      final Finder disabledBody = find.descendant(
        of: understood,
        matching: find.byType(AnimatedContainer),
      );
      final AnimatedContainer settled = tester.widget(disabledBody);
      expect(settled.padding, const EdgeInsets.only(top: 4));
      final Container face = tester
          .widgetList<Container>(
            find.descendant(of: understood, matching: find.byType(Container)),
          )
          .firstWhere(
            (Container candidate) =>
                candidate.decoration is BoxDecoration &&
                (candidate.decoration! as BoxDecoration).color ==
                    AppColors.border,
          );
      final BoxDecoration decoration = face.decoration! as BoxDecoration;
      expect(decoration.color, AppColors.border);
      expect(decoration.boxShadow, isEmpty);
    });

    /// **先輩が部屋を出るのを待たない。**
    ///
    /// 待つ作りだったころ、agent は「わかった」を受けてから復習問題(LLM。数十秒)を
    /// 作り、作り終えても部屋に残っていた(`session.close()` は声を畳むだけ)。
    /// こちらは先輩の退室を待っていたので、互いに待って画面が止まる。しかも
    /// 「わかった」の直後は「わかった」も × も OSの戻るも塞いであるので、
    /// **出口がひとつも無い画面**が残り時間ぶん続いた。
    testWidgets('「わかった」が届いたら、先輩の退室を待たずに到達として降りる', (
      WidgetTester tester,
    ) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        teaching(<String>['D = 9 - 8 = 1']),
      );

      await tester.tap(find.text(ja.sessionUnderstood));
      await tester.pump();

      expect(controller.controlCalls, hasLength(1));
      expect(controller.finishCalls, 1);
      // 降り方は到達。残り時間で降りた回と、祝福画面の見せるものが違う。
      expect(controller.lastEnding, SessionEnding.understood);
    });

    /// 送れていないので先輩はまだ喋っている。掛け金を立てたままにすると
    /// 「わかった」も × も無効のまま「声を止めたよ」だけが出て、**時間切れまで
    /// 何も押せない画面**になる。回線が一瞬切れただけでそこへ落ちる。
    testWidgets('制御RPCが届かなかったら「わかった」と × を押せるまま戻す', (
      WidgetTester tester,
    ) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        teaching(<String>['D = 9 - 8 = 1']),
        controlFails: true,
      );

      final Finder understood = find.widgetWithText(
        ChunkyButton,
        ja.sessionUnderstood,
      );
      await tester.tap(understood);
      await tester.pump();

      expect(controller.controlCalls, hasLength(1));
      expect(controller.snapshot.isUnderstood, isFalse);
      // 届いていないので降りない。降りると、先輩が喋り続けている会話を
      // 到達として畳んでしまう。
      expect(controller.finishCalls, 0);
      // 「声を止めたよ」は出さない。止まっていないので。
      expect(find.text(ja.sessionVoiceStopped), findsNothing);
      // もう一度押せる = 出口が残っている。
      expect(
        tester.widget<ChunkyButton>(understood).onPressed,
        isNotNull,
      );
      expect(
        tester
            .widget<Semantics>(
              find.ancestor(
                of: find.byKey(const Key('session-close')),
                matching: find.byType(Semantics),
              ).first,
            )
            .properties
            .enabled,
        isTrue,
      );
    });

    testWidgets('「わかった」のあとも最後の板書を消さない', (WidgetTester tester) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        teaching(<String>['1行目', 'D = 9 - 8 = 1']),
      );
      final BoardSnapshot before = controller.snapshot.board;

      await tester.tap(find.text(ja.sessionUnderstood));
      await tester.pump();

      expect(find.byType(BoardElementView), findsNWidgets(2));
      expect(find.text('1行目'), findsOneWidget);
      expect(find.text('D = 9 - 8 = 1'), findsOneWidget);
      expect(identical(controller.snapshot.board, before), isTrue);
    });

    testWidgets('×から「つづける」を選ぶと、板書・残り時間・類題待ちを変えない', (WidgetTester tester) async {
      final SessionState initial = teaching(<String>[
        'D = 9 - 8 = 1',
      ]).copyWith(awaitingSolving: true);
      final FakeSessionController controller = await pumpSession(
        tester,
        initial,
      );

      expect(
        tester.getSize(find.byKey(const Key('session-close'))),
        const Size.square(44),
      );
      await tester.tap(find.byKey(const Key('session-close')));
      await tester.pumpAndSettle();

      expect(find.text(ja.sessionQuitTitle), findsOneWidget);
      expect(find.text(ja.sessionQuitBody), findsOneWidget);
      final Iterable<ModalBarrier> barriers = tester.widgetList<ModalBarrier>(
        find.byType(ModalBarrier),
      );
      expect(
        barriers.any(
          (ModalBarrier barrier) =>
              barrier.color == AppColors.ink.withValues(alpha: 0.55),
        ),
        isTrue,
      );
      expect(
        tester.getSize(find.byKey(const Key('session-exit-dialog-card'))).width,
        lessThanOrEqualTo(305),
      );
      final DecoratedBox card = tester.widget(
        find.byKey(const Key('session-exit-dialog-card')),
      );
      final BoxDecoration cardDecoration = card.decoration as BoxDecoration;
      expect(cardDecoration.color, AppColors.surface);
      expect(
        cardDecoration.borderRadius,
        BorderRadius.circular(AppRadius.card),
      );
      final Padding cardPadding = tester.widget(
        find
            .descendant(
              of: find.byKey(const Key('session-exit-dialog-card')),
              matching: find.byType(Padding),
            )
            .first,
      );
      expect(cardPadding.padding, const EdgeInsets.all(AppSpacing.lg));

      await tester.tap(find.widgetWithText(ChunkyButton, ja.sessionContinue));
      await tester.pumpAndSettle();

      expect(find.text(ja.sessionQuitTitle), findsNothing);
      expect(identical(controller.snapshot, initial), isTrue);
      expect(find.text('D = 9 - 8 = 1'), findsOneWidget);
      // 残り時間は画面から畳んだが、確認を閉じただけで内部の残高まで
      // 進めると日次枠の精算がずれるので、状態の値はそのまま守る。
      expect(controller.snapshot.remainingSeconds, 1200);
      expect(find.text(ja.sessionSolved), findsOneWidget);
      expect(find.text(ja.sessionStuck), findsOneWidget);
      expect(controller.finishCalls, 0);
    });

    testWidgets('OSの戻る操作も、授業を捨てる前に同じ確認を出す', (WidgetTester tester) async {
      await pumpSession(tester, teaching(<String>['D = 9 - 8 = 1']));

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      expect(find.text(ja.sessionQuitTitle), findsOneWidget);
      await tester.tap(find.widgetWithText(ChunkyButton, ja.sessionContinue));
      await tester.pumpAndSettle();
      expect(find.byType(SessionScreen), findsOneWidget);
    });

    /// **前の行は消さない**(計画書§3-2)。板書の価値そのもの。
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

    /// 問いかけを待つ間も、到達の宣言を取り上げない。
    testWidgets('問いかけ待ちでも板書を残し、「わかった」を押せる', (WidgetTester tester) async {
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
      // 番はまだ渡っていない(板書の最後の手順が待っていない)ので、
      // 黙っているのは**先輩が次を考えているから**([SessionState.turn])。
      expect(find.text(ja.sessionSenpaiThinking), findsOneWidget);
      expect(find.text(ja.sessionUnderstood), findsOneWidget);
    });

    testWidgets('類題を解いている間だけ「できた / できなかった」を出し、押したら消す', (
      WidgetTester tester,
    ) async {
      const BoardSnapshot board = BoardSnapshot(
        title: '判別式',
        steps: <BoardStep>[
          BoardStep(
            index: 0,
            speech: 'じゃあ、この類題はどうなる?',
            board: BoardElement.latex(tex: 'x^2 - 5x + 6 = 0'),
            awaitsSolving: true,
          ),
        ],
      );
      final FakeSessionController controller = await pumpSession(
        tester,
        const SessionState(
          phase: SessionPhase.explainBack,
          remainingSeconds: 1200,
          board: board,
          awaitingSolving: true,
        ),
      );

      expect(find.text(ja.sessionSolving), findsOneWidget);
      expect(find.text(ja.sessionSolved), findsOneWidget);
      expect(find.text(ja.sessionStuck), findsOneWidget);
      expect(find.text(ja.sessionPass), findsNothing);
      expect(find.text(ja.sessionUnderstood), findsNothing);

      await tester.tap(find.text(ja.sessionSolved));
      await tester.pump();

      expect(controller.solvingReports, <String>[ja.sessionSolvedMessage]);
      expect(find.text(ja.sessionSolved), findsNothing);
      expect(find.text(ja.sessionStuck), findsNothing);
      expect(find.text(ja.sessionUnderstood), findsOneWidget);
    });

    testWidgets('ボタンを押さず声で答えた場合も、類題の二択を消す', (WidgetTester tester) async {
      final FakeSessionController controller = await pumpSession(
        tester,
        const SessionState(
          phase: SessionPhase.explainBack,
          remainingSeconds: 1200,
          awaitingSolving: true,
          board: BoardSnapshot(
            title: '判別式',
            steps: <BoardStep>[
              BoardStep(
                index: 0,
                speech: 'じゃあ、この類題はどうなる?',
                board: BoardElement.latex(tex: 'x^2 - 5x + 6 = 0'),
                awaitsSolving: true,
              ),
            ],
          ),
        ),
      );

      expect(find.text(ja.sessionSolved), findsOneWidget);
      controller.onUserTurn();
      await tester.pump();

      expect(find.text(ja.sessionSolved), findsNothing);
      expect(find.text(ja.sessionStuck), findsNothing);
      expect(find.text(ja.sessionUnderstood), findsOneWidget);
      expect(controller.solvingReports, isEmpty);
    });

    /// **何を解いているかが画面のどこにも無かった。**
    ///
    /// 出ていたのは `board.title`(先輩が付けた見出し)だけで、問題そのものは
    /// 撮影画面を離れた瞬間に見えなくなる。教え返しの最中にいちばん見返したいのが
    /// 問題文なので、板書の上に置いて授業のあいだ残す
    /// (`docs/wireframe_board_v2.html` の1つ目)。
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
      // 板書はそのまま主役。問題文を足したぶんで実効幅を削らない。
      expect(
        tester.getSize(find.byType(BoardView)).width,
        greaterThanOrEqualTo(340),
      );
    });

    /// **読めなかったことを画面で騒がない。**「問題が読み取れませんでした」と出すと、
    /// 先輩が読み上げを頼む前に、生徒は撮り直しに行ってしまう。
    testWidgets('問題文が読めていなければ、何も出さない', (WidgetTester tester) async {
      await pumpSession(tester, teaching(<String>['x^2 - 3x + 2 = 0']));

      expect(find.text(ja.sessionProblemTitle), findsNothing);
    });

    /// 契約の上限は600字。全文をそのまま出すと**板書が画面の外へ出る**ので、
    /// 3行で畳んで「続きを読む」を出す。
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
      // 開いても板書は画面に残る(押し出さない)。
      expect(find.byType(BoardElementView), findsOneWidget);
    });

    /// **いまは誰の番か。**8/25 のドッグフーディングで出た
    /// 「自分のターンなのかAIのターンなのか分かりにくい」への手当て。
    ///
    /// 見ているのは印そのもの(文言は読まないと分からない):
    ///   - 先輩が喋っている … 波もローダーも出さない
    ///   - 先輩が考えている … 円のローダー
    ///   - こちらの番      … 3本の波
    ///
    /// **授業中に先輩が黙る理由は2つある。**答えを待っているのか、次の手順を
    /// 考えているのか。板書の `awaits_student` だけがそれを知っている。
    group('いまは誰の番か', () {
      /// 最後の手順で番を渡した板書。
      SessionState handedOver({SessionPhase phase = SessionPhase.explainBack}) {
        final SessionState taught = teaching(<String>['D = b^2 - 4ac']);
        return taught.copyWith(
          phase: phase,
          board: BoardSnapshot(
            title: taught.board.title,
            steps: <BoardStep>[
              for (final BoardStep step in taught.board.steps)
                step.copyWith(awaitsStudent: true),
            ],
          ),
          awaitingStudent: true,
        );
      }

      testWidgets('先輩が喋っているあいだは、波もローダーも出さない', (WidgetTester tester) async {
        await pumpSession(tester, teaching(<String>['D = b^2 - 4ac']));

        expect(find.text(ja.sessionTeachingStatus), findsOneWidget);
        expect(find.byType(SpeakingWave), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);
      });

      testWidgets('番が渡ってきたら、3本の波を出す', (WidgetTester tester) async {
        await pumpSession(tester, handedOver());

        expect(find.text(ja.sessionYourTurn), findsOneWidget);
        final SpeakingWave wave = tester.widget<SpeakingWave>(find.byType(SpeakingWave));
        expect(wave.active, isTrue);
        expect(wave.bars, 3);
        expect(find.byType(CircularProgressIndicator), findsNothing);
      });

      // 類題を解いている間は、番はこちらのまま。文言だけ問題に合わせる。
      testWidgets('類題を解いている間も、番はこちら', (WidgetTester tester) async {
        await pumpSession(tester, handedOver().copyWith(awaitingSolving: true));

        expect(find.text(ja.sessionSolving), findsOneWidget);
        expect(find.byType(SpeakingWave), findsOneWidget);
      });

      // **ここが取り違えの本体。**黙っていても番が渡っていなければ、
      // 待っているのはこちら(先輩は次の手順を考えている)。
      testWidgets('番を渡していないのに黙っていたら、考え中のローダーを出す', (
        WidgetTester tester,
      ) async {
        await pumpSession(
          tester,
          teaching(<String>['D = b^2 - 4ac']).copyWith(phase: SessionPhase.explainBack),
        );

        expect(find.text(ja.sessionSenpaiThinking), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(find.byType(SpeakingWave), findsNothing);
      });

      // 答えた瞬間に番は返る。ここを落とすと「きみの番」が出たまま止まる。
      testWidgets('こちらが答えたら、その場で考え中へ戻る', (WidgetTester tester) async {
        final FakeSessionController controller = await pumpSession(
          tester,
          handedOver().copyWith(awaitingSolving: true),
        );

        await tester.tap(find.text(ja.sessionSolved));
        await tester.pumpAndSettle();

        expect(controller.snapshot.awaitingStudent, isFalse);
        expect(find.text(ja.sessionSenpaiThinking), findsOneWidget);
        expect(find.byType(SpeakingWave), findsNothing);
      });

      // 「わかった」のあとは番の話ではない。声を止めたことだけを出す。
      testWidgets('「わかった」のあとは、番の印を出さない', (WidgetTester tester) async {
        await pumpSession(tester, handedOver().copyWith(isUnderstood: true));

        expect(find.text(ja.sessionVoiceStopped), findsOneWidget);
        expect(find.byType(SpeakingWave), findsNothing);
      });
    });

    testWidgets('とぎれたら、板書は残したままそのことを出す', (WidgetTester tester) async {
      await pumpSession(
        tester,
        teaching(<String>['x^2 - 3x + 2 = 0'], gapReason: 'seq は0始まりで1ずつ'),
      );

      expect(find.byType(BoardElementView), findsOneWidget);
      expect(find.text(ja.sessionBoardGap), findsOneWidget);
      // 技術的な理由はそのまま画面に出さない。
      expect(find.textContaining('seq'), findsNothing);
    });

    /// **画面側で板書の幅を殺していないこと**(計画書§3-6b)。
    ///
    /// `board_style.dart` の縮小率の下限70%は、**実効幅340pt**
    /// (iPhone 15 の393pt − 板書の余白)で測った結果から決めた値。ここに
    /// カードや内側パディングを足して実効幅が340ptを割ると、実測では
    /// 収まっていた式まで横スクロールに落ちる — しかも**落ちたことは
    /// 見た目では気づけない**(`debugPrint` にしか出ない)ので、幅で見張る。
    testWidgets('板書の実効幅は、実測の前提(340pt)を下回らない', (WidgetTester tester) async {
      await setSurface(tester);
      await pumpSession(tester, teaching(<String>['x^2 - 3x + 2 = 0']));

      expect(
        tester.getSize(find.byType(BoardView)).width,
        greaterThanOrEqualTo(340),
      );
    });

    /// **板書が読み上げから欠けていないこと。**
    ///
    /// `Math.tex` も `CustomPaint` も、包まなければ VoiceOver から不可視。
    /// 板書はプロダクトの中心なので、ここが欠けると目が見えない生徒には
    /// **授業が存在しないのと同じ**になる。
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

      // 数式は記号ごとにバラバラに読まれず、1文になっている。
      expect(
        find.bySemanticsLabel('x の 2 乗 マイナス 3x プラス 2 イコール 0'),
        findsOneWidget,
      );
      // 図形は「何が描かれているか」。包まなければ1文字も読まれない。
      expect(find.bySemanticsLabel(RegExp(r'円。半径 5')), findsOneWidget);
    });

    /// **狭い端末では「幅が足りない」を送らない。**
    ///
    /// 黒板を角丸カードにした設計では、外24ptと内18ptの余白が左右に入る。
    /// iPhone 15(393pt)でも309pt、iPhone SE(375pt)では291ptしか取れないので、
    /// 旧340ptを閾値にすると**全利用者ぶんが毎回飛ぶ**。設計上の余白は版組の落ち度では
    /// ないし、それを送ると本当に見たい「こちらが幅を食った」が件数に埋もれる。
    group('板書の幅の見張り', () {
      test('iPhone 15 では、カードの外側と内側の余白を引いた309ptが閾値', () {
        expect(BoardStyle.expectedWidth(393), 309);
      });

      test('iPhone SE では、その端末で取れる幅291ptが閾値', () {
        expect(BoardStyle.expectedWidth(375), 291);
      });

      // さらに16ptずつ別の枠へ入った実測相当。**これは版組が余計に食った幅**
      // なので、どの端末でも設計値を下回る = 送られる。
      test('版組が食った幅は、狭い端末でも閾値を下回る', () {
        expect(275, lessThan(BoardStyle.expectedWidth(375)));
        expect(275, lessThan(BoardStyle.expectedWidth(393)));
      });
    });

    /// **狭い端末で、板書が画面からこぼれていないか**(`layout_overflow_test.dart` の続き)。
    ///
    /// 掃きテストは全画面を1枚ずつ描いているが、会話画面だけはそこに入れていない
    /// (会話の状態を組む足場がこちらにあるため)。**入れる価値はいちばん高い**:
    ///
    ///   - 板書は手順が積み上がる = **高さが実行時に決まる唯一の画面**
    ///   - 教え返し中は板書を残したまま下にマイクUIが乗る = **固定ブロックが最も厚い**
    ///   - とぎれた一行が、そこにさらに乗る
    ///
    /// ここに残っていれば、それが出るのは 8/16 のゲートの最中になる。
    for (final Locale locale in <Locale>[
      const Locale('ja'),
      const Locale('en'),
    ]) {
      final String lang = locale.languageCode;

      /// 手順を積めるだけ積んだ授業。実際の板書は12手順まで(`board.ts`)。
      SessionState packed({
        SessionPhase phase = SessionPhase.senpaiTeaching,
        String? gapReason,
      }) => SessionState(
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
          reason:
              '$what が $lang で '
              '${smallPhoneSurface.width.toInt()}x${smallPhoneSurface.height.toInt()} から溢れています',
        );
      }

      testWidgets('狭い端末: 授業中に板書が積まれても溢れない ($lang)', (
        WidgetTester tester,
      ) async {
        await pumpSession(
          tester,
          packed(),
          locale: locale,
          size: smallPhoneSurface,
        );
        // **空振りで緑にならないこと。** 板書が1行も描かれていなければ、
        // 溢れないのは当たり前で、この検査は何も見ていない。
        expect(find.byType(BoardElementView), findsNWidgets(12));
        expectNoOverflow(tester, '授業中');
      });

      // 固定ブロックがいちばん厚くなる状態(板書 + マイクUI)。
      testWidgets('狭い端末: 教え返し中も溢れない ($lang)', (WidgetTester tester) async {
        await pumpSession(
          tester,
          packed(phase: SessionPhase.explainBack),
          locale: locale,
          size: smallPhoneSurface,
        );
        expectNoOverflow(tester, '教え返し中');
      });

      testWidgets('狭い端末: 類題の二択が出ても溢れない ($lang)', (WidgetTester tester) async {
        final SessionState state = packed(phase: SessionPhase.explainBack);
        await pumpSession(
          tester,
          state.copyWith(awaitingSolving: true),
          locale: locale,
          size: smallPhoneSurface,
        );

        expect(find.text(AppStrings(locale).sessionSolved), findsOneWidget);
        expect(find.text(AppStrings(locale).sessionStuck), findsOneWidget);
        expectNoOverflow(tester, '類題の二択');
      });

      // とぎれた一行が、いちばん厚い状態の上にさらに乗る。
      testWidgets('狭い端末: とぎれた一行が乗っても溢れない ($lang)', (WidgetTester tester) async {
        await pumpSession(
          tester,
          packed(phase: SessionPhase.explainBack, gapReason: 'seq は0始まりで1ずつ'),
          locale: locale,
          size: smallPhoneSurface,
        );
        expectNoOverflow(tester, 'とぎれた状態');
      });

      /// **実機で踏んだ溢れ**(「今日はここまで」に BOTTOM OVERFLOWED が重なった)。
      ///
      /// 板書が無い会話では顔と字幕を `Spacer` で挟んでいた。授業中の `speech` は
      /// 契約で120字までだが、**教え返しに入ると相手は会話LLMで上限が無い**。
      /// 長い返事がそのまま固定の高さになり、下の操作を画面の外へ押し出していた。
      testWidgets('狭い端末: 板書が無いまま長く喋られても溢れない ($lang)', (
        WidgetTester tester,
      ) async {
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

      /// 板書があるときも、下の帯が伸びて板書を押し出さないこと。
      testWidgets('狭い端末: 板書つきで長く喋られても溢れない ($lang)', (
        WidgetTester tester,
      ) async {
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

    /// 板書を受け取らない会話(既存の復習)は、今までどおり顔が主役。
    testWidgets('板書が無ければ、画面はこれまでのまま', (WidgetTester tester) async {
      await pumpSession(
        tester,
        const SessionState(
          phase: SessionPhase.listening,
          remainingSeconds: 1200,
        ),
      );

      expect(find.byType(BoardElementView), findsNothing);
      final SenpaiFace face = tester.widget(find.byType(SenpaiFace));
      expect(face.size, 160);
    });
  });
}

/// 会話画面が「セッションはある」と読めるようにするだけの差し替え。
///
/// [problem] を渡すと、解析が問題文を読み取れた状態になる。
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
      livekit: LiveKitConnection(
        url: 'wss://example',
        token: 't',
        room: 'ses_1',
      ),
      limits: SessionLimits(
        maxSeconds: 1200,
        remainingSecondsToday: 1200,
        lessonAllowedToday: true,
      ),
    ),
  );
}

/// 状態を外から差し替えられる差し替え。LiveKitにはつなぎに行かせない。
class FakeSessionController extends SessionController {
  FakeSessionController(this._initial, {this.controlFails = false});

  final SessionState _initial;

  /// 制御RPCを落とす。回線が切れているあいだの「わかった」を再現する。
  final bool controlFails;
  final List<String> solvingReports = <String>[];
  final List<PerformRpcParams> controlCalls = <PerformRpcParams>[];
  int finishCalls = 0;
  SessionEnding? lastEnding;

  SessionState get snapshot => state;

  @override
  SessionState build() => _initial;

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {}

  @override
  String? get activeSessionId => 'ses_1';

  @override
  String get activeSenpaiIdentity => 'agent_1';

  @override
  SessionControlClient get sessionControlClient =>
      SessionControlClient((PerformRpcParams params) async {
        controlCalls.add(params);
        if (controlFails) throw StateError('制御RPCが届きませんでした');
        return '{"v":1,"accepted":true}';
      });

  @override
  Future<void> reportSolving(String message) async {
    solvingReports.add(message);
    await super.reportSolving(message);
  }

  @override
  Future<void> finish({SessionEnding? ending}) async {
    finishCalls += 1;
    lastEnding = ending;
  }

  /// 板書が1行増えた、を再現する。
  void push(SessionState next) => state = next;
}

