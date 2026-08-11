import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../monetization/presentation/manage_subscription_button.dart';
import '../application/karte_controllers.dart';
import '../domain/karte.dart';

/// ホーム。
///
/// ここは**ハブ**であって、カメラの起動ボタンではない。ピボット(計画書§2)で
/// コアループが「後輩に説明する」から「先輩に教わる → 教え返す」に変わっている。
///
/// 数えているもの(連続日数と埋めた穴)は据え置き。
/// XP・レベル・偏差値は出さない(§5-2)。入口は2つ:
///   - 今日の入口「先輩に教わる」(撮る → 授業モード。従量原価が発生する側 — §4-1)
///   - きのうの続き(埋めていない穴 → 復習)
///
/// **画面のいちばん下に置く操作は、いつでも1つだけ。** 以前はここに授業と自習室の
/// 2本を並べ、先輩が今日を締めた日は色を入れ替えて「押せるほう」を示していた。
/// 自習室を畳んだいまは入れ替えるものが無いので、**同じ場所のボタンの中身を
/// 差し替える**([_PrimaryAction])。締めた日に押せる先が残っているなら復習へ、
/// 埋める穴も無ければ、そこで初めて押せないボタンとして休みを見せる。
///
/// **回数の数字は出さない**(§6-3)。上限は「先輩の判断」として文章で見せる。
/// 詳しくは [_EnoughForTodayLine]。
///
/// 当初はタブバーを置かなかった。常設で戻る場所がホームしかなく、カルテは
/// セッション直後にだけ意味を持つ一過性の画面なので、タブにすると空の場所を
/// 常設してしまうからだった。このうち**カルテをタブにしない判断はいまも有効**。
/// いまはホーム / 計画 / 設定の3枝を下部ナビゲーションで行き来する。
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ProgressSummary> summary = ref.watch(progressControllerProvider);
    final ProgressSummary data = summary.value ?? ProgressSummary.empty;

    // 今日はもう授業をしない、と先輩が決めた状態(§6-3)。
    // 撮ってから断られるより、ここで先に「今日はここまで」と言われるほうがいい。
    // 進捗が取れていないときは `unknown` が true なので、入口を止めない。
    final bool enoughForToday = !data.limits.lessonAllowedToday;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              FadeSlideIn(child: _TopRow(progress: data.progress)),
              // 顔とあいさつは**読む側**。収まれば中央、収まらなければここだけ動く。
              //
              // 以前は `Spacer` 2つで中央に置いていたが、それだと文言が伸びた瞬間に
              // 下の操作ごと画面の外へ押し出される(実測: 英語で「今日はここまで」の
              // 一文が入ると 375×667 で溢れた)。**溢れた `Column` は中身を
              // 切り落とす**ので、押せないボタンができる。
              // 収まるときの見え方は `Spacer` と同じ(中央)。
              Expanded(
                child: CenteredScroll(
                  padding: EdgeInsets.zero,
                  children: <Widget>[
                    const FadeSlideIn(
                      // 顔が自分で「先輩が待っています」と読み上げるようになったので、
                      // ここで包んで差し替えていたラベルは外した(同じ文言の二重管理になる)。
                      child: Center(child: SenpaiFace(mood: SenpaiMood.neutral, size: 140)),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    FadeSlideIn.staggered(
                      index: 1,
                      child: Text(
                        // 締めた日だけ、あいさつも問いかけから労いへ変える。
                        // 「どこでつまずいた?」と聞いておいて撮らせないのは、
                        // 呼びかけと操作が食い違っている。
                        enoughForToday ? strings.homeGreetingDone : strings.homeGreeting,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              FadeSlideIn.staggered(index: 2, child: _OpenHolesCard(progress: data.progress)),
              const SizedBox(height: AppSpacing.md),
              FadeSlideIn.staggered(
                index: 3,
                child: _PrimaryAction(
                  enoughForToday: enoughForToday,
                  hasOpenHoles: data.progress.openHoles > 0,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              FadeSlideIn.staggered(
                index: 4,
                child: _EnoughForTodayLine(
                  show: enoughForToday,
                  showUpgrade: !data.isPremium,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 画面の下でいつも同じ場所に居る、今日の1手。
///
/// **並べない。差し替える。** ボタンを2本並べると、片方が押せない日に
/// 「押せるほうがどちらか」を色だけで見分けさせることになる。同じ場所の
/// ラベルと行き先が変わるほうが、読まずに押しても間違いが起きない。
///
/// | 状態 | ラベル | 行き先 |
/// | --- | --- | --- |
/// | 授業ができる | 先輩に教わる | 撮影(`push` — やめれば戻れる) |
/// | 締めた・穴がある | 埋めにいく穴 | 復習(無料。原価が発生しない側) |
/// | 締めた・穴が無い | 先輩に教わる(押せない) | — |
///
/// 締めた日の行き先を復習にしているのは、**上限に当たった人の道をホームで
/// 途切れさせない**ため(自習室が担っていた役目のうち、コアループの内側に
/// 元からあったのはこちら)。復習は既に見つかった穴を埋め直すだけなので、
/// 授業のような従量原価は発生しない。
class _PrimaryAction extends StatelessWidget {
  const _PrimaryAction({required this.enoughForToday, required this.hasOpenHoles});

  final bool enoughForToday;
  final bool hasOpenHoles;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    if (enoughForToday && hasOpenHoles) {
      return ChunkyButton(
        key: const ValueKey<String>('home-primary-review'),
        label: strings.reviewTitle,
        onPressed: () => context.push(AppRoute.review.path),
      );
    }

    return ChunkyButton(
      key: const ValueKey<String>('home-primary-lesson'),
      label: strings.homeLesson,
      onPressed: enoughForToday ? null : () => context.push(AppRoute.capture.path),
    );
  }
}

class _TopRow extends StatelessWidget {
  const _TopRow({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Row(
      children: <Widget>[
        // 数えている2つ。余白を持つのはこちらなので、Spacer は要らない。
        //
        // Premium のチップが並ぶぶん、横幅の狭い端末では入りきらなくなる。
        // 縮めば読めるものを RenderFlex の縞模様にしない — 入るときは
        // 何も起きず(scaleDown は等倍までしか拡げない)、入らないときだけ縮む。
        Expanded(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Row(
              children: <Widget>[
                _Counter(
                  value: progress.streakDays,
                  label: strings.streakDays(progress.streakDays),
                  color: AppColors.streak,
                ),
                const SizedBox(width: AppSpacing.md),
                _Counter(
                  value: progress.filledHoles,
                  label: strings.filledHoles(progress.filledHoles),
                  color: AppColors.blue,
                  tooltip: strings.parentReportOpen,
                  onTap: () => context.push(AppRoute.parentReport.path),
                ),
              ],
            ),
          ),
        ),
        // 契約している印。契約が無ければ何も出ない。
        const PremiumChip(),
      ],
    );
  }
}

/// きのうの続き。再訪の起点で、通知の着地先でもある。
///
/// 穴がゼロのときは代わりに「最初の1枚から始まる」と書く。
/// 初回起動のホームが、押すもののない空白にならないように。
///
/// 先輩が今日を締めた日は、すぐ下の [_PrimaryAction] も同じ復習画面へ行く。
/// **重ねているのは意図**で、このカードは「何が残っているか」を出す説明、
/// 下のボタンは「それをやる」操作。行き先が同じでも、読む順に並んでいる。
///
/// **穴の件数は出さない。** 未完了の数は、穴を資産ではなく借金に見せる。
/// 複数あるときも、次に向き合う内容が分かれば十分なので直近の1件だけを出す。
class _OpenHolesCard extends ConsumerWidget {
  const _OpenHolesCard({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    if (progress.openHoles == 0) {
      return Text(
        strings.homeFirstRun,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall,
      );
    }

    // キューの取得前・失敗時にも内容を出せるよう、会話直後のカルテも候補にする。
    // 両方に同じ穴がいても、日付で選ぶだけなので表示は1件のまま変わらない。
    final ReviewQueue? queue = ref.watch(reviewControllerProvider).value;
    final Karte? latestKarte = ref.watch(latestKarteControllerProvider);
    final Hole? recentHole = _mostRecentOpenHole(queue, latestKarte);

    return GestureDetector(
      onTap: () => context.push(AppRoute.review.path),
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.card),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: <Widget>[
            Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(color: AppColors.hole, shape: BoxShape.circle),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(strings.reviewTitle, style: Theme.of(context).textTheme.titleMedium),
                  Text(
                    recentHole?.description ?? strings.homeOpenHoleLabel,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: AppColors.inkMuted),
          ],
        ),
      ),
    );
  }

  Hole? _mostRecentOpenHole(ReviewQueue? queue, Karte? latestKarte) {
    Hole? mostRecent;
    final List<Hole> candidates = <Hole>[
      if (queue != null)
        for (final ReviewQueueItem item in queue.items) item.hole,
      if (latestKarte != null) ...latestKarte.holes,
    ];

    for (final Hole hole in candidates) {
      if (hole.status != HoleStatus.open) continue;
      if (mostRecent == null || hole.createdAt.isAfter(mostRecent.createdAt)) {
        mostRecent = hole;
      }
    }
    return mostRecent;
  }
}

/// 今日はここまで、という**先輩の判断**(§6-3)。
///
/// ここは以前「今日の無料セッション: 残り1回」を出していた場所。
/// **回数の数字は出さない**に変えた:
///   - 数字を見せた瞬間に、上限は「先生の判断」ではなく「制限」になる(約束4)
///   - 残りが見えていれば、ユーザーは残りの使い道を計算しはじめる。
///     今日いちばん聞きたい1問を、明日に取っておく理由を作ってしまう
///   - 通常利用(1日1〜2回)では一度も発火しない値にする設計なので、
///     そもそも普段は出す数字が無い
///
/// **残っているあいだは何も出さない。** 「まだ大丈夫です」も残数の匂わせになる。
/// 出すのは先輩が締めたときだけ。無料なら契約への道も置くが、Premium の
/// フェアユース上限では、すでに契約している人へ課金導線を重ねない。
///
/// 締めた日はあいさつも [AppStrings.homeGreetingDone] に変わっているので、
/// ここは**同じことを繰り返さない**説明に徹する(「今日はここまで」の理由)。
class _EnoughForTodayLine extends StatelessWidget {
  const _EnoughForTodayLine({required this.show, required this.showUpgrade});

  final bool show;
  final bool showUpgrade;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // 高さは空でも確保する。締められた瞬間にボタンが跳ね上がらないように。
    if (!show) return const SizedBox(height: AppSpacing.md);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          strings.lessonEnoughForToday,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (showUpgrade)
          TextButton(
            onPressed: () => context.push(AppRoute.paywall.path),
            style: TextButton.styleFrom(
              foregroundColor: AppColors.blue,
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
            ),
            child: Text(strings.homeUnlock, style: Theme.of(context).textTheme.bodySmall),
          ),
      ],
    );
  }
}

class _Counter extends StatelessWidget {
  const _Counter({
    required this.value,
    required this.label,
    required this.color,
    this.tooltip,
    this.onTap,
  });

  final int value;
  final String label;
  final Color color;
  final String? tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final Widget counter = Semantics(
      label: label,
      button: onTap != null,
      child: GestureDetector(
        key: onTap == null ? null : const ValueKey<String>('parent-report-link'),
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Row(
          children: <Widget>[
            // 数えているのはこの2つだけ(連続日数と埋めた穴)。
            // 増えたことが見えるように、0から数え上げる。
            CountUpText(
              value,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(color: color),
            ),
            const SizedBox(width: AppSpacing.xs),
            Text(label, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );

    // ホームへ新しいカードを足すと、狭い端末で今日の1手を下へ押し出す。
    // すでにレポートの中心指標である「埋めた穴」を入口にし、見た目の第三カウンターは
    // 作らない。Tooltipとbutton semanticsで、長押し・読み上げでは行き先も伝える。
    final String? message = tooltip;
    return message == null ? counter : Tooltip(message: message, child: counter);
  }
}
