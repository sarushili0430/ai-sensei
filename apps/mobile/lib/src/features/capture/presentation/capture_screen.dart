import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../session/domain/session.dart';
import '../application/capture_controller.dart';

/// 何を撮るか選ぶ → 撮る → 撮ったものの確認 → 単元と問題文の確認。
///
/// 検出した単元はチップで出し、**ユーザーが外せる**ようにする。
/// 写真解析が外したときに直せる余地を残すため。
///
/// ## カメラを自動で開かない理由
///
/// 以前はこの画面に入った瞬間に**ノートのカメラ**が開いていた。ノートがある
/// 生徒にはタップ0回で速かったが、**解けなくてノートが無い生徒は、問題の枠を
/// 一度も見ないままシャッターの前に立っていた**。手元にあるのは問題集だけなので、
/// そこで撮れば紙面がノート枠に入る — `api.ts` の `sessionPhotoParts` が
/// 「残る穴。防げるのは取り違える**動機**まで」と書いた、その動機がUI側に
/// 残っていた(他者の著作物がR2に保存され、先輩には `(ノートの写真なし)` ではなく
/// 紙面の中身が届く)。
///
/// 逃げ道(キャンセルすると枠が2つ見える)はあったが、**キャンセルは「やめる」に
/// 読める。**「ノートは無い」を言う操作としては誰も選ばない。
///
/// なので枠を先に見せ、どちらから撮るかを選んでもらう。ノートがある人には
/// 1タップ増えるが、**「ノートは無い」をシャッターの前に言えるのはここしかない。**
/// この画面はもともと「解析の前に一度止まる」を受け入れているので、
/// 止まる場所が1つ手前に伸びただけになる。
///
/// ## 解析の前に一度止まる理由
///
/// 撮ってすぐ解析していたのを、確認を1枚挟む形に変えた。
///
///   1. **問題の写真を足せるのは、解析の前だけ。** あとから足しても写真は
///      読み直されない(`capture_controller.dart` の `setProblemPhoto`)。
///      任意の2枚目に居場所を作るには、ここしかない
///   2. 撮った直後の1枚をそのまま送っていたので、ぶれていても気づけないまま
///      Vision LLMに通していた
///
/// **今日の1回を使うのはここではない。** 数えるのは会話が始まったときなので
/// (`api.ts` の `startSessionResponseSchema`)、解析まで進んでから撮り直しても
/// 授業の回数は減らない。
///
/// **どちらか1枚で始められる**(§4-1)。1枚に問題とノートの両方が写ることが
/// 多いので、2枚必須にすると撮影の摩擦だけが増える。ここで出すのは「撮れ」ではなく
/// 「写っていると迷子になりません」というヒントに留める。
class CaptureScreen extends ConsumerStatefulWidget {
  const CaptureScreen({super.key});

  @override
  ConsumerState<CaptureScreen> createState() => _CaptureScreenState();
}

/// 許可がないことを表す image_picker のエラーコード。
///
/// iOSは許可がないと **null を返さず例外を投げる**。撮影をやめたときと同じ
/// 「nullが返る」前提でいると、この経路が丸ごと抜ける。
const Set<String> _kPermissionErrorCodes = <String>{
  'camera_access_denied',
  'photo_access_denied',
  'invalid_source',
};

class _CaptureScreenState extends ConsumerState<CaptureScreen> {
  /// カメラを断られた。閉じるのではなく、戻し方を出す。
  bool _cameraDenied = false;

  /// 許可はあるのにカメラを開けなかった(端末側の理由)。撮り直しの導線を出す。
  bool _cameraFailed = false;

  /// カメラを開いている最中。まだ見せるものが無い。
  ///
  /// 「1枚も撮っていない」と区別が要る。撮らずに帰ってきた人には
  /// **枠を見せて留まってもらう**ので、写真の有無だけでは判断できない。
  ///
  /// 最初は立てておく。[reset] が次のフレームまで走らないので、寝かせて始めると
  /// **前回の写真が1フレームだけ見えてしまう**(コントローラは keepAlive)。
  bool _picking = true;

