import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../../api/api_client.dart';
import '../../../audio/prerendered_audio.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../session/presentation/board/board_view.dart';
import '../application/last_board_controller.dart';
import '../application/senpai_nudge_audio.dart';
import '../domain/last_board.dart';
import '../domain/senpai_nudge.dart';

/// 自習室(計画書§4-2)。
///
/// **マイクを開かない。STTもTTSもLLMもLiveKitも動かさず、滞在中はサーバ通信しない。**
///
/// この画面が外に触るのは2つだけで、**どちらも滞在時間に比例しない**:
///   - **同梱したプリレンダ音声の再生**(§4-2の声かけ)。端末内で鳴らすだけで、
///     録音も送信も生成もしない。何回鳴っても従量原価は1円も増えない
///   - **退室・非表示のときに1回だけ送る、滞在秒数とローカル日付**
///     (§4-2の「滞在時間を原価ゼロで積める」= OneSignal賞の材料)。
///     板書・単元・発話は送らず、失敗は黙って捨てる。増えるのは小さなD1書き込み1回だけ
///
/// つまり計画書§6-1の従量原価(STT / TTS / LLM / LiveKit)は1つも起動しないので、
/// §6-3の「原価が発生する生成・音声だけが有料」という一行はこのまま保てる。
/// 裏を返せば、ここに**「録る・生成する」を1つでも足したら、無料である説明が崩れる**。
///
/// 置いているのは3つ。§4-2 の「画面に先輩がいる。さっきの板書が残っている。
/// タイマーが回っている」をそのまま画面にしたもの:
///   - さっきの板書(主役。画面の上半分を明け渡す)
///   - 先輩と、たまの声かけ(経過時間から引く。録音でも通信でもない)
///   - 「先輩、ちょっといい?」= **課金の切れ目**。押すと授業モードが立ち上がる
///
/// 授業モードと違って、ここは**戻れる**画面にしてある。ピボット前は `/` の子に
/// 積んでいたが、いまは常設タブの独立した枝。それでも撮影だけは `push` し、
/// 詰まって先輩を呼びかけてやめた人が、自習室ごと失わない約束は変えていない。
/// 枝はタブを離れても破棄されないため、Stateの生成から破棄までを1訪問とみなさず、
/// **最前面に見えている区間ごと**に開始時刻と冪等キーを作り直す。
class StudyRoomScreen extends ConsumerStatefulWidget {
  const StudyRoomScreen({super.key});

  @override
  ConsumerState<StudyRoomScreen> createState() => _StudyRoomScreenState();
}

