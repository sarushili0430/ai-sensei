import 'dart:async';

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

/// ホーム。カメラの起動ボタンではなく**ハブ**。
///
/// - 数えるのは連続日数と解けた問題だけ。XP・レベル・偏差値は出さない(§5-2)
/// - 入口は2つ。今日の1手([_PrimaryAction])と、復習問題([_OpenProblemsCard])
/// - **下に置く操作はいつでも1つ**。並べず、同じ場所の中身を入れ替える
/// - 授業回数は出さず、原価と同じ「今日の残り時間」だけを出す
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  @override
  void initState() {
    super.initState();

    final AsyncValue<ProgressSummary> progress = ref.read(progressControllerProvider);
    // 初回表示は provider の build が同じ値を取得する。すでに値があるのは、
    // 授業の外側ルートからホームのシェルが作り直されたときなので、その境界だけ
    // サーバを正として再確認する。毎フレーム呼ぶと画面を開いているだけで通信が増える。
    if (progress.value != null) {
      unawaited(ref.read(progressControllerProvider.notifier).reloadQuietly());
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final AsyncValue<ProgressSummary> summary = ref.watch(progressControllerProvider);
    final ProgressSummary data = summary.value ?? ProgressSummary.empty;
    final int remainingSecondsToday = data.limits.remainingSecondsToday;
    // 0秒は直下の「使い切った」説明と同じ状態なので、残っているように読める
    // 「1分未満」にはしない。上は0分、下は理由という並びなら矛盾せず読める。
    final String remainingTime = remainingSecondsToday > 0 && remainingSecondsToday < 60
        ? strings.homeRemainingLessThanMinute
        : strings.homeRemainingMinutes(remainingSecondsToday ~/ 60);

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
              if (summary.value != null)
                FadeSlideIn(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      remainingTime,
                      key: const ValueKey<String>('home-remaining-time'),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ),
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
              FadeSlideIn.staggered(
                index: 2,
                child: _OpenProblemsCard(progress: data.progress),
              ),
              const SizedBox(height: AppSpacing.md),
              FadeSlideIn.staggered(
                index: 3,
                child: _PrimaryAction(
                  enoughForToday: enoughForToday,
                  hasOpenProblems: data.progress.openProblems > 0,
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              FadeSlideIn.staggered(
                index: 4,
                child: _EnoughForTodayLine(
                  enoughForToday: enoughForToday,
                  // 契約への道は**締めた日だけのものにしない**。無料は1日1回に
                  // なったので、使い切る前に「もっと教わる」を探す人のほうが多い。
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
/// **並べない。差し替える。** 2本並べると、押せるほうを色で見分けさせることになる。
///
/// | 状態 | ラベル | 行き先 |
/// | --- | --- | --- |
/// | 授業ができる | 先輩に教わる | 撮影(`push` — やめれば戻れる) |
/// | 締めた・穴がある | 埋めにいく穴 | 復習(無料。原価が出ない側) |
/// | 締めた・穴が無い | 先輩に教わる(押せない) | — |
///
/// 締めた日を復習へ向けるのは、上限に当たった人の道を途切れさせないため。
class _PrimaryAction extends StatelessWidget {
  const _PrimaryAction({
    required this.enoughForToday,
    required this.hasOpenProblems,
  });

  final bool enoughForToday;
  final bool hasOpenProblems;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    if (enoughForToday && hasOpenProblems) {
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
        // **数えている2つは、左端と右端に離して置く**(キャンバスの
        // `justify-content: space-between`)。隣り合わせると
        // 「3日つづけて12問解けた」と1つの文に読めてしまい、別々の数だと
        // 分かるまでに一拍かかる。
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
                // 炎はキャンバスの形。**数字だけだと何の数か読まないと分からない**
                // ので、連続日数の側にだけ印を付ける(解けた問題の側は色で分ける)。
                const CustomPaint(
                  size: Size.square(20),
                  painter: _StreakFlamePainter(),
                ),
                const SizedBox(width: AppSpacing.sm),
                _Counter(
                  value: progress.streakDays,
                  suffix: strings.streakDaysSuffix,
                  semanticsLabel: strings.streakDays(progress.streakDays),
                  color: AppColors.streak,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerRight,
          child: _Counter(
            value: progress.solvedProblems,
            prefix: strings.solvedProblemsPrefix,
            suffix: strings.solvedProblemsSuffix,
            semanticsLabel: strings.solvedProblems(progress.solvedProblems),
            color: AppColors.blue,
            tooltip: strings.parentReportOpen,
            onTap: () => context.push(AppRoute.parentReport.path),
          ),
        ),
        // 契約している印。契約が無ければ何も出ない。
        const PremiumChip(),
      ],
    );
  }
}

/// 復習問題。再訪の起点で、通知の着地先でもある。
///
/// 問題がゼロのときは代わりに「最初の1枚から始まる」と書く。
/// 初回起動のホームが、押すもののない空白にならないように。
///
/// 先輩が今日を締めた日は、すぐ下の [_PrimaryAction] も同じ復習画面へ行く。
/// **重ねているのは意図**で、このカードは「何が残っているか」を出す説明、
/// 下のボタンは「それをやる」操作。行き先が同じでも、読む順に並んでいる。
///
/// **問題の件数は出す。** 穴では件数が借金に見えたが、問題は解けば減る有限の
/// 作業量なので、残りを隠すより「何問やればよいか」が分かるほうが着手しやすい。
class _OpenProblemsCard extends ConsumerWidget {
  const _OpenProblemsCard({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);

    if (progress.openProblems == 0) {
      return Text(
        strings.homeFirstRun,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall,
      );
    }

    final PracticeQueue? queue = ref.watch(reviewControllerProvider).value;
    final PracticeQueueItem? next = queue?.items.firstOrNull;

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
            // キャンバスの 40pt の丸。**8pt の点から替えた** — 穴のカードは
            // 「何かが残っている」を示す点で足りたが、復習問題のカードは
            // 押して解きにいく操作なので、掴める大きさの印を置く。
            Container(
              width: 40,
              height: 40,
              decoration: const BoxDecoration(
                color: AppColors.said,
                shape: BoxShape.circle,
              ),
              child: const Center(
                child: CustomPaint(
                  size: Size.square(20),
                  painter: _PracticeMarkPainter(),
                ),
              ),
            ),
            // キャンバスの gap。`AppSpacing` の刻み(8/16)の中間で、
            // 40pt の丸と本文のあいだだけこの値。
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    strings.homeOpenProblems(progress.openProblems),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text(
                    next == null
                        ? strings.homeOpenProblemLabel
                        : strings.homePracticeSource(
                            next.daysSince,
                            next.topicLabel,
                          ),
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

}

/// 今日はここまで、という**先輩の判断**と、契約への道。
///
/// 残り時間の数字は画面上部の状態表示に限り、先輩の発話には混ぜない。
/// 締めた日はあいさつも [AppStrings.homeGreetingDone] に変わっているので、
/// 説明の一行は**同じことを繰り返さない**(「今日はここまで」の理由)。
///
/// **契約への道は、締めた日だけのものにしない。** 無料が1日1回になったので、
/// 使い切る前に「もっと教わりたい」と思う人のほうが多い。ただし主役にはしない —
/// 出すのは薄いテキストボタン1つで、下の厚いボタン([_PrimaryAction])の
/// 重さは越えさせない。Premium のフェアユース上限では、
/// すでに契約している人へ課金導線を重ねない(置く側が [showUpgrade] で決める)。
class _EnoughForTodayLine extends StatelessWidget {
  const _EnoughForTodayLine({
    required this.enoughForToday,
    required this.showUpgrade,
  });

  final bool enoughForToday;
  final bool showUpgrade;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // 高さは空でも確保する。締められた瞬間にボタンが跳ね上がらないように。
    if (!enoughForToday && !showUpgrade) return const SizedBox(height: AppSpacing.md);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (enoughForToday)
          Text(
            strings.lessonEnoughForToday,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        if (showUpgrade)
          TextButton(
            key: const ValueKey<String>('home-unlock'),
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

/// 数えている1つ。
///
/// **数字を描くのは [CountUpText] だけ。** ラベルにも数を入れると、数え上がった
/// 数字の隣に同じ数がもう一度出る(「3 3日つづけて説明中」)。文字列は数字の
/// 前([prefix])と後ろ([suffix])に分けて受け取り、間の空白も文字列側が持つ。
///
/// 読み上げだけは分けない。[semanticsLabel] に数字入りの全文を渡し、
/// 中身は捨てる(数え上げの途中の数も、切れたラベルも読ませない)。
class _Counter extends StatelessWidget {
  const _Counter({
    required this.value,
    required this.semanticsLabel,
    required this.color,
    this.prefix = '',
    this.suffix = '',
    this.tooltip,
    this.onTap,
  });

  final int value;
  final String semanticsLabel;
  final Color color;
  final String prefix;
  final String suffix;
  final String? tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final TextTheme textTheme = Theme.of(context).textTheme;
    final Widget counter = Semantics(
      label: semanticsLabel,
      button: onTap != null,
      excludeSemantics: true,
      child: GestureDetector(
        key: onTap == null ? null : const ValueKey<String>('parent-report-link'),
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Row(
          children: <Widget>[
            if (prefix.isNotEmpty) Text(prefix, style: textTheme.bodySmall),
            // 数えているのはこの2つだけ(連続日数と解けた問題)。
            // 増えたことが見えるように、0から数え上げる。
            CountUpText(value, style: textTheme.titleLarge?.copyWith(color: color)),
            if (suffix.isNotEmpty) Text(suffix, style: textTheme.bodySmall),
          ],
        ),
      ),
    );

    // ホームへ新しいカードを足すと、狭い端末で今日の1手を下へ押し出す。
    // すでにレポートの中心指標である「解けた問題」を入口にし、見た目の第三カウンターは
    // 作らない。Tooltipとbutton semanticsで、長押し・読み上げでは行き先も伝える。
    final String? message = tooltip;
    return message == null ? counter : Tooltip(message: message, child: counter);
  }
}

/// 連続日数の炎。**フォントの絵文字に任せない** — 端末ごとに別の絵が出るし、
/// 色も指定できない(`session_screen.dart` の × と同じ理由)。
class _StreakFlamePainter extends CustomPainter {
  const _StreakFlamePainter();

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.width / 20;
    final Path path = Path()
      ..moveTo(10 * s, 2.5 * s)
      ..cubicTo(12.2 * s, 5.1 * s, 13.3 * s, 7.1 * s, 13.3 * s, 8.6 * s)
      // 内側のえぐり(`a3.3 3.3 0 0 1 -6.6 0`)。sweep-flag が 1 なので既定のまま。
      ..arcToPoint(Offset(6.7 * s, 8.6 * s), radius: Radius.circular(3.3 * s))
      ..cubicTo(6.7 * s, 7.8 * s, 7.0 * s, 7.0 * s, 7.5 * s, 6.1 * s)
      ..cubicTo(6.2 * s, 7.5 * s, 5 * s, 9.4 * s, 5 * s, 11.4 * s)
      // **外側の弧だけ反時計回り**(`a5 5 0 0 0 10 0`。sweep-flag が 0)。
      // 既定の時計回りのままだと胴が上へ折り返して、炎が目のような形に潰れる。
      ..arcToPoint(
        Offset(15 * s, 11.4 * s),
        radius: Radius.circular(5 * s),
        clockwise: false,
      )
      ..cubicTo(15 * s, 8.4 * s, 13.3 * s, 5.4 * s, 10 * s, 2.5 * s)
      ..close();
    canvas.drawPath(path, Paint()..color = AppColors.streak);
  }

  @override
  bool shouldRepaint(_StreakFlamePainter oldDelegate) => false;
}

/// 復習カードの印。**問題が並んでいること**を、3本の線で示す。
class _PracticeMarkPainter extends CustomPainter {
  const _PracticeMarkPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.width / 20;
    final Paint paint = Paint()
      ..color = AppColors.ink
      ..strokeWidth = 2 * s
      ..strokeCap = StrokeCap.round;
    canvas
      ..drawLine(Offset(4 * s, 5.5 * s), Offset(16 * s, 5.5 * s), paint)
      ..drawLine(Offset(4 * s, 10 * s), Offset(16 * s, 10 * s), paint)
      // 3本目だけ短い。同じ長さで揃えると「表」に見えて、問題の列に見えない。
      ..drawLine(Offset(4 * s, 14.5 * s), Offset(11 * s, 14.5 * s), paint);
  }

  @override
  bool shouldRepaint(_PracticeMarkPainter oldDelegate) => false;
}