  /// 直近にカメラを開いた枠。開けなかったときの「もう一度」を同じ枠へ戻すため。
  ///
  /// カメラの自動起動をやめてからは、**どちらの枠から来たかは本人の選択**なので、
  /// 失敗のたびにノートへ引き戻すと、ノートが無い生徒を無い枠へ送り返すことになる。
  bool _lastPickWasProblem = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 前回の撮影を持ち越さない。コントローラは keepAlive なので、
      // ここで白紙に戻さないと前の問題の写真が次の授業に紛れ込む。
      ref.read(captureControllerProvider.notifier).reset();
      // **ここでカメラを開かない**(理由はクラスのコメント)。枠を見せて選ばせる。
      if (mounted) setState(() => _picking = false);
    });
  }

  /// ノートの写真。**必須ではない**(サーバは `kind: new` でどちらか1枚を要求する)。
  Future<void> _pickPhoto() => _pick(forProblem: false);

  /// 問題の写真。これだけでも始められる(§4-1)。
  Future<void> _pickProblemPhoto() => _pick(forProblem: true);

  Future<void> _pick({required bool forProblem}) async {
    setState(() {
      _cameraDenied = false;
      _cameraFailed = false;
      _picking = true;
      _lastPickWasProblem = forProblem;
    });

    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(
        source: ImageSource.camera,
        imageQuality: 85,
      );
    } on PlatformException catch (error, stack) {
      // ここで拾わないと、initState の postFrameCallback から呼んでいるぶん
      // 受け取り手がいないまま未処理例外になり、撮影画面ごと落ちる。
      debugPrint('カメラを開けませんでした(${error.code}): ${error.message}\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        if (_kPermissionErrorCodes.contains(error.code)) {
          _cameraDenied = true;
        } else {
          _cameraFailed = true;
        }
      });
      return;
    } on Object catch (error, stack) {
      // プラグインの想定外(ファイルの読み出し失敗など)。落とさずに撮り直させる。
      debugPrint('写真を取得できませんでした: $error\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        _cameraFailed = true;
      });
      return;
    }

    // 撮らずに帰ってきた。許可が無いなら設定への行き方を出す —
    // 何度カメラを開いても結果が同じなので、そこだけは別扱いにする。
    // **枠で出し分けない。** どちらの枠も本人が選んで開いたものなので、
    // 許可が無いことを片方でだけ知らせる理由が無い。
    //
    // **それ以外は、どこにも戻さずこの画面に留まる。**
    // 以前はホームへ降ろしていたが、降ろすと選び直せない —
    // ノートを撮ろうとしてやめた人が、問題の枠にたどり着けなくなる。
    // 本当にやめたい人は、この画面の戻るで降りられる(push で来ている)。
    if (picked == null) {
      if (!mounted) return;
      final PermissionStatus status = await _cameraStatus();
      if (!mounted) return;
      setState(() {
        _picking = false;
        _cameraDenied =
            status.isDenied || status.isPermanentlyDenied || status.isRestricted;
      });
      return;
    }

    if (!mounted) return;
    final CaptureController controller = ref.read(captureControllerProvider.notifier);
    if (forProblem) {
      controller.setProblemPhoto(File(picked.path));
    } else {
      // ここでは解析しない(理由はクラスのコメント)。
      controller.setPhoto(File(picked.path));
    }
    setState(() => _picking = false);
  }

  Future<void> _analyze() async {
    final String locale = Localizations.localeOf(context).languageCode;
    await ref.read(captureControllerProvider.notifier).analyze(locale: locale);
  }

  /// 外した単元を反映してから会話を始める。**今日の1回を使うのはここ。**
  ///
  /// 失敗したときの「もう一度」もここへ戻す(理由は [_body] のエラー分岐)。
  Future<void> _start() async {
    final String locale = Localizations.localeOf(context).languageCode;
    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .confirmAndStart(locale: locale);
    if (session != null && mounted) context.go(AppRoute.session.path);
  }

  /// 許可の照会も失敗しうる。ここで落とすと、撮影をやめただけの人まで巻き込む。
  Future<PermissionStatus> _cameraStatus() async {
    try {
      return await Permission.camera.status;
    } on Object catch (error) {
      debugPrint('カメラの許可を確認できませんでした: $error');
      return PermissionStatus.granted; // 許可の問題と決めつけず、ホームへ戻す
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final CaptureState state = ref.watch(captureControllerProvider);

    // 見出しは、いまユーザーが確かめているものに合わせる。
    // 写真を見ている段階で「この単元で合っていますか?」と出ていると、
    // まだ何も解析していないのに単元を聞かれているように読める。
    //
    // **1枚も撮っていないあいだは「撮れました」でもない。** ここで選んでいるのは
    // 何を撮るかで、そこに「ノートは無い」という答えが含まれている。
    final String title;
    if (state.analysis != null || state.isSubmitting) {
      title = strings.captureConfirmTitle;
    } else if (state.hasAnyPhoto) {
      title = strings.captureReviewTitle;
    } else {
      title = strings.captureChooseTitle;
    }

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: _body(state),
        ),
      ),
    );
  }

  Widget _body(CaptureState state) {
    final AppStrings strings = AppStrings.of(context);

    if (_cameraDenied) {
      return _ErrorView(
        message: strings.captureCameraDenied,
        retryLabel: strings.captureOpenSettings,
        onRetry: openAppSettings,
      );
    }

    if (_cameraFailed) {
      return _ErrorView(
        message: strings.captureCameraFailed,
        // 開けなかった枠へ戻す。ノートへ固定すると、ノートが無い生徒を
        // 無い枠へ送り返すことになる。
        onRetry: () => _pick(forProblem: _lastPickWasProblem),
      );
    }

    final ApiException? error = state.error;
    if (error != null) {
      final bool lessonLimitReached =
          error.isFreeLimitReached || error.isFairUseLimitReached;
      return _ErrorView(
        // 無料・Premiumのどちらも数値は見せず、先輩が今日の学習を締める。
        message: lessonLimitReached ? strings.lessonEnoughForToday : error.message,
        // 日ごとの上限は押し直しても変わらない。無料・Premium とも再試行させない。
        //
        // **解析まで進んでいたら、撮り直しではなく会話の開始をやり直す。**
        // ここを `_pick` に固定していると、[CaptureController.setPhoto] が
        // 解析済みの状態を守って写真を捨てるので、カメラだけが何度も開いて
        // エラーが消えない画面になる。しかも会話の開始で落ちた場合は、
        // サーバ側で枠を押さえていることがあり、撮り直すとその1回を捨てる。
        // `/start` は同じIDなら二重に数えないので、押し直すほうが正しい
        // (セッションごと消えていれば `analysis` も捨てられ、撮り直しに戻る)。
        onRetry: lessonLimitReached
            ? null
            : state.analysis != null
                ? _start
                // 撮り直すのは、直前に開いていた枠(ノートとは限らない)。
                : () => _pick(forProblem: _lastPickWasProblem),
      );
    }
    // カメラを開いている最中は、まだ何も見せるものが無い。
    // **写真の有無では判断しない** — 1枚も撮っていない状態にも枠を出すので。
    if (state.isSubmitting || _picking) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.analysis == null) {
      return _PhotoReview(
        state: state,
        onRetake: _pickPhoto,
        onAddProblem: _pickProblemPhoto,
        onStart: _analyze,
      );
    }
    return _TopicConfirm(state: state, onStart: _start);
  }
}

