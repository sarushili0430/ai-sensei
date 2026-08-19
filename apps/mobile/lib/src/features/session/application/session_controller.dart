import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../../audio/prerendered_audio.dart';
import '../../../telemetry/telemetry.dart';
import '../../karte/application/karte_controllers.dart';
import '../../karte/application/last_board_controller.dart';
import '../domain/board.dart';
import '../domain/session.dart';
import 'board_inbox.dart';
import 'lesson_opening_audio.dart';

part 'session_controller.g.dart';

/// 会話セッションの進行状態。
///
/// 会話そのものはエージェント側が回すので、アプリが持つのは
/// 「つながっているか」「先輩が喋っているか」「残り時間」だけ。
///
/// **授業モード(計画書§4-1)は「誰が喋っているか」が同じでも意味が違う。**
/// 板書が出ているあいだは、先輩の発話は「質問」ではなく「説明」で、
/// こちらの発話は「説明」ではなく「教え返し」になる。信号(`AgentState`)は
/// 同じものを読むが、画面に出すものが変わるのでフェーズを分けてある。
/// **既存の復習の会話は板書を受け取らないので、そちらの経路は何も変わらない。**
enum SessionPhase {
  /// ルームにつないで、先輩が入ってくるのを待っている。
  connecting,
  listening,
  senpaiSpeaking,

  /// 先輩が板書つきで教えている(授業モード)。
  senpaiTeaching,

  /// 「じゃあ今の、説明してみて」。**板書は残したまま**こちらが喋る番。
  explainBack,

  /// 会話は終わり、カルテを待っている。生成に数秒かかる。
  summarizing,
  finished,
  failed,
}

/// 会話が始まらなかった理由。
///
/// **失敗を「聞いています」のまま見せない。** どちらの理由かで打つ手が違う
/// (電波を確かめる / 時間をおく)ので、画面の文言も分ける。
enum SessionFailure {
  /// ルームにつなげなかった。通信・トークン・マイクのどれか。
  connection,

  /// つながったが、先輩が入ってこなかった。エージェント側の問題。
  senpaiUnavailable,
}

@immutable
class SessionState {
  const SessionState({
    required this.phase,
    required this.remainingSeconds,
    this.lastSenpaiText,
    this.board = BoardSnapshot.empty,
    this.awaitingSolving = false,
    this.failure,
    this.error,
    this.showPaywall = false,
    this.resultMissing = false,
  });

  final SessionPhase phase;
  final int remainingSeconds;

  /// 直近の先輩の発話(字幕表示用)。声を聞き取れない場所でも進められるように出す。
  final String? lastSenpaiText;

  /// いま黒板に書いてあるもの。**1つの問題ぶん生き続ける**(計画書§3-2)。
  /// 板書を受け取らない会話(既存の復習)では空のまま。
  final BoardSnapshot board;

  /// 類題を解いている間だけ true。ボタンか声の申告を受けた瞬間に false にする。
  final bool awaitingSolving;

  /// `phase == failed` のときだけ入る。
  final SessionFailure? failure;
  final Object? error;

  /// サーバが「ここで出す」と判断したときだけ true(初回カルテで穴が見えた直後)。
  final bool showPaywall;

  /// カルテを待ちきれなかった。祝福だけ見せて、カルテは後で取りに行く。
  final bool resultMissing;

  SessionState copyWith({
    SessionPhase? phase,
    int? remainingSeconds,
    String? lastSenpaiText,
    BoardSnapshot? board,
    bool? awaitingSolving,
    SessionFailure? failure,
    Object? error,
    bool? showPaywall,
    bool? resultMissing,
  }) {
    return SessionState(
      phase: phase ?? this.phase,
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      lastSenpaiText: lastSenpaiText ?? this.lastSenpaiText,
      board: board ?? this.board,
      awaitingSolving: awaitingSolving ?? this.awaitingSolving,
      failure: failure ?? this.failure,
      error: error ?? this.error,
      showPaywall: showPaywall ?? this.showPaywall,
      resultMissing: resultMissing ?? this.resultMissing,
    );
  }
}

