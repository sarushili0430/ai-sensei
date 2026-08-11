import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:permission_handler/permission_handler.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/marker_text.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../notifications/application/push_controller.dart';
import '../../notifications/data/push_repository.dart';
import '../../session/presentation/board/board_view.dart';
import '../application/karte_controllers.dart';
import '../application/last_board_controller.dart';
import '../application/lesson_hole_candidate.dart';
import '../domain/karte.dart';
import '../domain/last_board.dart';
import 'hole_self_report_prompt.dart';

/// カルテ画面。
///
/// **静かな画面**にする(handoff §7「騒がしい/静かの分離」)。
/// 内省する場所なので、祝福画面のにぎやかさを持ち込まない。
/// 点数は出さない。穴は「これから埋まる場所」として提示する。
///
/// 読む順は「結論 → 根拠 → 操作」。言えたこと・穴・用語メモが今日の結論、
/// [_BoardSection] が先輩の書いたものそのもの(根拠)、そのあとに
/// あと追い質問・自己申告・通知の許可という**手を動かすもの**を置く。
/// 板書を先頭に置かないのは、長い板書が結論を画面の外へ押し出すため。
class KarteScreen extends ConsumerWidget {
  const KarteScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final Karte? karte = ref.watch(latestKarteControllerProvider);
    final SessionOutcome outcome = ref.watch(sessionOutcomeControllerProvider);
    final bool showPaywall = outcome.showPaywall;