/// 何を撮るかを選ぶ画面であり、撮ったものの確認でもある。
/// **解析(= Vision LLMに通す)の直前に一度だけ止まる。**
///
/// 2つの枠を並べているのは見た目のためではない。ノートはR2に保存され、
/// 問題の紙面は解析後に破棄される — **どちらの枠に入れたかでしか区別できない**
/// ので、枠を見せることがそのまま破棄の前提になる(計画書 §4-1)。
/// だからこの画面は**1枚目より先に**出る(理由は [CaptureScreen] のコメント)。
///
/// **どちらか1枚あれば始められる。止めるのは両方空のときだけ。**
/// ノートを必須にしているかぎり、手も付けていない問題を持ってきた生徒は
/// 紙面をノート枠に入れるしかなく、破棄の約束が自分たちのUI制約で破れる。
///
/// ただし**ノートの枠を「任意」に見せ替えてはいない。** ノートがあるほうが
/// 良いことは変わっていない(先輩が切り分けの出発点を得られる)ので、
/// 見出しはそのまま。**無いことを咎める文言も出さない** —
/// ノートが無い生徒にとって、それは直しようのない指摘になる。
///
/// ## ヒントを埋まり方で出し分ける
///
/// 出す言葉が要る人が2人いて、要る言葉が逆を向いている:
///
///   - まだ1枚も無い人 … **「ノートが無くてもいい」を先に言う。** ここで黙ると、
///     解けなかった生徒は紙面をノート枠に入れる(前へ進む道が他に見えない)
///   - ノートだけ撮った人 … 問題も撮ると先輩が迷子にならない、と促す
///
/// 両方を常時並べると、どちらの人にも半分は関係のない文章になる。
/// **どちらも撮る前に出る言葉なので、§4-1 の「警告にしない」は保たれている**
/// (`api.ts` の `problemSources` が言う、解析後に出すと2枚目が事実上の必須に
/// なる、という話とは別の軸)。
class _PhotoReview extends StatelessWidget {
  const _PhotoReview({
    required this.state,
    required this.onRetake,
    required this.onAddProblem,
    required this.onStart,
  });

