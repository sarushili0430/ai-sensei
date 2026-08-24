import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../../karte/application/karte_controllers.dart';
import '../application/board_inbox.dart';
import '../application/problem_photo_picker.dart';
import '../application/session_controller.dart';
import '../domain/session.dart';
import 'board/board_style.dart';
import 'board/board_view.dart';

/// 会話画面(ワイヤーフレームの03/04を1枚に統合)。
///
/// **にぎやかな画面**にする。ただし試験官UIにはしない。
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
  bool _isTakingProblemPhoto = false;
  bool _problemPhotoPickFailed = false;
  bool _exitConfirmationOpen = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final SessionStart? session = ref.read(captureControllerProvider).session;
      if (session == null) {
        context.go(AppRoute.home.path);
        return;
      }
      ref.read(sessionControllerProvider.notifier).connect(
            session,
            locale: Localizations.localeOf(context).languageCode,
          );
    });
  }

  Future<void> _takeProblemPhoto() async {
    if (_isTakingProblemPhoto) return;
    setState(() {
      _isTakingProblemPhoto = true;
      _problemPhotoPickFailed = false;
    });

    try {
      final photo = await ref.read(problemPhotoPickerProvider).takePhoto();
      if (!mounted) return;
      setState(() => _isTakingProblemPhoto = false);
      // カメラを閉じただけなら失敗扱いにしない。会話へそのまま戻る。
      if (photo == null) return;
      await ref
          .read(sessionControllerProvider.notifier)
          .addProblemPhoto(
            photo,
            locale: Localizations.localeOf(context).languageCode,
          );
    } on Object catch (error, stack) {
      // カメラ権限やプラグインの失敗で会話画面ごと落とさない。
      debugPrint('会話中の問題写真を取得できませんでした: $error\n$stack');
      if (!mounted) return;
      setState(() {
        _isTakingProblemPhoto = false;
        _problemPhotoPickFailed = true;
      });
    }
  }

  Future<void> _confirmExit() async {
    final SessionState state = ref.read(sessionControllerProvider);
    if (_exitConfirmationOpen ||
        state.isUnderstood ||
        state.phase == SessionPhase.summarizing ||
        state.phase == SessionPhase.finished) {
      return;
    }

    _exitConfirmationOpen = true;
    final bool leave = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          barrierColor: AppColors.ink.withValues(alpha: 0.55),
          builder: (BuildContext dialogContext) => PopScope<Object?>(
            // 確認を出したあとに戻るジェスチャだけで離脱できると、× に確認を
            // 挟んだ意味が消える。どちらの選択かを明示して閉じてもらう。
            canPop: false,
            child: _ExitConfirmationDialog(
              onContinue: () => Navigator.of(dialogContext).pop(false),
              onExit: () => Navigator.of(dialogContext).pop(true),
            ),
          ),
        ) ??
        false;
    _exitConfirmationOpen = false;
    if (!mounted || !leave) return;

    // 終了そのものは時間切れと同じ [SessionController.finish] に合流させる。
    // 画面側で切断を別に作ると、agent が離脱理由を確定する経路と食い違い、
    // 作らないはずの復習問題を待つ画面になりうる。
    //
    // **降り方だけは分ける。**「やめる」は ④'(今日はここまで)も出さずに
    // ホームへ戻る道で、時間切れとは見せるものが違う(ADR 0009 の画面遷移)。
    unawaited(
      ref
          .read(sessionControllerProvider.notifier)
          .finish(ending: SessionEnding.other),
    );
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final SessionState state = ref.watch(sessionControllerProvider);

    ref.listen<SessionState>(sessionControllerProvider, (SessionState? previous, SessionState next) {
      if (next.phase != SessionPhase.finished) return;
      // **④' が出るのは残り時間が理由のときだけ。**「やめる」で降りた回に
      // 「今日はここまでにしよっか」を出すと、自分で選んだ離脱に先輩の締めが
      // 重なって、やめたことを咎められたように読める(ADR 0009)。
      final SessionEnding ending = ref.read(sessionOutcomeControllerProvider).ending;
      context.go(
        ending == SessionEnding.other ? AppRoute.home.path : AppRoute.celebration.path,
      );
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
    // 解析が読み取れた問題。読めなければ `null` で、そのときは何も出さない
    // (「問題が読めませんでした」と書くと、先輩が読み上げを頼む前に
    // 生徒が撮り直しに行ってしまう)。
    final SessionProblem? problem = state.problem;
    final SessionStart? session = ref.watch(captureControllerProvider).session;
    final bool canAddProblem = session?.kind == 'new';
    final bool lessonSession = session?.kind == 'new' || session?.kind == 'review';

    final Widget screen = Scaffold(
      body: SafeArea(
        // **横の余白は子ごとに付ける。**全体を1つの `Padding` で包まないのは、
        // 板書だけが「角丸の面」で、そこに差し込む縦位置の調整が他と違うから
        // (`_BoardStage`)。余白の値そのものはどの子も `AppSpacing.lg` で揃う。
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
          child: Column(
            children: <Widget>[
              _Inset(
                child: _SessionHeader(
                  closeLabel: strings.sessionClose,
                  // 「わかった」の直後に × で先に切断すると、到達が離脱へ
                  // 上書きされて復習問題が作られない競合になるため、ここも同時に塞ぐ。
                  onClose: wrappingUp || state.isUnderstood
                      ? null
                      : () => unawaited(_confirmExit()),
                ),
              ),
              // **問題文は板書より上に、常に出す。**見出し(`board.title`)は
              // 先輩が付けた要約で、問題そのものではない。何を解いているかが
              // 画面のどこにも無いと、板書から逆算するしかなくなる
              // (`docs/wireframe_board_v2.html` の1つ目)。
              if (problem != null) ...<Widget>[
                const SizedBox(height: AppSpacing.sm),
                _Inset(child: _ProblemBlock(text: problem.text)),
              ],
              if (canAddProblem) ...<Widget>[
                const SizedBox(height: AppSpacing.sm),
                _Inset(
                  child: _ProblemPhotoAction(
                    state: state,
                    isTakingPhoto: _isTakingProblemPhoto,
                    pickFailed: _problemPhotoPickFailed,
                    disabled:
                        wrappingUp || state.phase == SessionPhase.connecting,
                    onAdd: _takeProblemPhoto,
                    onRetryNotification: () => ref
                        .read(sessionControllerProvider.notifier)
                        .retryProblemContextNotification(),
                  ),
                ),
              ],
              if (board.hasBoard) ...<Widget>[
                const SizedBox(height: AppSpacing.md),
                // **板書が主役。**残りの高さを全部渡す。
                Expanded(child: _Inset(child: _BoardStage(board: board))),
                const SizedBox(height: AppSpacing.md),
                _Inset(
                  child: _LessonStatus(
                    wrappingUp: wrappingUp,
                    awaitingSolving: state.awaitingSolving,
                    isUnderstood: state.isUnderstood,
                  ),
                ),
              ] else
                // **板書が無いときだけ、字幕を出す。**
                //
                // 字幕の根拠は「声を聞き取れない場所でも追えるように」だったが、
                // このアプリは**教え返し**が本体で、そもそも声を出せない場所では
                // 成立しない。板書が出ているなら、読むべきものは板書のほうにある。
                //
                // 板書が無い経路(板書に失敗した立て直し・古いAPIの復習)では、
                // 先輩の言葉が**画面上の唯一の手がかり**なので、ここだけ残す。
                //
                // 高さは1つの箱として渡し、中でスクロールさせる。`Spacer` で挟んで
                // いたころは、長い返事がそのまま**下の操作を画面の外へ押し出していた**
                // (実機で「今日はここまで」に BOTTOM OVERFLOWED が重なった)。
                Expanded(
                  child: CenteredScroll(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
                    children: <Widget>[
                      SenpaiFace(
                        mood: switch (state.phase) {
                          SessionPhase.connecting => SenpaiMood.neutral,
                          SessionPhase.listening ||
                          SessionPhase.explainBack => SenpaiMood.listening,
                          SessionPhase.senpaiSpeaking ||
                          SessionPhase.senpaiTeaching => SenpaiMood.neutral,
                          SessionPhase.summarizing => SenpaiMood.neutral,
                          SessionPhase.finished => SenpaiMood.delighted,
                          // 困り顔が出るのは**こちら側の不首尾**のときだけ
                          // (`SenpaiMood.puzzled` の定義)。生徒が詰まったときには出さない。
                          SessionPhase.failed => SenpaiMood.puzzled,
                        },
                        size: 160,
                      ),
                      const SizedBox(height: AppSpacing.md),
                      if (state.isUnderstood)
                        _LessonStatus(
                          wrappingUp: wrappingUp,
                          awaitingSolving: false,
                          isUnderstood: true,
                        )
                      else
                        _StatusIndicator(phase: state.phase, wrappingUp: wrappingUp),
                      const SizedBox(height: AppSpacing.md),
                      // 差し替わるときに入れ替わりが見えるよう、文ごとに切り替える。
                      _Subtitle(text: subtitle, align: TextAlign.center),
                    ],
                  ),
                ),
              // 状態の一行と操作のあいだ。**詰めると読めない** — キャンバスは
              // 縦の並びが 16pt 刻みで、ここだけ 0 にすると「先輩が説明中」が
              // ボタンの縁に食い込む。
              const SizedBox(height: AppSpacing.md),
              if (lessonSession && state.awaitingSolving && !state.isUnderstood)
                _Inset(
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: ChunkyButton(
                          label: strings.sessionSolved,
                          onPressed: wrappingUp
                              ? null
                              : () => ref
                                  .read(sessionControllerProvider.notifier)
                                  .reportSolving(strings.sessionSolvedMessage),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: GhostButton(
                          label: strings.sessionStuck,
                          onPressed: wrappingUp
                              ? null
                              : () => ref
                                  .read(sessionControllerProvider.notifier)
                                  .reportSolving(strings.sessionStuckMessage),
                        ),
                      ),
                    ],
                  ),
                )
              else if (lessonSession)
                // 類題の二択は、最後の板書手順が明示した短い解答待ちだけに出る。
                // その返答が無いと既存の類題経路が進まないため、その間だけ
                // 「わかった」と入れ替える。並べると画面下の操作が2つになり、
                // どちらが今の問いへの返事か分からなくなる。
                _Inset(
                  child: ChunkyButton(
                    label: strings.sessionUnderstood,
                    sunkWhenDisabled: state.isUnderstood,
                    onPressed: wrappingUp || state.isUnderstood
                        ? null
                        : () => unawaited(
                            ref.read(sessionControllerProvider.notifier).understood(),
                          ),
                  ),
                )
              else
                // パスは恥ではない。穴の記録として価値がある。
                _Inset(
                  child: GhostButton(
                    label: strings.sessionPass,
                    onPressed: wrappingUp
                        ? null
                        : () => ref
                            .read(sessionControllerProvider.notifier)
                            .pass(strings.sessionPassMessage),
                  ),
                ),
              if (!lessonSession)
                _Inset(
                  child: ChunkyButton(
                    label: wrappingUp ? strings.sessionSummarizing : strings.sessionEnd,
                    color: AppColors.border,
                    foregroundColor: AppColors.ink,
                    // 押した瞬間に押せなくなる。もう受け取ってあることが、
                    // 文言と色の両方で分かるようにする。
                    onPressed: wrappingUp
                        ? null
                        : () => ref.read(sessionControllerProvider.notifier).finish(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    return PopScope<Object?>(
      // セッションのルートを先に外すと、確認の裏で controller も破棄される。
      // OS の戻る操作も × と同じ入口へ集め、板書と残り時間を保ったまま確認する。
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) unawaited(_confirmExit());
      },
      child: screen,
    );
  }
}

/// 次の問題を足す操作。失敗しても会話全体の操作は残し、現在の問題を続けられる。
class _ProblemPhotoAction extends StatelessWidget {
  const _ProblemPhotoAction({
    required this.state,
    required this.isTakingPhoto,
    required this.pickFailed,
    required this.disabled,
    required this.onAdd,
    required this.onRetryNotification,
  });

  final SessionState state;
  final bool isTakingPhoto;
  final bool pickFailed;
  final bool disabled;
  final VoidCallback onAdd;
  final VoidCallback onRetryNotification;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final bool busy = isTakingPhoto || state.isAddingProblemPhoto;
    final bool notificationPending = state.contextNotificationPending;
    final String? error = switch (state.problemPhotoFailure) {
      ProblemPhotoFailure.analysis =>
        state.problemPhotoErrorMessage ?? strings.sessionProblemPhotoFailed,
      ProblemPhotoFailure.notification =>
        strings.sessionProblemNotificationFailed,
      null when pickFailed => strings.sessionProblemPhotoFailed,
      null => null,
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (busy)
          Row(
            children: <Widget>[
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(strings.sessionAddingProblem)),
            ],
          )
        else if (notificationPending)
          OutlinedButton.icon(
            onPressed: disabled ? null : onRetryNotification,
            icon: const Icon(Icons.refresh),
            label: Text(strings.sessionProblemNotificationRetry),
          )
        else
          OutlinedButton.icon(
            onPressed: disabled || state.problemPhotoLimitReached
                ? null
                : onAdd,
            icon: const Icon(Icons.add_a_photo_outlined),
            label: Text(strings.sessionAddProblem),
          ),
        if (error != null) ...<Widget>[
          const SizedBox(height: AppSpacing.xs),
          Text(
            error,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: AppColors.inkMuted),
          ),
        ],
      ],
    );
  }
}