/// LiveKitルームへの接続を持つ。
///
/// WebRTCは書かない(livekit_clientに任せる)。ここでやるのは
/// 接続・マイク公開・**先輩の出入りと発話の受け取り**・残り時間・切断だけ。
/// 会話の寿命に合わせて破棄する(画面を離れたら接続も状態も残さない)。
@riverpod
class SessionController extends _$SessionController {
  Room? _room;
  EventsListener<RoomEvent>? _events;
  TranscriptionStreamReceiver? _transcripts;
  StreamSubscription<ReceivedMessage>? _transcriptSubscription;
  Timer? _ticker;
  Timer? _senpaiWatchdog;
  String? _sessionId;
  String? _sessionKind;

  /// 板書の受信。接続のたびに作り直す(板書はセッションをまたがない)。
  BoardInbox? _boardInbox;

  /// 授業の最初の板書までを埋める、ローカル音声の寿命。
  ///
  /// agent の TTS へ同じ文を渡すと、固定文なのに毎回従量原価が発生する。
  /// モバイルのアセットだけを鳴らし、板書か本物の先輩の声が先着したら止める。
  LessonOpeningAudio? _lessonOpeningAudio;

  /// 封筒の処理を**到着順に直列化する**ための鎖。
  ///
  /// ハンドラは封筒の到着順に呼ばれるが、`readAll()` の完了順まで同じとは限らない
  /// (チャンク数が違えば後の封筒が先に読み終わる)。順番が入れ替わると、
  /// 受信側の `seq` の検算はそれを**欠落として扱う** — 実際には全部届いているのに
  /// 板書がとぎれる。だから読み出しそのものを1本の鎖につないで、
  /// 到着順のまま処理する。
  ///
  /// **ここを外すと、再現しにくい壊れ方になる。**追い越しが起きるかどうかは
  /// 封筒ごとのチャンク数(= `tex` や `speech` の長さ)と回線次第なので、
  /// 同じ問題を教わっても起きたり起きなかったりする。しかも症状は
  /// 「板書がとぎれました」— **配送は正常なのに、欠落検知のほうが誤報する。**
  Future<void> _boardQueue = Future<void>.value();

  /// 先輩の状態(`lk.agent.state`)の読み取りはSDKに任せる。
  final Agent _senpai = Agent();
  String? _senpaiIdentity;
  bool _finishing = false;

  /// 先輩が部屋に来るのを待つ時間。
  ///
  /// エージェントのワーカーが動いていない・ディスパッチされていないときは、
  /// 部屋は開いたまま誰も来ない。**待ち続けさせない**(上限時間まで
  /// 「聞いています」を見せるのが、いちばん不親切な壊れ方)。
  static const Duration senpaiJoinTimeout = Duration(seconds: 25);

  /// 切断の完了を待つ上限。
  ///
  /// SDKの `Room.disconnect()` は完了イベントを10秒待ってから例外を投げる。
  /// 会話が終わったあとの10秒は、カルテを待つ画面がただ固まる時間でしかない。
  /// 待つのはここまでにして、あとは `dispose()` に任せる。
  static const Duration _disconnectTimeout = Duration(seconds: 3);

  /// 会話画面でカルテを待つ上限。
  ///
  /// カルテはエージェントがLLMで書くので、会話が終わってから数秒〜十数秒かかる。
  /// **その全部をこの画面で待たない。** 待ちきると、終わってから画面が変わるまで
  /// 最長1分「考えています」のまま止まり、押しても何も起きない画面を見せ続ける
  /// ことになる。ここまで待って来なければ先に祝福へ進み、カルテは祝福画面が
  /// 受け取りに行く([SessionOutcomeController.retrieveKarte])。
  static const Duration _karteGrace = Duration(seconds: 8);
  static const Duration _kartePollInterval = Duration(seconds: 1);