  final CaptureState state;
  final VoidCallback onRetake;
  final VoidCallback onAddProblem;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // 空の枠に合わせて、要る言葉だけを出す(理由はクラスのコメント)。
    final String? hint;
    if (!state.hasAnyPhoto) {
      hint = strings.captureEitherIsFine;
    } else if (state.problemPhoto == null) {
      hint = strings.captureProblemHint;
    } else {
      hint = null;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: _PhotoSlot(
                  label: strings.capturePhotoNotes,
                  photo: state.photo,
                  emptyLabel: strings.captureTakeNotes,
                  onTap: onRetake,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: _PhotoSlot(
                  label: strings.capturePhotoProblem,
                  photo: state.problemPhoto,
                  emptyLabel: strings.captureAddProblem,
                  onTap: onAddProblem,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        // **促しであって要求ではない。** 撮っていなくても下のボタンは押せる。
        if (hint != null) ...<Widget>[
          Text(
            hint,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.xs),
        ],
        Text(
          strings.captureProblemDiscarded,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
        // 両方空のときだけ押せない。**押せない理由は書かない** —
        // 空の枠が2つ見えていて、どちらもその場で撮れる。上のヒントが
        // 「どちらか1枚で始められる」と言っているので、文章で足すことは無い。
        ChunkyButton(
          label: strings.captureStart,
          onPressed: state.hasAnyPhoto ? onStart : null,
        ),
      ],
    );
  }
}

/// 写真1枚ぶんの枠。空のときは撮る、入っているときは撮り直す。
class _PhotoSlot extends StatelessWidget {
  const _PhotoSlot({
    required this.label,
    required this.photo,
    required this.emptyLabel,
    required this.onTap,
  });

  final String label;
  final File? photo;

  /// まだ撮っていないときの操作名。撮ったあとは「撮り直す」に変わる。
  final String emptyLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final File? file = photo;
    final String actionLabel = file == null ? emptyLabel : AppStrings.of(context).captureRetake;

    return Semantics(
      button: true,
      label: '$label・$actionLabel',
      child: GestureDetector(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(label, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.xs),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(AppRadius.card),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    border: Border.all(color: AppColors.border),
                    borderRadius: BorderRadius.circular(AppRadius.card),
                  ),
                  child: file == null
                      ? const Center(
                          child: Icon(
                            Icons.add_a_photo_outlined,
                            color: AppColors.inkMuted,
                          ),
                        )
                      // 撮ったものが判別できればよいので、拡大せず全体を入れる。
                      : Image.file(file, fit: BoxFit.cover),
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              actionLabel,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.blue),
            ),
          ],
        ),
      ),
    );
  }
}

class _TopicConfirm extends ConsumerWidget {
  const _TopicConfirm({required this.state, required this.onStart});

  final CaptureState state;