/// 上段。**× だけ。**
///
/// 板書の見出しは板の中(`BoardView.title`)へ、残り時間はホームへ移した
/// (`docs/core_loop_screens.html`)。授業中の画面に数字を置かないのは約束4
/// (「煽らない。数字も見せない」)で、**残り時間の数字がいちばん急かす** —
/// 時間が尽きるときは先輩が「今日はここまでにしよっか」と言って降りるので、
/// 生徒が自分で秒数を見張る必要はない。
class _SessionHeader extends StatelessWidget {
  const _SessionHeader({required this.closeLabel, required this.onClose});

  final String closeLabel;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        // キャンバスの `margin-left: -10px`。当たり判定44ptを保ったまま、
        // × の線そのものを画面の左余白に揃える。
        Transform.translate(
          offset: const Offset(-10, 0),
          child: _SessionCloseButton(label: closeLabel, onPressed: onClose),
        ),
        const Spacer(),
      ],
    );
  }
}

/// 標準位置の離脱操作。図形の線幅まで仕様なので、フォントの × には任せない。
class _SessionCloseButton extends StatelessWidget {
  const _SessionCloseButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: onPressed != null,
      label: label,
      child: SizedBox.square(
        key: const Key('session-close'),
        dimension: 44,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onPressed,
            child: const Center(
              child: CustomPaint(
                key: Key('session-close-mark'),
                size: Size.square(20),
                painter: _CloseMarkPainter(),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CloseMarkPainter extends CustomPainter {
  const _CloseMarkPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = AppColors.inkMuted
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    const double inset = 4;
    canvas
      ..drawLine(
        const Offset(inset, inset),
        Offset(size.width - inset, size.height - inset),
        paint,
      )
      ..drawLine(
        Offset(size.width - inset, inset),
        Offset(inset, size.height - inset),
        paint,
      );
  }

  @override
  bool shouldRepaint(_CloseMarkPainter oldDelegate) => false;
}

class _ExitConfirmationDialog extends StatelessWidget {
  const _ExitConfirmationDialog({required this.onContinue, required this.onExit});

  final VoidCallback onContinue;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 305),
        child: DecoratedBox(
          key: const Key('session-exit-dialog-card'),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadius.card),
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(strings.sessionQuitTitle, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: AppSpacing.md),
                Text(
                  strings.sessionQuitBody,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppColors.inkMuted,
                      ),
                ),
                const SizedBox(height: AppSpacing.lg),
                ChunkyButton(label: strings.sessionContinue, onPressed: onContinue),
                GhostButton(label: strings.sessionQuit, onPressed: onExit),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// いま解いている問題。**板書の上に、授業のあいだずっと出しておく。**
///
/// 板書は積み上がるので、問題文をスクロールの中に置くとすぐ画面外へ出る。
/// けれど**教え返しの最中にいちばん見返したいのが問題文**なので、流さずに
/// ここへ固定する(`docs/wireframe_board_v2.html`)。
///
/// **3行で頭打ちにする。** 契約の上限は600字(`problemTextMaxLength`)で、
/// 全文を出すと板書が画面の外へ押し出される。撮影画面は全文表示のまま外側を
/// スクロールさせているが、こちらは同じ手が使えない(押し出す先が板書になる)。
/// 開いたときも、板書が見える高さが残るよう最大8行で止める。
class _ProblemBlock extends StatefulWidget {
  const _ProblemBlock({required this.text});

  final String text;

  @override
  State<_ProblemBlock> createState() => _ProblemBlockState();
}

class _ProblemBlockState extends State<_ProblemBlock> {
  static const int _collapsedLines = 3;
  static const int _expandedLines = 8;

  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final TextStyle? body = Theme.of(context).textTheme.bodyMedium;

    return DecoratedBox(
      decoration: BoxDecoration(
        // **板書と素材を変える。** 問題は紙(白)、板書は地に直接。
        // ラベルを読まなくても役割が分かるのは、文字ではなく面が違うから。
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              strings.sessionProblemTitle,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.inkMuted),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              widget.text,
              style: body,
              maxLines: _expanded ? _expandedLines : _collapsedLines,
              overflow: TextOverflow.ellipsis,
            ),
            // **畳めることが分かる形にする。**省略記号だけだと、続きがあることに
            // 気づいても開き方が分からない。短い問題文では出さない。
            if (_isTruncated(context, body))
              GestureDetector(
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.xs),
                  child: Text(
                    _expanded ? strings.sessionProblemCollapse : strings.sessionProblemExpand,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.blue),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 畳んだ状態で本文が入り切らないか。**実際に組んで測る** —
  /// 文字数で判定すると、改行の多い問題文で「続きを読む」が出なくなる。
  bool _isTruncated(BuildContext context, TextStyle? style) {
    final double width = MediaQuery.sizeOf(context).width - AppSpacing.lg * 2 - AppSpacing.md * 2;
    if (width <= 0) return false;
    final TextPainter painter = TextPainter(
      text: TextSpan(text: widget.text, style: style),
      maxLines: _collapsedLines,
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout(maxWidth: width);
    final bool overflows = painter.didExceedMaxLines;
    painter.dispose();
    return overflows;
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
/// [LatexElementView] は**その痩せた幅**を基準に縮小率を判定する。授業の外で
/// 板書を出す画面で実際に起きた(345pt のつもりが実測198pt。カードの余白より
/// 効いていた)ので、揃えるための `start` に見えても戻さないこと。見張りは
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
    // **板は動かない。動くのはチョークのほう。**
    //
    // 面を [BoardView] の中(= スクロールする側)だけに置くと、板が中身の高さに
    // 縮んで、1〜2行しか書いていない授業では**画面の途中で板が終わる**。
    // スクロールすると板の上下の縁も一緒に動くので、黒板ではなく黒い紙に見える。
    // ここで授業の高さいっぱいに敷いておけば、書いた量に関わらず板は板のまま。
    //
    // **角を丸めるのもここ。**丸めるべき高さを知っているのはこの層だけで、
    // [BoardView] の中で丸めると「中身の高さの角丸」がスクロールと一緒に動く。
    // `ClipRRect` で内側も切るのは、いちばん上の行が角へ食い込むのを防ぐため。
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppRadius.card),
      child: ColoredBox(
        color: BoardStyle.surface,
        child: SingleChildScrollView(
          controller: _controller,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              BoardView(steps: widget.board.steps, title: widget.board.title),
              if (widget.board.hasGap) const _BoardGapNotice(),
            ],
          ),
        ),
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
    // **板の上に書く一行なので、チョークの色で書く。**インクのままだと
    // 黒に黒で、とぎれたことを伝える文だけが読めないまま残る。
    // 左右の余白は [BoardView] の中ではないので、ここで同じ値を付ける。
    return Padding(
      padding: const EdgeInsets.fromLTRB(BoardView.padding, 0, BoardView.padding, AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Divider(color: BoardStyle.chalkMuted, height: AppSpacing.lg),
          Text(
            AppStrings.of(context).sessionBoardGap,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: BoardStyle.chalkMuted,
                ),
          ),
        ],
      ),
    );
  }
}