  /// 封筒1通を読み切るまでの上限。
  ///
  /// 封筒は手順1つぶん(数百バイト)で、reliableな経路で届く。5秒待っても
  /// 揃わないなら、それは遅いのではなく**来ない**。上限が無いと、
  /// 閉じないストリームを1本掴んだだけで [_boardQueue] が止まり、
  /// **後続の板書が全部止まる**(そして「まだ来ていない」の顔で待ち続ける)。
  /// 諦めた封筒は次の `seq` のずれとして検知される(それが `seq` を持つ理由)。
  static const Duration _boardStreamTimeout = Duration(seconds: 5);

  @override
  SessionState build() {
    ref.onDispose(() {
      unawaited(_teardown());
    });
    return const SessionState(phase: SessionPhase.connecting, remainingSeconds: 0);
  }

  Future<void> connect(SessionStart session, {required String locale}) async {
    _sessionId = session.sessionId;
    _sessionKind = session.kind;

    final LessonOpeningAudio openingAudio = LessonOpeningAudio(
      ref.read(prerenderedAudioProvider),
    );
    _lessonOpeningAudio = openingAudio;
    // **接続前に arm する。**接続イベントのほうが `Room.connect()` の Future より
    // 先に届くことがあり、その中で先輩が喋ったら「もう鳴らさない」を記録するため。
    //
    // **復習も対象にする。**復習は前回の穴を板書つきで教え直すセッションなので
    // (agent 側の `startsWithBoardLesson`)、新規授業と同じだけ最初の手順までの
    // 無音がある。agent 側は冒頭の一言をTTSで喋らなくなった(§3-2。固定文に
    // 毎回従量原価を払わないため)ので、ここで鳴らさないと**復習の冒頭だけが
    // 完全な無音**になる。板書が出ない縮退経路では先輩がすぐ喋りはじめるが、
    // その発話が `senpaiStartedSpeaking()` で cue を止めるのでかぶらない。
    openingAudio.arm(
      lessonMode: session.kind == 'new' || session.kind == 'review',
      languageCode: locale,
    );

    // セッション作成後に、今日さらに授業を始められるかはサーバが確定している。
    // ホームへ戻ったときに古い可否を見せないよう、その真偽値をそのまま引き継ぐ。
    ref
        .read(progressControllerProvider.notifier)
        .applyLessonAllowance(session.limits.lessonAllowedToday);

    // 前の会話の結果を持ち越さない。持ち越したまま今回のカルテが作れないと、
    // 祝福もカルテ画面も**前回のカルテ**を「今日のカルテ」として出してしまう。
    ref.read(sessionOutcomeControllerProvider.notifier).clear();
    ref.read(latestKarteControllerProvider.notifier).clear();

    state = SessionState(
      phase: SessionPhase.connecting,
      remainingSeconds: session.limits.maxSeconds,
    );

    try {
      final Room room = Room();
      _room = room;
      final EventsListener<RoomEvent> events = room.createListener();
      _watch(events);
      _events = events;

      // **つなぐ前に登録する。** 先輩は入室してすぐ板書を送り始めるので、
      // 接続の完了を待ってから登録すると、最初の数手順を取りこぼす。
      _boardInbox = BoardInbox(sessionId: session.sessionId);
      _boardQueue = Future<void>.value();
      room.registerTextStreamHandler(boardChannelTopic, _onBoardStream);

      await room.connect(session.livekit.url, session.livekit.token);

      // 接続後なら agent の板書生成と同時に走る。マイク公開より先に開始するのは、
      // iOS の消音スイッチを尊重する ambient session を準備したあと、LiveKit に
      // 会話用 session を確実に取り戻させるため。逆順だと録音設定を上書きしうる。
      await openingAudio.start();
      await room.localParticipant?.setMicrophoneEnabled(true);

      // 先輩の発話と、自分の声の認識結果は `lk.transcription` で流れてくる。
      // 字幕はここから来る(聞き取れない場所でも会話を追えるようにするため)。
      final TranscriptionStreamReceiver transcripts = TranscriptionStreamReceiver(room: room);
      _transcriptSubscription = transcripts.messages().listen(_onTranscript);
      _transcripts = transcripts;

      _startTicker();

      // 先にディスパッチされていれば、もう部屋にいる。
      if (room.agentParticipant != null) {
        _onSenpaiJoined();
      } else {
        _senpaiWatchdog = Timer(senpaiJoinTimeout, _onSenpaiNeverCame);
      }
    } catch (error) {
      await _teardown();
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.connection,
        error: error,
      );
    }
  }

  /// つなぎ直す。**セッションは作り直さない**(同じトークンで入り直すので、
  /// 無料枠を二重に消費しない)。
  Future<void> retry(SessionStart session, {required String locale}) async {
    await _teardown();
    _finishing = false;
    _senpaiIdentity = null;
    await connect(session, locale: locale);
  }

  /// 上限時間はサーバが決める。クライアントは表示と自動終了だけを担当する。
  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(seconds: 1), (Timer timer) {
      final int remaining = state.remainingSeconds - 1;
      // **0を飛ばさない。** 先に打ち切ると、時間切れで終わった会話が
      // 「のこり 0:01」のまま止まり、まだ1秒あるのに動かない画面になる。
      state = state.copyWith(remainingSeconds: remaining < 0 ? 0 : remaining);
      if (remaining <= 0) {
        timer.cancel();
        unawaited(finish());
      }
    });
  }

  /// ルームの出来事を状態に落とす。ここが無いと、先輩が喋っても
  /// 部屋を出ても画面は「聞いています」のまま止まる。
  void _watch(EventsListener<RoomEvent> events) {
    events
      ..on<ParticipantConnectedEvent>((ParticipantConnectedEvent event) {
        if (event.participant.kind == ParticipantKind.AGENT) _onSenpaiJoined();
      })
      ..on<ParticipantDisconnectedEvent>((ParticipantDisconnectedEvent event) {
        if (event.participant.identity == _senpaiIdentity) _onSenpaiLeft();
      })
      // 先輩の「聞いている / 考えている / 喋っている」は属性で来る
      ..on<ParticipantAttributesChanged>((_) => _syncSenpaiState())
      ..on<RoomDisconnectedEvent>((_) => _onRoomClosed());
  }

  void _onSenpaiJoined() {
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;
    _senpaiIdentity = _room?.agentParticipant?.identity;
    if (state.phase == SessionPhase.connecting) {
      state = state.copyWith(phase: _listeningPhase);
    }
    _syncSenpaiState();
  }

  /// 先輩が退室した = 会話は終わり。
  ///
  /// 締めの言葉で終わっても上限時間で終わっても、エージェントは部屋を出てから
  /// カルテを作りに行く。**ここで結果を取りに行かないと、会話が自然に終わった
  /// あとも画面は上限時間まで「聞いています」のまま残る。**
  void _onSenpaiLeft() {
    if (_senpaiIdentity == null) return;
    unawaited(finish());
  }

  void _onRoomClosed() {
    if (_finishing || state.phase == SessionPhase.finished || state.phase == SessionPhase.failed) {
      return;
    }
    if (_senpaiIdentity == null) {
      // 先輩が来ないまま部屋が閉じた。会話は成立していないのでカルテも無い。
      unawaited(_teardown());
      state = state.copyWith(
        phase: SessionPhase.failed,
        failure: SessionFailure.connection,
      );
      return;
    }
    unawaited(finish());
  }

  Future<void> _onSenpaiNeverCame() async {
    if (_senpaiIdentity != null) return;
    await _teardown();
    state = state.copyWith(
      phase: SessionPhase.failed,
      failure: SessionFailure.senpaiUnavailable,
    );
  }

  void _syncSenpaiState() {
    final RemoteParticipant? senpai = _room?.agentParticipant;
    if (senpai == null) return;
    _senpai.connected(senpai);
    switch (_senpai.agentState) {
      case AgentState.speaking:
        // AgentState は字幕より先に届く。本物の声の頭へローカル音声をかぶせない。
        unawaited(_lessonOpeningAudio?.senpaiStartedSpeaking() ?? Future<void>.value());
        state = state.copyWith(phase: _speakingPhase);
      case AgentState.listening:
      case AgentState.thinking:
        // 喋り終わったら、こちらの番に戻す。**授業中は「教え返し」になる** —
        // 板書はそのまま残し、下に「説明してみて」を出すのはこの遷移。
        if (state.phase == SessionPhase.connecting ||
            state.phase == SessionPhase.senpaiSpeaking ||
            state.phase == SessionPhase.senpaiTeaching) {
          state = state.copyWith(phase: _listeningPhase);
        }
      case AgentState.idle:
      case AgentState.initializing:
      case null:
        break;
    }
  }

  void _onTranscript(ReceivedMessage message) {
    switch (message.content) {
      case AgentTranscript(:final String text):
        if (text.trim().isEmpty) return;
        onSenpaiSpeaking(text);
      case UserTranscript():
        // 自分の声が届いている印。字幕は先輩の発話だけ残す。
        onUserTurn();
      default:
        break;
    }
  }

  /// 板書の封筒が1通届いた(Text Streams。topic は `boardChannelTopic`)。
  ///
  /// **1封筒 = 1ストリーム**(計画書§3-5)なので、`readAll()` が返った時点で
  /// 封筒は完成している。部分JSONを自前で組み立てる必要はない。
  /// 読み出しは [_boardQueue] に積んで到着順に直列化する(理由は同フィールド)。
  void _onBoardStream(TextStreamReader reader, String participantIdentity) {
    _boardQueue = _boardQueue.then((_) => _readBoardEnvelope(reader));
  }

  Future<void> _readBoardEnvelope(TextStreamReader reader) async {
    final BoardInbox? inbox = _boardInbox;
    if (inbox == null) return;

    final String payload;
    try {
      payload = await reader.readAll().timeout(_boardStreamTimeout);
    } catch (error) {
      // 読み切れなかった封筒は諦める。**握りつぶしてはいない** —
      // 次の封筒で `seq` がずれるので、板書は「とぎれた」として画面に出る。
      debugPrint('板書の封筒を読めませんでした(この1通は諦めます): $error');
      return;
    }

    // 読んでいるあいだに畳まれた・つなぎ直された。**同じ部屋の封筒ではない**ので、
    // 新しい板書に混ぜない(`retry()` は同じ session_id で入り直すため、
    // 封筒の宛先チェックでは弾けない)。
    if (!identical(_boardInbox, inbox)) return;

    if (!inbox.acceptPayload(payload)) return;
    // 読んでいるあいだに画面を離れられた。書き戻す先がもう無い。
    if (!ref.mounted) return;
    _applyBoard(inbox.snapshot);
  }

  /// 板書が動いたので画面に反映する。
  ///
  /// **フェーズも一緒に動かす。**板書が届いた = 先輩が書いている最中なので、
  /// 授業モードに入っていないなら、ここで入る(会話が締めに入っていれば触らない)。
  ///
  /// ## 授業の外から板書を読むときの約束(カルテの「先輩が書いたもの」)
  ///
  /// この会話画面はAutoDisposeなので、離れた瞬間に [SessionState.board] ごと消える。
  /// 授業の寿命を超えて残すぶんは `lastBoardControllerProvider`
  /// (`features/karte/application/last_board_controller.dart`)に書き出す。
  /// **書き込むのはここだけ。**読む側([LastBoardController] を watch する側)への約束:
  ///
  ///   - 型は `List<BoardStep>`。**板書が1枚も無ければ空リスト**(nullにはならない)
  ///   - 中身は「いま黒板に書いてあるもの」全部。積み足しではなく**丸ごと置き換え**
  ///   - `board_open`(= 別の問題に移る)で丸ごと入れ替わる。それが板書の寿命の全部で、
  ///     `board_close` では消えない(§3-2。1つの板書は1つの問題ぶん生き続ける)
  ///   - 音声だけの手順(`step.board == null`)も列には含まれる。描画側で落とすこと
  ///     ([BoardView] がやっている)
  ///   - **とぎれた板書も渡る**(欠落を検知した時点までの行は残す方針)。健全な板書と
  ///     区別できるよう、`truncated` に [BoardSnapshot.hasGap] を添えて渡している
  void _applyBoard(BoardSnapshot board) {
    // `board_open` は見出しだけなので止めない。最初の BoardStep が届くまでの無音を
    // 埋めるのが cue の仕事で、見出し到着で切るとその穴がそのまま残る。
    if (board.steps.isNotEmpty) {
      unawaited(_lessonOpeningAudio?.firstBoardStepArrived() ?? Future<void>.value());
    }
    state = state.copyWith(
      board: board,
      awaitingSolving: board.awaitsSolving,
      phase: _isTalking(state.phase) ? SessionPhase.senpaiTeaching : state.phase,
    );

    // **`board_close` のときだけではなく、変わるたびに渡す。** 締めが来るのは
    // 問題が終わったときだけなので、途中で会話を終えた板書はそれでは届かない。
    // `truncated` を渡さないと、とぎれた板書が健全な板書としてカルテに残る。
    ref.read(lastBoardControllerProvider.notifier).set(
          board.steps,
          truncated: board.hasGap,
        );
  }

  /// 会話がまだ続いているフェーズか。
  ///
  /// `switch` で書いてあるのは、フェーズを増やしたときに
  /// **「これは会話中か」を必ず決めさせる**ため(既定値で素通りさせない)。
  static bool _isTalking(SessionPhase phase) => switch (phase) {
    SessionPhase.connecting ||
    SessionPhase.listening ||
    SessionPhase.senpaiSpeaking ||
    SessionPhase.senpaiTeaching ||
    SessionPhase.explainBack => true,
    SessionPhase.summarizing || SessionPhase.finished || SessionPhase.failed => false,
  };

  /// 相手が喋っているときのフェーズ。板書が出ていれば「先輩の説明」。
  SessionPhase get _speakingPhase =>
      state.board.hasBoard ? SessionPhase.senpaiTeaching : SessionPhase.senpaiSpeaking;

  /// こちらが喋る番のフェーズ。板書が出ていれば「教え返し」。
  SessionPhase get _listeningPhase =>
      state.board.hasBoard ? SessionPhase.explainBack : SessionPhase.listening;

  void onSenpaiSpeaking(String text) {
    // AgentState を取りこぼした場合も、字幕を受けた時点で止める二本目の経路。
    unawaited(_lessonOpeningAudio?.senpaiStartedSpeaking() ?? Future<void>.value());
    state = state.copyWith(phase: _speakingPhase, lastSenpaiText: text);
  }

  void onUserTurn() {
    if (!_isTalking(state.phase)) return;
    // 声で「できた」「わかんない」と答えた経路でも、ボタンを二重に残さない。
    state = state.copyWith(phase: _listeningPhase, awaitingSolving: false);
  }

  /// 類題の「できた / できなかった」。音声と同じ `lk.chat` へ流す。
  ///
  /// 制御チャネルにすると transcript に残らず、声の言い換えと分岐が二本になる。
  /// これは本人の発話そのものなので、既存の [pass] と同じ入口を使う。
  Future<void> reportSolving(String message) async {
    // 連打で同じ本人申告を二重に transcript へ載せない。
    if (!state.awaitingSolving) return;
    onUserTurn();
    try {
      await _room?.localParticipant?.sendText(
        message,
        options: SendTextOptions(topic: 'lk.chat'),
      );
    } catch (error) {
      // 声でも申告できるので、送信失敗で会話画面自体は止めない。
      //
      // ただし**黙って落とさない。** 解答待ちの先輩は15秒判定を外して
      // 残り時間まで待つので、届かないと会話が何分も止まったままになる。
      // 押した本人には「ボタンが効かない」としか見えない静かな壊れ方なので、
      // 事実だけ(文言は渡さない)を残して原因を追えるようにする。
      Telemetry.report(
        DegradationEvent.solvingReportNotSent(
          sessionId: _sessionId,
          phase: state.phase.name,
          error: error.runtimeType,
        ),
      );
    }
  }

  /// 「うまく言えない」。
  ///
  /// パスは恥ではなく穴の記録なので、**先輩にも伝える**。伝えないと、
  /// こちらの画面だけが切り替わって、先輩は同じ問いかけを待ち続ける。
  Future<void> pass(String message) async {
    onUserTurn();
    try {
      await _room?.localParticipant?.sendText(
        message,
        options: SendTextOptions(topic: 'lk.chat'),
      );
    } catch (error) {
      // 伝わらなくても会話は続けられる。ここで画面を止めない。
      //
      // ただし**黙って終わらせない。** 約束3(パスを恥にしない)は
      // パスが**残る**ことで成立していて、送れないと穴として価値化されない。
      // その生徒にとっては「言えなかったのに、何も起きなかった」だけになり、
      // しかも画面は何事もなく進むので、本人にもこちらにも見えない
      // (計画書 §10-7)。
      //
      // **`message` は送らない。** パスの文言は生徒に向けた発話で、
      // 監視に流してよいものではない。失敗した事実と session_id で足りる。
      Telemetry.report(
        DegradationEvent.passNotSent(
          sessionId: _sessionId,
          phase: state.phase.name,
          // 型だけ渡す。生成子が `Type` しか受け取らないので、
          // 例外の `toString()`(接続先URLを含みうる)は渡しようがない。
          error: error.runtimeType,
        ),
      );
    }
  }

  /// 会話を終える。
  ///
  /// カルテはエージェントが作ってサーバへ送るので、アプリは
  /// `/v1/sessions/{id}/result` を見に行って結果を受け取る。
  /// ここで受け取らないと、祝福もカルテも空のまま表示されてしまう。
  Future<void> finish() async {
    if (_finishing) return;
    _finishing = true;

    // 会話はもう終わっている。片付け(数秒かかる)のあいだも数字が減り続けると、
    // 終わったはずの会話がまだ動いているように見える。
    _ticker?.cancel();
    _ticker = null;

    final bool talked = _senpaiIdentity != null;

    // **画面を先に動かす。** 片付け(切断の完了待ち)には数秒かかるので、
    // ここを `_teardown()` の後ろに置くと、「今日はここまで」を押してから
    // 数秒間、画面が押す前とまったく同じまま止まる。反応が無いので連打される。
    if (talked) {
      state = state.copyWith(
        phase: SessionPhase.summarizing,
        awaitingSolving: false,
      );
    } else {
      // 先輩が来ていないので、カルテは作られない。待たせずに理由を出す。
      state = state.copyWith(
        phase: SessionPhase.failed,
        awaitingSolving: false,
        failure: SessionFailure.senpaiUnavailable,
      );
    }

    await _teardown();

    final String? sessionId = _sessionId;
    if (!talked) return;

    if (sessionId == null) {
      _publish(SessionOutcome(resultMissing: true, kind: _sessionKind));
      state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
      return;
    }

    try {
      final SessionResult? result = await ref.read(apiClientProvider).awaitSessionResult(
            sessionId,
            interval: _kartePollInterval,
            attempts: _karteGrace.inSeconds ~/ _kartePollInterval.inSeconds,
          );
      // 待っているあいだに画面を離れられた。書き戻す先がもう無い。
      if (!ref.mounted) return;

      if (result == null) {
        // 生成が間に合わなかった。祝福は見せて、カルテは祝福画面が取りに行く。
        _publish(
          SessionOutcome(resultMissing: true, sessionId: sessionId, kind: _sessionKind),
        );
        state = state.copyWith(phase: SessionPhase.finished, resultMissing: true);
        return;
      }

      ref.read(latestKarteControllerProvider.notifier).set(result.karte);
      ref.read(progressControllerProvider.notifier).applyFromSession(result.progress);
      // 復習キューはkeepAlive。前回のopen状態から候補を選ばないよう、
      // 次にカルテ/復習画面が読むときは完了後の状態を取り直させる。
      ref.invalidate(reviewControllerProvider);
      _publish(
        SessionOutcome(
          showPaywall: result.showPaywall,
          sessionId: sessionId,
          kind: _sessionKind,
        ),
      );
      state = state.copyWith(
        phase: SessionPhase.finished,
        showPaywall: result.showPaywall,
      );
    } catch (error) {
      if (!ref.mounted) return;
      _publish(
        SessionOutcome(resultMissing: true, sessionId: sessionId, kind: _sessionKind),
      );
      state = state.copyWith(
        phase: SessionPhase.finished,
        resultMissing: true,
        error: error,
      );
    }
  }

  /// 会話画面(AutoDispose)の寿命を超えて持ち回る結果を置く。
  void _publish(SessionOutcome outcome) {
    ref.read(sessionOutcomeControllerProvider.notifier).set(outcome);
  }

  /// 後片付けは**絶対に投げない**。
  ///
  /// `_teardown()` は失敗処理の途中(`connect` の catch)からも呼ばれる。
  /// ここで例外が飛ぶと、失敗を画面に出す前に `connect` を抜けてしまい、
  /// 「聞いています」のまま止まる。片付けの失敗で会話の結末を潰さない。
  Future<void> _teardown() async {
    _ticker?.cancel();
    _ticker = null;
    _senpaiWatchdog?.cancel();
    _senpaiWatchdog = null;

    final Room? room = _room;
    // 先に参照を捨てる。片付けの途中で来たイベントに、
    // 畳んでいる最中の部屋を触らせない。
    _room = null;

    // 板書も同じ理由で先に外す。読み出しの途中で来た封筒を、
    // もう画面の無いところへ流し込ませない。
    _boardInbox = null;
    await _quietly(
      '板書の購読解除',
      () => room?.unregisterTextStreamHandler(boardChannelTopic),
    );

    final LessonOpeningAudio? openingAudio = _lessonOpeningAudio;
    _lessonOpeningAudio = null;
    await _quietly('授業冒頭のローカル音声停止', () => openingAudio?.stop());

    // 先に購読を切る。切断そのものがイベントになって戻ってくるのを避ける。
    await _quietly('字幕の購読解除', () => _transcriptSubscription?.cancel());
    _transcriptSubscription = null;
    await _quietly('字幕の破棄', () => _transcripts?.dispose());
    _transcripts = null;
    await _quietly('イベント購読の破棄', () => _events?.dispose());
    _events = null;

    // 接続に失敗した部屋は切断の完了イベントを返さないことがあり、
    // SDK側は10秒待ってから TimeoutException を投げる。待たずに畳む。
    await _quietly(
      'ルームの切断',
      () => room?.disconnect().timeout(_disconnectTimeout),
    );
    // 切断が間に合わなくても dispose は必ず通す(SDKの後始末はこちらに入る)。
    await _quietly('ルームの破棄', () => room?.dispose());
  }

  /// 片付けの一手。失敗しても次の一手に進む。
  Future<void> _quietly(String what, FutureOr<void> Function() step) async {
    try {
      await step();
    } catch (error) {
      debugPrint('$what に失敗しました(片付けは続けます): $error');
    }
  }
}
