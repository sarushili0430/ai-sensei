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
      // 見出しだけで授業モードに入る(1手順目が届くまで顔のままにしない)。
      expect(inbox.snapshot.hasBoard, isTrue);

      inbox.accept(step(1, 0, body: 'x^2 の係数'));
      inbox.accept(step(2, 1, body: 'D = 9 - 8'));
      expect(inbox.snapshot.steps.length, 2);
      expect((inbox.snapshot.steps.first.board! as TextElement).body, 'x^2 の係数');
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

    test('board_open は前の板書を消す(別の問題に移るとき)', () {
      final BoardInbox inbox = BoardInbox(sessionId: sessionId);
      inbox.accept(open(0));
      inbox.accept(step(1, 0));
      inbox.accept(close(2, 1));

      inbox.accept(open(3, boardId: 'brd_2', title: '三角比'));
      expect(inbox.snapshot.steps, isEmpty);
      expect(inbox.snapshot.title, '三角比');
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
    }) async {
      await pumpApp(
        tester,
        const SessionScreen(),
        locale: locale,
        size: size,
        overrides: <Object?>[
          captureControllerProvider.overrideWith(FakeCaptureController.new),
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
      remainingSeconds: 900,
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
      // 見出し(何の問題か)も出る。
      expect(find.text('判別式'), findsOneWidget);
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

    /// 教え返し(コアループ §2)。**板書を残したまま**マイクに向かわせる。
    testWidgets('教え返し中も板書は残り、「説明してみて」が出る', (WidgetTester tester) async {
      final SessionState taught = teaching(<String>['D = 9 - 8 = 1 > 0']);
      await pumpSession(
        tester,
        SessionState(
          phase: SessionPhase.explainBack,
          remainingSeconds: 900,
          board: taught.board,
        ),
      );

      expect(find.byType(BoardElementView), findsOneWidget);
      expect(find.text(ja.sessionExplainBack), findsOneWidget);
      // 聞いている顔で待つ(試験官にはしない)。
      final SenpaiFace face = tester.widget(find.byType(SenpaiFace));
      expect(face.mood, SenpaiMood.listening);
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

      expect(tester.getSize(find.byType(BoardView)).width, greaterThanOrEqualTo(340));
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
          remainingSeconds: 900,
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
    /// 実測の前提 340pt は iPhone 15(393pt)基準の値。iPhone SE(375pt)は
    /// どう組んでも 375 − 48 = **327pt** にしかならないので、340 をそのまま
    /// 閾値にすると**SEの利用者ぶんが毎回飛ぶ**。端末が狭いのは版組の落ち度では
    /// ないし、それを送ると本当に見たい「こちらが幅を食った」が件数に埋もれる。
    group('板書の幅の見張り', () {
      test('iPhone 15 では実測の前提(340pt)がそのまま閾値', () {
        expect(BoardStyle.expectedWidth(393), 340);
      });

      test('iPhone SE では、その端末で取れる幅(327pt)が閾値', () {
        expect(BoardStyle.expectedWidth(375), 327);
      });

      // 自習室がカードに入れていたときの実測値。**これは版組が食った幅**なので、
      // どの端末でも閾値を下回る = 送られる。
      test('版組が食った幅は、狭い端末でも閾値を下回る', () {
        expect(311, lessThan(BoardStyle.expectedWidth(375)));
        expect(311, lessThan(BoardStyle.expectedWidth(393)));
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
    for (final Locale locale in <Locale>[const Locale('ja'), const Locale('en')]) {
      final String lang = locale.languageCode;

      /// 手順を積めるだけ積んだ授業。実際の板書は12手順まで(`board.ts`)。
      SessionState packed({SessionPhase phase = SessionPhase.senpaiTeaching, String? gapReason}) =>
          SessionState(
            phase: phase,
            remainingSeconds: 900,
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
    }

    /// 板書を受け取らない会話(既存の復習)は、今までどおり顔が主役。
    testWidgets('板書が無ければ、画面はこれまでのまま', (WidgetTester tester) async {
      await pumpSession(
        tester,
        const SessionState(phase: SessionPhase.listening, remainingSeconds: 900),
      );

      expect(find.byType(BoardElementView), findsNothing);
      final SenpaiFace face = tester.widget(find.byType(SenpaiFace));
      expect(face.size, 160);
    });
  });
}

/// 会話画面が「セッションはある」と読めるようにするだけの差し替え。
class FakeCaptureController extends CaptureController {
  @override
  CaptureState build() => const CaptureState(
    session: SessionStart(
      sessionId: 'ses_1',
      kind: 'new',
      livekit: LiveKitConnection(url: 'wss://example', token: 't', room: 'ses_1'),
      detectedTopics: <DetectedTopic>[],
      limits: SessionLimits(maxSeconds: 900, lessonAllowedToday: true),
    ),
  );
}

/// 状態を外から差し替えられる差し替え。LiveKitにはつなぎに行かせない。
class FakeSessionController extends SessionController {
  FakeSessionController(this._initial);

  final SessionState _initial;

  @override
  SessionState build() => _initial;

  @override
  Future<void> connect(SessionStart session) async {}

  /// 板書が1行増えた、を再現する。
  void push(SessionState next) => state = next;
}