  /// 会話を始める。失敗したときの「もう一度」も同じ操作へ戻る。
  final Future<void> Function() onStart;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final SessionProblem? problem = state.problem;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // **読む側だけスクロールさせ、始めるボタンは折り返しの上に固定する。**
        //
        // 問題文は契約の上限で600字まで来る(`problemTextMaxLength`)。
        // `Spacer` で下に押し付ける作りのままだと、長い問題文が入った瞬間に
        // ボタンが画面の外へ出ていた(実測: 375×667 で557px はみ出し)。
        // **上限は例外ではなく仕様の一部**なので、収まる前提にはできない。
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                // **読めたときも、読めなかったときも出す。**
                //
                // 読めなかったときに黙って通していたのが、外部テスターの
                // 唯一の不満の入口だった — 誰も何も言わないまま授業が始まり、
                // 先輩の一言目が「問題、読んでもらってもいい?」になる。
                // **画面に問題が見えているのに、声で言い直させられる。**
                //
                // かといって警告にはしない。撮り直さないと消えない警告は
                // 任意のはずの2枚目を事実上の必須にするので([_ProblemUnread])、
                // 出すのは事実と、**撮り直さずに済む道**(手入力)。
                if (problem != null) ...<Widget>[
                  _ProblemReadback(problem: problem),
                  const SizedBox(height: AppSpacing.lg),
                ] else if (state.problemUnread) ...<Widget>[
                  _ProblemUnread(outcome: state.problemOutcome),
                  const SizedBox(height: AppSpacing.lg),
                ],
                Text(strings.captureConfirmHint, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: AppSpacing.md),
                Wrap(
                  spacing: AppSpacing.sm,
                  runSpacing: AppSpacing.sm,
                  children: state.topics
                      .map(
                        (DetectedTopic topic) => _TopicChip(
                          topic: topic,
                          selected: state.isSelected(topic.topicId),
                          onTap: () => ref
                              .read(captureControllerProvider.notifier)
                              .toggleTopic(topic.topicId),
                        ),
                      )
                      .toList(growable: false),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        // 外した単元は始める前に反映される。飛ばすと、サーバ側のセッションは
        // 解析時のままで、外した単元を先輩が教えてしまう([CaptureController]）。
        ChunkyButton(
          label: strings.captureStart,
          onPressed: state.canStart ? onStart : null,
        ),
      ],
    );
  }
}

/// 読み取った問題文の読み合わせ。**授業が始まる前の、誤読の関所。**
///
/// 15分教わったあとに「それ別の問題です」と気づくのと、始まる前に気づくのとでは
/// 価値がまったく違う(計画書 §1-1「AIが理解している建て付けのアプリほど
/// 誤読が致命傷になる」)。
///
/// **合っているかは問わない。直す口だけ置く。** 問いかけにすると全員が
/// 答えを求められ、合っている人にも一手増える。ちがう人だけが「直す」を押せばよい。
///
/// 直す道ができるまで、誤読の保険は「会話の最初に本人が言う」だけだった —
/// 訂正のために授業の頭を1往復使っていたことになる。
/// (授業の回数を数えるのは会話が始まったときなので、直しても撮り直しても
/// 今日の1回は減らない。)
class _ProblemReadback extends StatelessWidget {
  const _ProblemReadback({required this.problem});

  final SessionProblem problem;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return _ProblemPanel(
      title: strings.captureProblemTitle,
      actionLabel: strings.captureProblemEdit,
      // 打ち直しではなく**直し**なので、読み取った文を入れた状態から始める。
      initialText: problem.text,
      children: <Widget>[
        // 長い問題文(契約の上限は600字)でも、ここだけで送りきる。
        // 折りたたむと、読み合わせという目的そのものが消える。
        Text(problem.text, style: Theme.of(context).textTheme.bodyLarge),
      ],
    );
  }
}