    // 直近のカルテが無いときはルータがホームへ戻す(app_router.dart の redirect)。
    // ここに来るのはその1フレームぶんなので、エラー文言は出さない。
    if (karte == null) {
      return Scaffold(
        appBar: AppBar(title: Text(strings.karteTitle)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(strings.karteTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: <Widget>[
            // マーカーは上の行から順に引かれる。今日の会話が書き取られていく順。
            // 速くしない — ここは読み返す画面なので、走らせると落ち着かない。
            _Section(
              title: strings.karteSaidWell,
              children: <Widget>[
                for (int i = 0; i < karte.saidWell.length; i++)
                  MarkerText(
                    karte.saidWell[i],
                    marker: MarkerColor.said,
                    delay: AppDurations.draw * i,
                  ),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
            _Section(
              title: strings.karteHoles(karte.holes.length),
              children: karte.holes.isEmpty
                  ? <Widget>[Text(strings.karteNoHoles)]
                  : <Widget>[
                      for (int i = 0; i < karte.holes.length; i++)
                        MarkerText(
                          karte.holes[i].description,
                          marker: MarkerColor.hole,
                          // 言えたことを引き終わってから、穴に移る。
                          delay: AppDurations.draw * (karte.saidWell.length + i),
                        ),
                    ],
            ),
            if (karte.termNotes.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _Section(
                title: strings.karteTermNotes,
                children: karte.termNotes
                    .map((String it) => Text(it, style: Theme.of(context).textTheme.bodyMedium))
                    .toList(growable: false),
              ),
            ],
            const _BoardSection(),
            if (karte.followupQuestion != null) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _FollowupCard(question: karte.followupQuestion!),
            ],
            if (outcome.isNewLesson) ...<Widget>[
              const SizedBox(height: AppSpacing.lg),
              _LessonHoleSelfReport(karte: karte),
            ],
            const SizedBox(height: AppSpacing.xl),
            if (karte.holes.isNotEmpty) const _ReviewReminderCard(),
            const SizedBox(height: AppSpacing.lg),
            if (karte.holes.isNotEmpty)
              ChunkyButton(
                label: strings.karteRetry,
                onPressed: () => context.push(AppRoute.review.path),
              ),
            GhostButton(
              label: strings.karteDone,
              // 初回カルテで穴が見えた直後だけ、ここでペイウォールを挟む。
              // 出す/出さないの判断はサーバが持つ(煽らないため2回目以降は出さない)。
              onPressed: () => context.go(
                showPaywall ? AppRoute.paywall.path : AppRoute.home.path,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 授業で扱った内容と重なる、**過去の穴**だけをカルテのあとに聞く。
///
/// 祝福画面に置かないのは、そこがまだカルテを受け取っている途中で、
/// `said_well`(候補を絞る根拠)が揃っていないことがあるため。カルテの本文を読んだ
/// 直後なら、何について自己申告しているかも見失わない。
///
/// キューの取得失敗は黙って省略する。今日のカルテを読むことまで止めて再試行を
/// 求めると、任意の聞き直しがカルテ閲覧の関門になり、催促に変わる。
class _LessonHoleSelfReport extends ConsumerStatefulWidget {
  const _LessonHoleSelfReport({required this.karte});

  final Karte karte;

  @override
  ConsumerState<_LessonHoleSelfReport> createState() => _LessonHoleSelfReportState();
}

class _LessonHoleSelfReportState extends ConsumerState<_LessonHoleSelfReport> {
  bool _dismissed = false;

  @override
  Widget build(BuildContext context) {
    if (_dismissed) return const SizedBox.shrink();

    final ReviewQueue? queue = ref.watch(reviewControllerProvider).value;
    if (queue == null) return const SizedBox.shrink();
    final ReviewQueueItem? candidate = selectLessonHoleCandidate(
      karte: widget.karte,
      queue: queue,
    );
    if (candidate == null) return const SizedBox.shrink();

    return HoleSelfReportPrompt(
      hole: candidate.hole,
      showLaterHint: true,
      // 「まだ」はこのカルテでの問いを閉じるだけ。穴も通知もそのまま残り、
      // 復習画面からいつでも同じ選択に戻れる。
      onNotYet: () => setState(() => _dismissed = true),
      onFilled: () => setState(() => _dismissed = true),
    );
  }
}

/// 授業で先輩が書いた板書。**授業の寿命を超えて読み返せる唯一の場所**。
///
/// 会話画面の板書は AutoDispose と一緒に消えるので、残っているのは
/// [LastBoardController] が持つぶんだけ。授業が1回も無い / 音声だけで終わった
/// 会話では、見出しごと出さない(空の見出しは「壊れている」に見える)。
///
/// **カードに入れない(囲わない・内側に余白を足さない)。** 見た目の好みではなく、
/// 計画書§3-6b の実測の前提そのものだから:
///
///   - `BoardStyle.latexMinScale`(70%)は**実効幅340pt**での実測から決めた値。
///     カルテの左右の余白は `ListView` の `AppSpacing.lg` × 2 = 48pt なので
///     `BoardStyle.horizontalPadding` と同じで、授業モード(`_BoardStage`)と揃う。
///     ここに `padding: md` と `border` のカードを足すと 48 + 32 + 2 を引くことになり、
///     実測で「縮小して収まる」と確認した式が下限を割って**横スクロールに落ちる**。
///     しかも落ちたことは `debugPrint` にしか出ない
///   - `latex_element_view.dart` の右端フェードは、板書が
///     `AppColors.background`(Scaffoldの地)に直接乗る前提の色で描かれている。
///     白いカードの上に置くと地に溶けず、「まだ続きがある」の手がかりとして
///     機能しなくなる
///
/// 「ここが板書だ」は、囲いではなく見出し([AppStrings.karteBoardTitle])が示す。
/// 他の節が [_Section] でそうしているのと同じ形。
class _BoardSection extends ConsumerWidget {
  const _BoardSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final LastBoard board = ref.watch(lastBoardControllerProvider);
    if (board.isEmpty) return const SizedBox.shrink();

    return Column(
      // **`start` にしない。** `start` だと子が自分の自然な幅になり、板書が
      // いちばん長い行の幅まで痩せる。幅が痩せた分だけ縮小率が下がるので、
      // 横スクロールに落ちる式が増える。授業モードの `_BoardStage` も同じ理由で
      // `stretch`(見張りは `test/session_board_test.dart`)。
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const SizedBox(height: AppSpacing.lg),
        Align(
          alignment: Alignment.centerLeft,
          child: Text(
            strings.karteBoardTitle,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        BoardView(steps: board.steps),
        // とぎれた印は、**板書の最後の行の下**に置く。見出しの横や画面の隅ではなく、
        // 読み進めた人が「続きがない」ことに気づく場所に置きたい([LastBoard.truncated])。
        if (board.showsTruncation) ...<Widget>[
          const SizedBox(height: AppSpacing.sm),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              strings.karteBoardTruncated,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        for (final Widget child in children)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Align(alignment: Alignment.centerLeft, child: child),
          ),
      ],
    );
  }
}

/// あしたの夜、もう一度きいてもいいか。
///
/// **通知の許可を求めるのはアプリ中でここだけ。** 初回起動では聞かない。
/// 穴が見つかった直後、先輩からのお願いとして尋ねるほうが文脈が立つし、
/// ここで断られても「翌日・3日後・7日後」の価値は伝わっている。
///
/// スイッチをアプリ側に持たないのは、OSの許可がそのまま状態だから。
/// 二重に持つと「アプリではオンなのに届かない」が生まれる。
class _ReviewReminderCard extends ConsumerWidget {
  const _ReviewReminderCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final PushPermission permission = ref.watch(pushPermissionControllerProvider);

    // 通知を扱えないビルドでは、約束の文言だけを静かに出す。
    final bool granted = permission.granted || !permission.available;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              granted ? strings.karteReviewToggle : strings.karteReviewAsk,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          if (permission.available)
            Switch(
              value: permission.granted,
              activeThumbColor: AppColors.blue,
              onChanged: (bool wantsOn) async {
                // 切るのは設定アプリで。アプリ側に別のスイッチを作らない。
                if (!wantsOn) {
                  await openAppSettings();
                  return;
                }
                final bool ok =
                    await ref.read(pushPermissionControllerProvider.notifier).request();
                if (ok || !context.mounted) return;
                // 一度断られると、iOSはもうダイアログを出さない。設定への行き方を伝える。
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(strings.karteReviewDenied),
                    action: SnackBarAction(
                      label: strings.settingsNotificationsOpenSettings,
                      onPressed: openAppSettings,
                    ),
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

/// 先輩のあと追い質問(Premium)。
class _FollowupCard extends StatelessWidget {
  const _FollowupCard({required this.question});

  final String question;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.blue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      child: Text(question, style: Theme.of(context).textTheme.bodyLarge),
    );
  }
}
