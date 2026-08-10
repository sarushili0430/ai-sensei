import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../application/board_inbox.dart';
import '../application/session_controller.dart';
import '../domain/session.dart';
import 'board/board_view.dart';

/// 会話画面(ワイヤーフレームの03/04を1枚に統合)。
///
/// **にぎやかな画面**にする(handoff §7)。ただし試験官UIにはしない。
///
/// 画面には2つの姿がある。分かれ目は**板書が届いているか**だけ:
///
///   - **板書なし**(既存の復習の会話)= 主役は先輩の表情。テキストは字幕として控えめに。
///   - **板書あり**(授業モード・計画書§4-1)= **主役は板書**。顔と字幕は下の帯に小さく置く。
///     教え返し(`explainBack`)でも**板書は残したまま**、下に「説明してみて」を出す。
///
/// 板書は1行ずつ積まれ、**前の行は消えない**(§3-2)。消えるのは別の問題に
/// 移るとき(`board_open`)だけで、その判断は受信側([BoardInbox])が持っている。
class SessionScreen extends ConsumerStatefulWidget {
  const SessionScreen({super.key});

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final SessionStart? session = ref.read(captureControllerProvider).session;
      if (session == null) {
        context.go(AppRoute.home.path);
        return;
      }
      ref.read(sessionControllerProvider.notifier).connect(session);
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final SessionState state = ref.watch(sessionControllerProvider);

    ref.listen<SessionState>(sessionControllerProvider, (SessionState? previous, SessionState next) {
      if (next.phase == SessionPhase.finished) {
        context.go(AppRoute.celebration.path);
      }
    });

    // 会話が始まらなかったときは、顔と字幕のまま黙らない。
    // 何が起きたのかと、次にできることを出す。
    if (state.phase == SessionPhase.failed) {
      return _SessionFailed(failure: state.failure);
    }

    final String subtitle = switch (state.phase) {
      SessionPhase.connecting => strings.sessionConnecting,
      SessionPhase.summarizing || SessionPhase.finished => strings.sessionSummarizing,
      // 授業中の字幕は先輩の発話。まだ何も喋っていないうちは、
      // 「聞いています」ではなく**いま何が起きているか**を出す。
      SessionPhase.senpaiTeaching => state.lastSenpaiText ?? strings.sessionSenpaiTeaching,
      _ => state.lastSenpaiText ?? strings.sessionListening,
    };

    // 会話は終わっていて、あとはカルテを待つだけ。
    // ここでボタンを押せるままにしておくと、押しても何も起きないので連打される。
    final bool wrappingUp =
        state.phase == SessionPhase.summarizing || state.phase == SessionPhase.finished;