/// 問題文が読めなかったことを言う。**警告ではなく、事実と道。**
///
/// 出さずに黙って通していたのが、外部テスターの唯一の不満(「アプリに問題が
/// 見えているのに、先輩に質問を言い直させられる」)の入口だった。
/// 読めなかったことを誰もユーザーに伝えないまま授業が始まり、
/// 板書プロンプトの指示どおり先輩が「問題、読んでもらってもいい?」から始める。
///
/// **それでも警告にはしない。** 「読み取れませんでした。撮り直してください」は
/// 撮り直さないと消えないので、**任意のはずの2枚目が事実上の必須になる**
/// (`api.ts` の `problemSources` が「解析後にヒントを出すと必須化する」と
/// 決めたのと同じ話)。だから置くのは3つだけ:
///
///   1. 読み取れなかったという事実
///   2. 落ち方に合った一言(紙面を丸ごと撮っている / 答えが写っている …)
///   3. **撮り直さずに済む道** — その場で打つ
///
/// 3があるので、2は責めにならずに済んでいる。撮り直す気が無い人も、
/// 打てば先輩に聞き直されない。
class _ProblemUnread extends StatelessWidget {
  const _ProblemUnread({required this.outcome});

  /// 落ち方。写真を読んでいなければ(復習)そもそもこのウィジェットは出ない。
  final ProblemOutcome? outcome;