/// 授業中の下の状態表示。**板書を消さずに**、いま起きていることだけを短く出す。
///
/// **字幕は置かない。**板書が出ているあいだ、読むべきものは板書のほうにある。
/// ここに先輩の発話をそのまま流すと、板書に追い出したはずの説明が
/// 文字で戻ってきて、**画面の主役が二重になる**(実機で、図と式が出ている下に
/// 4段落の文字起こしが乗った)。ここが持つのは状態だけ。
class _LessonStatus extends StatelessWidget {
  const _LessonStatus({
    required this.wrappingUp,
    required this.awaitingSolving,
    required this.isUnderstood,
  });

  final bool wrappingUp;
  final bool awaitingSolving;
  final bool isUnderstood;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final Widget mark;
    final String text;

    if (isUnderstood) {
      mark = const Icon(Icons.check_rounded, size: 18, color: AppColors.blue);
      text = strings.sessionVoiceStopped;
    } else if (wrappingUp) {
      mark = const SizedBox.square(
        dimension: 16,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
      text = strings.sessionSummarizing;
    } else {
      mark = const DecoratedBox(
        decoration: BoxDecoration(color: AppColors.blue, shape: BoxShape.circle),
        child: SizedBox.square(dimension: 8),
      );
      text = awaitingSolving ? strings.sessionSolving : strings.sessionTeachingStatus;
    }

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        mark,
        const SizedBox(width: AppSpacing.sm),
        Flexible(child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
      ],
    );
  }
}

/// 画面の左右の余白。**板書も含めて、どの子も同じ値**
/// (`docs/core_loop_screens.html`。板は角丸のカードとして地の上に置く)。
class _Inset extends StatelessWidget {
  const _Inset({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      child: child,
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
                  onPressed: () => ref.read(sessionControllerProvider.notifier).retry(
                        session,
                        locale: Localizations.localeOf(context).languageCode,
                      ),
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