    final BoardSnapshot board = state.board;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            children: <Widget>[
              _SessionHeader(
                title: board.title,
                remaining: strings.remaining(state.remainingSeconds),
              ),
              if (board.hasBoard) ...<Widget>[
                // **板書が主役。**残りの高さを全部渡す。
                Expanded(child: _BoardStage(board: board)),
                const SizedBox(height: AppSpacing.md),
                _LessonFooter(phase: state.phase, subtitle: subtitle, wrappingUp: wrappingUp),
              ] else ...<Widget>[
                const Spacer(),
                SenpaiFace(
                  mood: switch (state.phase) {
                    SessionPhase.connecting => SenpaiMood.neutral,
                    SessionPhase.listening || SessionPhase.explainBack => SenpaiMood.listening,
                    SessionPhase.senpaiSpeaking || SessionPhase.senpaiTeaching => SenpaiMood.neutral,
                    SessionPhase.summarizing => SenpaiMood.neutral,
                    SessionPhase.finished => SenpaiMood.delighted,
                    // 困り顔が出るのは**こちら側の不首尾**のときだけ
                    // (`SenpaiMood.puzzled` の定義)。生徒が詰まったときには出さない。
                    SessionPhase.failed => SenpaiMood.puzzled,
                  },
                  size: 160,
                ),
                const SizedBox(height: AppSpacing.md),
                _StatusIndicator(phase: state.phase, wrappingUp: wrappingUp),
                const SizedBox(height: AppSpacing.md),
                // 字幕。声を聞き取れない場所でも会話の流れを追えるようにする。
                // 差し替わるときに入れ替わりが見えるよう、文ごとに切り替える。
                _Subtitle(text: subtitle, align: TextAlign.center),
                const Spacer(),
              ],
              // パスは恥ではない。穴の記録として価値がある(handoff §7)。
              GhostButton(
                label: strings.sessionPass,
                onPressed: wrappingUp
                    ? null
                    : () => ref
                        .read(sessionControllerProvider.notifier)
                        .pass(strings.sessionPassMessage),
              ),
              ChunkyButton(
                label: wrappingUp ? strings.sessionSummarizing : strings.sessionEnd,
                color: AppColors.border,
                foregroundColor: AppColors.ink,
                // 押した瞬間に押せなくなる。もう受け取ってあることが、
                // 文言と色の両方で分かるようにする。
                onPressed: wrappingUp
                    ? null
                    : () => ref.read(sessionControllerProvider.notifier).finish(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 上段。残り時間と、板書があればその見出し(「この板書は何の問題か」)。
class _SessionHeader extends StatelessWidget {
  const _SessionHeader({required this.title, required this.remaining});

  final String? title;
  final String remaining;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        if (title != null)
          Expanded(
            child: Text(
              title!,
              style: Theme.of(context).textTheme.titleMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          )
        else
          const Spacer(),
        Text(remaining, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

/// 授業中の板書。**画面の主役**で、1行ずつ積み上がる。
///
/// 幅について(計画書§3-6b): `board_style.dart` の縮小率の下限70%は
/// **実効幅340pt**(iPhone 15 の393pt − 板書の余白)での実測から決めた値。
/// この画面の左右の余白は `AppSpacing.lg` × 2 = 48pt なので実効345pt で、
/// 実測の前提とほぼ同じ。**ここにカードや内側パディングを足すと実効幅が
/// 想定を割り込み、実測では収まっていた式まで横スクロールに落ちる**ので足さない。
/// `latex_element_view.dart` の右端フェードも、板書が
/// `AppColors.background`(Scaffoldの地)に直接乗る前提の色で描かれている。
///
/// **[build] の `CrossAxisAlignment.stretch` は見た目ではなく実効幅の指定。**
/// `start` にすると板書の `Column` はいちばん長い行の自然幅まで痩せ、
/// [LatexElementView] は**その痩せた幅**を基準に縮小率を判定する。自習室側で
/// 実際に起きた(345pt のつもりが実測198pt。カードの余白より効いていた)ので、
/// 揃えるための `start` に見えても戻さないこと。見張りは
/// `test/session_board_test.dart` の「板書の実効幅は…340pt を下回らない」。
class _BoardStage extends StatefulWidget {
  const _BoardStage({required this.board});

  final BoardSnapshot board;

  @override
  State<_BoardStage> createState() => _BoardStageState();
}

class _BoardStageState extends State<_BoardStage> {
  final ScrollController _controller = ScrollController();

  /// 「いちばん下を見ている」と見なす余裕。ぴったり一致は求めない
  /// (数式の計測が1フレーム遅れて入るので、数pt のずれは普通に起きる)。
  static const double _followSlack = 48;

  @override
  void didUpdateWidget(_BoardStage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.board.steps.length == oldWidget.board.steps.length) return;

    // **上に戻って読んでいる最中は連れ戻さない。**板書の価値は
    // 「聞いていない瞬間でも後で見返せる」ことなので、見返しを
    // 新しい行が奪うと、その価値を自分で壊すことになる。
    if (!_isAtBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => _followNewLine());
  }

  bool get _isAtBottom {
    if (!_controller.hasClients) return true;
    final ScrollPosition position = _controller.position;
    return position.pixels >= position.maxScrollExtent - _followSlack;
  }

  void _followNewLine() {
    if (!mounted || !_controller.hasClients) return;
    final double bottom = _controller.position.maxScrollExtent;
    if (AppMotion.isReduced(context)) {
      _controller.jumpTo(bottom);
      return;
    }
    _controller.animateTo(bottom, duration: AppDurations.draw, curve: AppCurves.enter);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      controller: _controller,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          BoardView(steps: widget.board.steps),
          if (widget.board.hasGap) const _BoardGapNotice(),
        ],
      ),
    );
  }
}

/// 板書がとぎれたことを出す一行。
///
/// **黙って虫食いのまま見せない**(`domain/board.dart` の `BoardContractViolation`)。
/// 生徒は抜けていることに気づけないまま、間違ったやり方を覚えてしまう。
/// ただし**責める見た目にはしない** — 落としたのはこちら側で、生徒は何も悪くない。
/// 穴の色(`AppColors.hole`)も使わない。あれは「これから埋まる学習の穴」であって、
/// 配送の失敗ではない。
class _BoardGapNotice extends StatelessWidget {
  const _BoardGapNotice();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Divider(color: AppColors.border, height: AppSpacing.lg),
        Text(
          AppStrings.of(context).sessionBoardGap,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.inkMuted),
        ),
      ],
    );
  }
}