  /// 落ち方ごとの一言。**畳んで1本にしない**(理由はクラスのコメント)。
  String _detail(AppStrings strings) {
    switch (outcome) {
      case ProblemOutcome.tooLong:
        return strings.captureProblemUnreadTooLong;
      case ProblemOutcome.solutionIncluded:
        return strings.captureProblemUnreadSolutionIncluded;
      case ProblemOutcome.notAProblem:
        return strings.captureProblemUnreadNotAProblem;
      // 写っていなかった。**ここだけは直し方が言えない** — 写っていない理由は
      // 撮り方かもしれないし、そもそも問題を撮っていないのかもしれない。
      // 当て推量で撮り直しを促すより、このままでも始められることを言う。
      case ProblemOutcome.notFound:
      // 読めている / 写真を読んでいない。**このウィジェットはそもそも出ない**
      // ([SessionAnalysis.problemUnread])。switch を網羅させるためだけの枝。
      case ProblemOutcome.read:
      case null:
        return strings.captureProblemUnreadNotFound;
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return _ProblemPanel(
      title: strings.captureProblemUnreadTitle,
      actionLabel: strings.captureProblemEnter,
      initialText: '',
      children: <Widget>[
        Text(_detail(strings), style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

/// 問題文まわりの枠。読めた側と読めなかった側で、**同じ見た目にする。**
///
/// 読めなかったほうだけ色や記号を変えると、それは注意書きではなく警告になる
/// (= 撮り直しの催促)。言葉だけを変えて、枠は同じにしておく。
class _ProblemPanel extends ConsumerWidget {
  const _ProblemPanel({
    required this.title,
    required this.actionLabel,
    required this.initialText,
    required this.children,
  });

  final String title;

  /// 入力を開く操作名。読めていれば「直す」、読めていなければ「入力する」。
  final String actionLabel;

  /// 入力欄の初期値。訂正なら読み取った文、手入力なら空。
  final String initialText;

  final List<Widget> children;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          ...children,
          const SizedBox(height: AppSpacing.sm),
          // **控えめに置く。** 押さなくても授業は始められる(下のボタンは生きている)。
          //
          // 見た目は控えめでも、**当たり判定は控えめにしない。** 文字だけを
          // 対象にすると指1本ぶんに満たないので、余白ごと拾う。
          Align(
            alignment: Alignment.centerLeft,
            child: Semantics(
              button: true,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => _openEditor(context, ref),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
                  child: Text(
                    actionLabel,
                    style: Theme.of(context)
                        .textTheme
                        .bodyMedium
                        ?.copyWith(color: AppColors.blue, fontWeight: FontWeight.w700),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _openEditor(BuildContext context, WidgetRef ref) async {
    final String locale = Localizations.localeOf(context).languageCode;
    await showModalBottomSheet<void>(
      context: context,
      // キーボードのぶんだけ持ち上げる。既定の高さのままだと、入力欄が
      // キーボードの裏に隠れて、打っている文字が見えない。
      isScrollControlled: true,
      builder: (BuildContext sheetContext) => _ProblemEditor(
        initialText: initialText,
        onSubmit: (String text) =>
            ref.read(captureControllerProvider.notifier).submitProblemText(text, locale: locale),
      ),
    );
  }
}

/// 問題文を打つ場所。
///
/// **通らなかったときに画面を差し替えない。** 打った文が問題文として通らないのは
/// (設問が入っていない・答えが混ざっている)直せる失敗なので、全画面のエラーに
/// 飛ばすと、書いた文ごと消える。文言は入力欄の下に出して、続きから直させる。
class _ProblemEditor extends StatefulWidget {
  const _ProblemEditor({required this.initialText, required this.onSubmit});

  final String initialText;

  /// 送る。戻り値が null なら閉じてよい(通ったか、画面側がエラーを引き取ったか)。
  final Future<ApiException?> Function(String text) onSubmit;

  @override
  State<_ProblemEditor> createState() => _ProblemEditorState();
}

class _ProblemEditorState extends State<_ProblemEditor> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialText);

  /// サーバが返した文言。**そのまま出す**(煽らない文体で書かれている)。
  String? _message;
  bool _sending = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_controller.text.trim().isEmpty) return;
    setState(() {
      _sending = true;
      _message = null;
    });

    final ApiException? error = await widget.onSubmit(_controller.text);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _sending = false;
      _message = error.message;
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String? message = _message;

    return Padding(
      // キーボードのぶんだけ持ち上げる。
      padding: EdgeInsets.only(
        left: AppSpacing.lg,
        right: AppSpacing.lg,
        top: AppSpacing.lg,
        bottom: MediaQuery.viewInsetsOf(context).bottom + AppSpacing.lg,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(strings.captureProblemInputTitle, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xs),
          Text(strings.captureProblemInputHint, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _controller,
            autofocus: true,
            // 手で打つ問題文は複数行になる(小問つきなら数行)。
            minLines: 3,
            maxLines: 6,
            // サーバと同じ上限。ここで止めるのは体裁の話で、判定は向こうが持つ。
            maxLength: problemTextMaxLength,
            textInputAction: TextInputAction.newline,
            keyboardType: TextInputType.multiline,
            decoration: const InputDecoration(border: OutlineInputBorder()),
            onChanged: (_) {
              // 直しはじめたら、前の指摘は消す。残すと、直したのに
              // 通らなかったように見える。
              if (_message != null) setState(() => _message = null);
            },
          ),
          if (message != null) ...<Widget>[
            // **赤くしない・記号を付けない。** サーバの文言は煽らない文体で
            // 書かれていて(`errors.ts`)、直せる失敗を叱る見た目にすると、
            // 打つのをやめて先輩に聞き直される元の体験へ戻る。
            Text(
              message,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.ink),
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          ChunkyButton(
            label: strings.captureProblemInputSave,
            onPressed: _sending ? null : _submit,
          ),
          GhostButton(
            label: strings.captureProblemInputCancel,
            onPressed: _sending ? null : () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

class _TopicChip extends StatelessWidget {
  const _TopicChip({required this.topic, required this.selected, required this.onTap});

  final DetectedTopic topic;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        // **1チップが画面幅を超えうる。** 「中1 データの分布とヒストグラム」の
        // ように、学年ラベルが付いたぶん長い単元名は 375px に収まらない。
        // 上限を切って折り返す(切り詰めない — どの単元か読めなくなる)。
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width - AppSpacing.xl * 2),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(
          color: selected ? AppColors.blue : AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.chip),
          border: Border.all(color: selected ? AppColors.blue : AppColors.border),
        ),
        // 「中1 正負の数」「数学I 二次関数」。学年か科目かは課程で決まっていて、
        // サーバが `label` に入れてくる(ADR 0007)。
        child: Text(
          '${topic.label} ${topic.topic}',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: selected ? Colors.white : AppColors.inkMuted,
              ),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, this.onRetry, this.retryLabel});

  final String message;
  final VoidCallback? onRetry;
  final String? retryLabel;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        // サーバの文言をそのまま出す。煽らない文体で書かれている。
        Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: AppSpacing.lg),
        if (onRetry != null)
          ChunkyButton(label: retryLabel ?? strings.errorRetry, onPressed: onRetry),
        GhostButton(label: strings.karteDone, onPressed: context.closeOrGoHome),
      ],
    );
  }
}
