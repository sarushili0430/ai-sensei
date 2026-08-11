import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../session/presentation/board/board_view.dart';
import '../application/last_board_controller.dart';
import '../domain/last_board.dart';
import '../domain/senpai_nudge.dart';

/// 自習室(計画書§4-2)。
///
/// **マイクを開かない。STTもTTSもLLMもLiveKitも動かさず、滞在中は通信しない。**
/// 退室または非表示になった瞬間だけ、滞在秒数とローカル日付を1回送る。
/// 板書・単元・発話は送らず、失敗は黙って捨てる。したがって増えるのは
/// **滞在時間に比例しない1回の小さなD1書き込み**だけで、計画書§6-1の
/// 従量原価(STT / TTS / LLM / LiveKit)は1つも起動しない。
/// §6-3の「原価が発生する生成・音声だけが有料」という一行はこのまま保てる。
///
/// 置いているのは3つ。§4-2 の「画面に先輩がいる。さっきの板書が残っている。
/// タイマーが回っている」をそのまま画面にしたもの:
///   - さっきの板書(主役。画面の上半分を明け渡す)
///   - 先輩と、たまの声かけ(経過時間から引く。録音でも通信でもない)
///   - 「先輩、ちょっといい?」= **課金の切れ目**。押すと授業モードが立ち上がる
///
/// 授業モードと違って、ここは**戻れる**画面にしてある(ルータで `/` の子)。
/// 詰まって先輩を呼びかけてやめた人が、自習室ごと失わないようにするため。
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
  late final DateTime _startedAt;
  late final String _visitId;

  Timer? _ticker;
  bool _configured = false;
  bool _reported = false;

  @override
  void initState() {
    super.initState();
    _now = ref.read(studyRoomClockProvider);
    _startedAt = _now();
    _visitId = const Uuid().v4();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_configured) return;
    _configured = true;

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
    if (AppMotion.isReduced(context)) return;
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // inactiveは通知センター等で一時的にフォーカスを失っただけでも来る。
    // 本当に見えなくなったhidden / pausedだけを退室として扱い、短い中断で
    // 自習を勝手に終わらせない。
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      _reportOnce();
    }
  }

  @override
  void dispose() {
    // 親ごと差し替えられた経路など、戻る通知を受けない破棄の最後の保険。
    // 他の経路が先に送っていても_reportedが二重送信を止める。
    _reportOnce();
    WidgetsBinding.instance.removeObserver(this);
    _ticker?.cancel();
    super.dispose();
  }

  Duration _elapsed() {
    final Duration elapsed = _now().difference(_startedAt);
    // 滞在中に端末時計が巻き戻った値は送らない。サーバ側にも同じく
    // 正数・上端の検査を置き、クライアントだけを信用しない。
    return elapsed.isNegative ? Duration.zero : elapsed;
  }

  void _reportOnce() {
    if (_reported) return;

    final int durationSeconds = _elapsed().inSeconds;
    // 1秒未満の画面遷移は滞在として意味がなく、0は共有契約でも無効。
    // まだ送っていないので_reportedは立てない。入室直後にOSダイアログ等で
    // 一度だけ非表示になって戻った場合、その後の本当の滞在まで捨てないため。
    if (durationSeconds < 1) return;
    _reported = true;
    unawaited(_sendVisit(durationSeconds));
  }

  Future<void> _sendVisit(int durationSeconds) async {
    try {
      await ref
          .read(apiClientProvider)
          .recordStudyRoomVisit(
            durationSeconds: durationSeconds,
            startedAt: _startedAt,
            idempotencyKey: _visitId,
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
                _SenpaiRow(nudge: SenpaiNudge.forElapsed(elapsed)),
                const SizedBox(height: AppSpacing.md),
                ChunkyButton(
                  label: strings.studyRoomAsk,
                  // **ここが課金の切れ目**(§4-2)。撮影が上に載ると自習室は
                  // 非表示になるので、その直前を退室として1回だけ記録する。
                  onPressed: () {
                    _reportOnce();
                    context.push(AppRoute.capture.path);
                  },
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
/// TODO(§4-2): 計画書が求めているのは「事前生成した音声アセットの再生
/// (TTS呼び出しゼロ)」。アセットがまだ無いので、この段では吹き出しだけにしてある。
/// アセットが用意できたら、[SenpaiNudge] が切り替わった瞬間に対応する音声を鳴らす
/// (鳴らすのは再生だけなので、原価ゼロは崩れない)。
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