class _StudyRoomScreenState extends ConsumerState<StudyRoomScreen>
    with WidgetsBindingObserver {
  /// 自習を始めた時刻。
  ///
  /// **経過秒を1ずつ足し込まない。** 足し込む持ち方にすると、塗り直しを
  /// 止めた瞬間に時間そのものが止まる(下の [didChangeDependencies] 参照)。
  /// 始めた時刻さえ持っていれば、経過時間はいつでもその場で計算できる。
  late final DateTime Function() _now;
  late DateTime _startedAt;
  late String _visitId;

  Timer? _ticker;
  bool _configured = false;
  bool _reported = false;
  bool _routeVisible = true;
  bool _appVisible = true;
  bool _coveredByPush = false;
  bool _foreground = true;
  SenpaiNudgeAudio? _nudgeAudio;

  @override
  void initState() {
    super.initState();
    _now = ref.read(studyRoomClockProvider);
    _beginVisit();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_configured) {
      _configured = true;
      _nudgeAudio = SenpaiNudgeAudio(ref.read(prerenderedAudioProvider));
    }

    // StatefulShellRouteの各枝では、自習室のModalRouteはタブを離れても
    // その枝の中ではcurrentのまま。`ModalRoute.isCurrent`だけを見ると、ホームを
    // 見ている間も滞在が続いてしまう。indexedStackが非選択の枝へ付ける
    // TickerModeを、タブ上で実際に見えているかの通知として使う。
    final bool routeVisible = TickerMode.valuesOf(context).enabled;
    if (_routeVisible != routeVisible) {
      _routeVisible = routeVisible;
      // 依存変更の直後には必ずbuildが続く。ここでsetStateまで呼ぶと同じフレームを
      // 二重に予約するので、状態の区切りだけを先に反映する。
      _syncForeground(rebuild: false);
    }

    _startTickerIfNeeded();
  }

  void _startTickerIfNeeded() {
    if (!_foreground || _ticker != null || AppMotion.isReduced(context)) return;

    // 1秒ごとに塗り直す。**「動かさない」設定では回さない**(ADR 0004 の経路)。
    //
    // 再描画を止めるのは乱暴に見えるが、画面上の経過時間は「先輩がいて、板書が
    // 残っていて、タイマーが回っている」という場をつくる**装飾**であって、
    // 累計を知らせる装置ではない(自習室に達成の目盛りは持ち込まない)。
    // だから `AppMotion` の作法どおり、止めるときは途中で凍らせるのではなく
    // **終わった状態**を描く — `_startedAt` からその場で計算するので、
    // 勝手には進まないが、画面が塗り直されるたびに正しい時刻になる。
    // 退室時の計測も同じ `_startedAt` と壁時計の差をその場で取るので、tickerを
    // 回さないreduce motion経路でも時間は失われない。tickerのtick数は指標に使わない。
    //
    // ここを通し忘れると、widget test の `pumpAndSettle` が返らなくなる
    // (1秒ごとにフレームを積み続けるループになるため)。
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || !_foreground) return;

      final Duration elapsed = _elapsed();
      final SenpaiNudge next = SenpaiNudge.forElapsed(elapsed);
      final SenpaiNudgeAudio? nudgeAudio = _nudgeAudio;
      if (nudgeAudio != null && next != nudgeAudio.current) {
        unawaited(
          nudgeAudio.moveTo(
            next,
            languageCode: Localizations.localeOf(context).languageCode,
          ),
        );
      }
      setState(() {});
    });
  }

  void _beginVisit() {
    _startedAt = _now();
    _visitId = const Uuid().v4();
    _reported = false;
  }

  void _syncForeground({required bool rebuild}) {
    final bool foreground = _routeVisible && _appVisible && !_coveredByPush;
    if (_foreground == foreground) return;
    _foreground = foreground;

    if (!foreground) {
      // 見えない時間を表示にも送信にも混ぜない。Timerを止めるだけでは
      // `_startedAt` との差が伸び続けるため、ここで今の訪問を閉じる。
      _ticker?.cancel();
      _ticker = null;
      _reportOnce();
      unawaited(_nudgeAudio?.stop() ?? Future<void>.value());
      return;
    }

    // 同じStateへ戻ってきても新しい訪問。IDを使い回すと、2回目のPOSTは
    // サーバの冪等キーに同じ訪問と判定され、正しく分けた滞在まで捨てられる。
    _beginVisit();
    final SenpaiNudgeAudio? nudgeAudio = _nudgeAudio;
    if (nudgeAudio != null) {
      unawaited(
        nudgeAudio.moveTo(
          SenpaiNudge.start,
          languageCode: Localizations.localeOf(context).languageCode,
          audible: false,
        ),
      );
    }
    _startTickerIfNeeded();
    if (rebuild && mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // inactiveは通知センター等で一時的にフォーカスを失っただけでも来る。
    // 本当に見えなくなったhidden / pausedだけを退室として扱い、短い中断で
    // 自習を勝手に終わらせない。
    if (state == AppLifecycleState.hidden || state == AppLifecycleState.paused) {
      if (!_appVisible) return;
      _appVisible = false;
      _syncForeground(rebuild: true);
      return;
    }
    if (state == AppLifecycleState.resumed && !_appVisible) {
      _appVisible = true;
      _syncForeground(rebuild: true);
    }
  }

  @override
  void dispose() {
    // 親ごと差し替えられた経路など、戻る通知を受けない破棄の最後の保険。
    // 他の経路が先に送っていても_reportedが二重送信を止める。
    _reportOnce();
    WidgetsBinding.instance.removeObserver(this);
    _ticker?.cancel();
    unawaited(_nudgeAudio?.stop() ?? Future<void>.value());
    super.dispose();
  }

  Duration _elapsed() {
    final Duration elapsed = _now().difference(_startedAt);
    // 滞在中に端末時計が巻き戻った値は送らない。サーバ側にも同じく
    // 正数・上端の検査を置き、クライアントだけを信用しない。
    return elapsed.isNegative ? Duration.zero : elapsed;
  }

  Future<void> _openCapture() async {
    if (_coveredByPush) return;
    _coveredByPush = true;
    _syncForeground(rebuild: true);

    try {
      await context.push<void>(AppRoute.capture.path);
    } finally {
      if (mounted) {
        _coveredByPush = false;
        // 撮影をやめて戻った場合だけ、新しい訪問をここから始める。撮影から授業へ
        // `go` した場合は自習室ごと破棄されるので、古い会話へ戻る入口は作らない。
        _syncForeground(rebuild: true);
      }
    }
  }

  void _reportOnce() {
    if (_reported) return;
    // 1秒未満で送らない訪問も、ここで閉じたこと自体は覚える。閉じずに残すと、
    // タブの裏にいた時間をdispose時の差分へ混ぜてしまう。再び最前面になれば
    // `_beginVisit` がfalseへ戻すため、その後の有効な滞在は失われない。
    _reported = true;

    final int durationSeconds = _elapsed().inSeconds;
    // 1秒未満の画面遷移は滞在として意味がなく、0は共有契約でも無効。
    // 送信は捨てるが、戻ったときは新しい訪問として0から測り直す。
    if (durationSeconds < 1) return;
    // POSTを待つ間にタブへ戻ると、次の訪問が同じState上で始まる。フィールドを
    // Futureの中から読むと、新しい開始時刻・IDで古い秒数を送る競合になるため、
    // 閉じた訪問の値をここで写し取る。
    final DateTime startedAt = _startedAt;
    final String visitId = _visitId;
    unawaited(
      _sendVisit(
        durationSeconds,
        startedAt: startedAt,
        visitId: visitId,
      ),
    );
  }

  Future<void> _sendVisit(
    int durationSeconds, {
    required DateTime startedAt,
    required String visitId,
  }) async {
    try {
      await ref
          .read(apiClientProvider)
          .recordStudyRoomVisit(
            durationSeconds: durationSeconds,
            startedAt: startedAt,
            idempotencyKey: visitId,
          );
    } catch (_) {
      // 計測の再試行・エラー表示はしない。自習を終える操作を指標のために
      // 止めるほうが、欠けた1件より大きく体験を壊すため、ここで捨てる。
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    // 滞在中に読むのは手元のメモリだけ。**LiveKitにつなぎ直したりAPIを叩いたりしない**。
    // APIを呼ぶ唯一の場所は、非表示時に通る_reportOnceの先に閉じてある。
    final LastBoard board = ref.watch(lastBoardControllerProvider);
    final Duration elapsed = _elapsed();
    final SenpaiNudge nudge = SenpaiNudge.forElapsed(elapsed);

    return PopScope<Object?>(
      // システムの戻る・スワイプバックはボタンのcallbackを通らない。
      // pop成立後の通知とdisposeの両方を受けても_reportOnceで1件に畳む。
      onPopInvokedWithResult: (bool didPop, Object? _) {
        if (didPop) _reportOnce();
      },
      child: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _TopRow(
                  elapsed: elapsed,
                  onLeave: () {
                    _reportOnce();
                    context.closeOrGoHome();
                  },
                ),
                const SizedBox(height: AppSpacing.md),
                // 板書に画面を明け渡す。先輩と操作は下に寄せる。
                Expanded(child: _Board(board: board)),
                const SizedBox(height: AppSpacing.md),
                _SenpaiRow(nudge: nudge),
                const SizedBox(height: AppSpacing.md),
                ChunkyButton(
                  label: strings.studyRoomAsk,
                  // **ここが課金の切れ目**(§4-2)。撮影が上に載ると自習室は
                  // 非表示になるので、その直前を退室として1回だけ記録する。
                  // pushの完了も同じ前面管理へ戻すので、撮影をやめたあとは開始時刻と
                  // 冪等キーを新しくした別訪問として、また正しく数えられる。
                  onPressed: _openCapture,
                ),
                const SizedBox(height: AppSpacing.sm),
                // マイクを開いていないことを、黙っていないで書く。
                // 「先輩が隣にいる画面」は、聞かれていると誤解されうる形をしている。
                Text(
                  strings.studyRoomMicOff,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 経過時間と、出口。
class _TopRow extends StatelessWidget {
  const _TopRow({required this.elapsed, required this.onLeave});

  final Duration elapsed;
  final VoidCallback onLeave;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Row(
      children: <Widget>[
        Semantics(
          // 秒まで読み上げても意味がないので、読み上げは分だけにする。
          label: strings.studyRoomElapsedLabel(elapsed.inMinutes),
          child: ExcludeSemantics(
            child: Text(
              strings.studyRoomElapsed(elapsed.inSeconds),
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                color: AppColors.inkMuted,
                // 桁ごとに幅が変わると、1秒ごとに数字が左右に揺れる。
                fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
        const Spacer(),
        TextButton(
          onPressed: onLeave,
          style: TextButton.styleFrom(
            foregroundColor: AppColors.inkMuted,
            visualDensity: VisualDensity.compact,
          ),
          child: Text(
            strings.studyRoomLeave,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    );
  }
}

/// 表示タイマーと退室時の計測が同じ時計を見るための差し替え口。
///
/// widget testの`pump(Duration)`はTimerを進めても壁時計を進めない環境がある。
/// 実時間のsleepに頼るテストは遅く不安定になるので、時計だけをRiverpodで差し替える。
final Provider<DateTime Function()> studyRoomClockProvider =
    Provider<DateTime Function()>((Ref _) => DateTime.now);

/// さっきの板書。**この画面の主役**(§4-2)。
///
/// 描くのは授業モードと同じ [BoardView]。同じ板書が、教わっているときと
/// 自習しているときで別物に見えてはいけないので、専用の描画は作らない。
///
/// **カードに入れない(囲わない・内側に余白を足さない)。** 見た目の好みではなく、
/// 計画書§3-6b の実測の前提そのものだから:
///
///   - `BoardStyle.latexMinScale`(70%)は**実効幅340pt**での実測から決めた値。
///     この画面の左右の余白は `AppSpacing.lg` × 2 = 48pt なので実効345ptで、
///     授業モード(`_BoardStage`)と同じ。ここに `padding: md` と `border` の
///     カードを足すと 345 − 32 − 2 = **311pt** まで落ち、実測で「縮小して収まる」
///     と確認した式(3次因数分解・自然幅449.6pt)が縮小率0.69で下限を割って
///     **横スクロールに落ちる**。しかも落ちたことは `debugPrint` にしか出ない
///   - `latex_element_view.dart` の右端フェードは、板書が
///     `AppColors.background`(Scaffoldの地)に直接乗る前提の色で描かれている。
///     白いカードの上に置くと地に溶けず、「まだ続きがある」の手がかりとして
///     機能しなくなる(= 案Bを不採用にした理由がそのまま復活する)
///
/// 「ここが板書だ」は、囲いではなく見出し([AppStrings.studyRoomBoardTitle])が示す。
/// 授業モードが `_SessionHeader` の見出しでそうしているのと同じ形。
class _Board extends StatelessWidget {
  const _Board({required this.board});

  final LastBoard board;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // 板書が無くても自習室は成立する(先輩とタイマーは残る)。
    // ただし空白で放置はしない。どうすればここが埋まるのかを書く。
    if (board.isEmpty) {
      return Center(
        child: Text(
          strings.studyRoomBoardEmpty,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      );
    }

    return Column(
      // **`start` にしない。** `start` だと子が自分の自然な幅になり、板書が
      // いちばん長い行の幅まで痩せる(実測で198pt = 実効幅の前提345ptの半分強)。
      // 幅が痩せた分だけ縮小率が下がるので、横スクロールに落ちる式が増える。
      // 授業モードの `_BoardStage` も同じ理由で `stretch`。
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(strings.studyRoomBoardTitle, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.sm),
        // 手順が増えると縦に伸びる。上から読むものなので中央寄せにはしない。
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                BoardView(steps: board.steps),
                // とぎれた印は、**板書の最後の行の下**に置く。
                // 見出しの横や画面の隅ではなく、読み進めた人が
                // 「続きがない」ことに気づく場所に置きたい([LastBoard.truncated])。
                if (board.showsTruncation) ...<Widget>[
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    strings.studyRoomBoardTruncated,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 先輩と、その声かけ。
///
/// **マイクは開いていない。** ここに出ているのは録音でも生成でもなく、
/// 経過時間から引いた定型のせりふ([SenpaiNudge])。
///
/// [SenpaiNudge] が切り替わった瞬間だけ、対応する同梱アセットも1回鳴らす。
/// 吹き出しは消さない。消音モード・音声オフ・アセット欠落のどれでも、文字だけで
/// 同じ声かけが成立しなければ、装飾だった音が導線へ昇格してしまうため。
class _SenpaiRow extends StatelessWidget {
  const _SenpaiRow({required this.nudge});

  final SenpaiNudge nudge;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String line = switch (nudge) {
      SenpaiNudge.start => strings.studyRoomNudgeStart,
      SenpaiNudge.going => strings.studyRoomNudgeGoing,
      SenpaiNudge.takeABreak => strings.studyRoomNudgeBreak,
      SenpaiNudge.longHaul => strings.studyRoomNudgeLong,
    };

    return Row(
      children: <Widget>[
        // ここだけ顔の既定のラベル(「先輩が待っています」)を上書きする。
        // 自習室で価値になっているのは待っていることではなく**となりにいること**
        // (§4-2「画面に先輩がいる」)で、待機と読まれると
        // 「何かを待たされている画面」に聞こえてしまう。
        Semantics(
          label: strings.studyRoomSenpaiHere,
          child: const ExcludeSemantics(
            child: SenpaiFace(mood: SenpaiMood.neutral, size: 64),
          ),
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          // せりふが切り替わった瞬間だけ打ち直す。key を持たせないと、
          // 1秒ごとの塗り直しでは同じ State が使い回されて、
          // 声をかけられたことに気づけない。
          child: _Bubble(key: ValueKey<SenpaiNudge>(nudge), text: line),
        ),
      ],
    );
  }
}

/// 先輩の吹き出し。
class _Bubble extends StatelessWidget {
  const _Bubble({required this.text, super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: AppColors.blue.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      // 一気に出すと「表示された文章」に見えるが、打たれていくと
      // **いま声をかけられた**ように見える(会話画面と同じ扱い)。
      child: TypingText(text, style: Theme.of(context).textTheme.bodyMedium),
    );
  }
}