/// 授業中の下の帯。**板書を消さずに**、先輩と自分の番を出す場所。
class _LessonFooter extends StatelessWidget {
  const _LessonFooter({
    required this.phase,
    required this.subtitle,
    required this.wrappingUp,
  });

  final SessionPhase phase;
  final String subtitle;
  final bool wrappingUp;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final bool yourTurn = phase == SessionPhase.explainBack;

    return Row(
      children: <Widget>[
        // 顔は消さない(隣にいることが授業モードの体験そのもの)が、
        // 主役は板書なので小さく置く。
        SenpaiFace(
          mood: yourTurn ? SenpaiMood.listening : SenpaiMood.neutral,
          size: 64,
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              // 教え返しは**指示が主役**。字幕より大きく、先に読める位置に出す。
              if (yourTurn && !wrappingUp)
                Text(strings.sessionExplainBack, style: Theme.of(context).textTheme.titleMedium),
              _Subtitle(text: subtitle, align: TextAlign.start),
            ],
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        _StatusIndicator(phase: phase, wrappingUp: wrappingUp),
      ],
    );
  }
}

/// 聞いていること(またはカルテを書いていること)を、字幕より先に出す部分。
///
/// 話している最中は文字を読んでいないので、目の端で分かる必要がある。
/// カルテを書いているあいだは、待たせている場所をここに出す
/// (波のままだと、まだ聞いていると思わせてしまう)。
class _StatusIndicator extends StatelessWidget {
  const _StatusIndicator({required this.phase, required this.wrappingUp});

  final SessionPhase phase;
  final bool wrappingUp;

  @override
  Widget build(BuildContext context) {
    if (wrappingUp) {
      return SizedBox(
        height: 26,
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(
              strokeWidth: 2.5,
              // 動かさない設定では回さない。書いている途中だと分かる
              // 円弧として置く(SpeakingWave と同じ扱い)。
              value: AppMotion.isReduced(context) ? 0.25 : null,
            ),
          ),
        ),
      );
    }
    return SpeakingWave(
      active: phase == SessionPhase.listening || phase == SessionPhase.explainBack,
    );
  }
}

/// 字幕。声を聞き取れない場所でも会話の流れを追えるようにする。
class _Subtitle extends StatelessWidget {
  const _Subtitle({required this.text, required this.align});

  final String text;
  final TextAlign align;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: AppMotion.decorative(context, AppDurations.reaction),
      child: Text(
        text,
        key: ValueKey<String>(text),
        textAlign: align,
        style: Theme.of(context).textTheme.bodyLarge,
      ),
    );
  }
}

/// 会話が始まらなかった画面。
///
/// **理由を出して、出口を用意する。** 「聞いています」のまま止めておくと、
/// ユーザーは自分の説明が悪いのだと思ってしまう。
class _SessionFailed extends ConsumerWidget {
  const _SessionFailed({required this.failure});

  final SessionFailure? failure;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final SessionStart? session = ref.watch(captureControllerProvider).session;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const SenpaiFace(mood: SenpaiMood.puzzled, size: 160),
              const SizedBox(height: AppSpacing.xl),
              Text(
                switch (failure) {
                  SessionFailure.senpaiUnavailable => strings.sessionSenpaiUnavailable,
                  SessionFailure.connection || null => strings.sessionConnectionFailed,
                },
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: AppSpacing.xl),
              if (session != null)
                ChunkyButton(
                  label: strings.sessionRetry,
                  onPressed: () =>
                      ref.read(sessionControllerProvider.notifier).retry(session),
                ),
              GhostButton(
                label: strings.sessionBackHome,
                onPressed: () => context.go(AppRoute.home.path),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
