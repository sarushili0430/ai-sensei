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

/// 撮影 → 撮ったものの確認 → 単元と問題文の確認。
///
/// 検出した単元はチップで出し、**ユーザーが外せる**ようにする。
/// 写真解析が外したときに直せる余地を残すため(handoff §3-1)。
///
/// ## 解析の前に一度止まる理由
///
/// 撮ってすぐ解析していたのを、確認を1枚挟む形に変えた。理由は2つあり、
/// どちらも**解析がセッションを作る = 今日の1回を使う**ことから来ている:
///
///   1. **問題の写真を足せるのは、解析の前だけ。** あとから足して解析し直すと
///      2回目のセッション扱いになり、無料枠を食う(`confirmAndStart` の
///      コメントと同じ理由)。任意の2枚目に居場所を作るには、ここしかない
///   2. 撮った直後の1枚をそのまま送っていたので、ぶれていても気づけないまま
///      今日の1回が消えていた
///
/// **2枚目は任意のまま**(§4-1)。1枚に問題とノートの両方が写ることが多いので、
/// 必須にすると撮影の摩擦だけが増える。ここで出すのは「撮れ」ではなく
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
  bool _picking = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // 前回の撮影を持ち越さない。コントローラは keepAlive なので、
      // ここで白紙に戻さないと前の問題の写真が次の授業に紛れ込む。
      ref.read(captureControllerProvider.notifier).reset();
      _pickPhoto();
    });
  }

  /// ノートの写真。**必須**(サーバが `kind: new` で要求する)。
  Future<void> _pickPhoto() => _pick(forProblem: false);

  /// 問題の写真。**任意**(§4-1)。撮らなくても先へ進める。
  Future<void> _pickProblemPhoto() => _pick(forProblem: true);

  Future<void> _pick({required bool forProblem}) async {
    setState(() {
      _cameraDenied = false;
      _cameraFailed = false;
      _picking = true;
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
    //
    // **それ以外は、どこにも戻さずこの画面に留まる。**
    // 以前はホームへ降ろしていたが、ノートを撮らない経路ができたいま、
    // 1枚目をやめることは「やめる」ではなく**「ノートは無い」**を意味しうる。
    // 降ろしてしまうと、手も付けていない問題を持ってきた生徒が
    // 問題の枠にたどり着けない(枠は空のまま出るので、そこから撮れる)。
    // 本当にやめたい人は、この画面の戻るで降りられる(push で来ている)。
    if (picked == null) {
      if (!mounted) return;
      if (forProblem) {
        setState(() => _picking = false);
        return;
      }
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
    final bool reviewing = state.session == null && !state.isSubmitting;

    return Scaffold(
      appBar: AppBar(
        title: Text(reviewing ? strings.captureReviewTitle : strings.captureConfirmTitle),
      ),
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
      return _ErrorView(message: strings.captureCameraFailed, onRetry: _pickPhoto);
    }

    final ApiException? error = state.error;
    if (error != null) {
      final bool lessonLimitReached =
          error.isFreeLimitReached || error.isFairUseLimitReached;
      return _ErrorView(
        // 無料・Premiumのどちらも数値は見せず、先輩が今日の学習を締める。
        message: lessonLimitReached ? strings.lessonEnoughForToday : error.message,
        // 日ごとの上限は押し直しても変わらない。無料・Premium とも再試行させない。
        onRetry: lessonLimitReached ? null : _pickPhoto,
      );
    }
    // カメラを開いている最中は、まだ何も見せるものが無い。
    // **写真の有無では判断しない** — 1枚も撮っていない状態にも枠を出すので。
    if (state.isSubmitting || _picking) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.session == null) {
      return _PhotoReview(
        state: state,
        onRetake: _pickPhoto,
        onAddProblem: _pickProblemPhoto,
        onStart: _analyze,
      );
    }
    return _TopicConfirm(state: state);
  }
}

/// 撮ったものの確認。**解析(= 今日の1回を使う)の直前に一度だけ止まる。**
///
/// 2つの枠を並べているのは見た目のためではない。ノートはR2に保存され、
/// 問題の紙面は解析後に破棄される — **どちらの枠に入れたかでしか区別できない**
/// ので、枠を見せることがそのまま破棄の前提になる(計画書 §4-1)。
///
/// **どちらか1枚あれば始められる。止めるのは両方空のときだけ。**
/// ノートを必須にしているかぎり、手も付けていない問題を持ってきた生徒は
/// 紙面をノート枠に入れるしかなく、破棄の約束が自分たちのUI制約で破れる。
///
/// ただし**ノートの枠を「任意」に見せ替えてはいない。** ノートがあるほうが
/// 良いことは変わっていない(先輩が切り分けの出発点を得られる)ので、
/// 見出しはそのまま。**無いことを咎める文言も出さない** —
/// ノートが無い生徒にとって、それは直しようのない指摘になる。
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
        Text(
          strings.captureProblemHint,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          strings.captureProblemDiscarded,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
        // 両方空のときだけ押せない。**押せない理由は書かない** —
        // 空の枠が2つ見えていて、どちらもその場で撮れるので、
        // 文章で足すことは何も無い。
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
  const _TopicConfirm({required this.state});

  final CaptureState state;

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
                // **読めているときだけ出す。読めていないときは黙って進める。**
                //
                // 「問題を読み取れませんでした」を出すと、任意のはずの2枚目が
                // 事実上の必須になる(撮り直さないと消えない警告になるため)。
                // §4-1 のヒントは撮る前に出してあるので、ここで念を押す必要もない。
                if (problem != null) ...<Widget>[
                  _ProblemReadback(problem: problem),
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
        ChunkyButton(
          label: strings.captureStart,
          onPressed: state.canStart
              ? () async {
                  // 外した単元を反映してから始める。ここを飛ばすと、サーバ側の
                  // セッションとトークンは解析時のままで、外した単元を
                  // 先輩が教えてしまう。
                  final SessionStart? session = await ref
                      .read(captureControllerProvider.notifier)
                      .confirmAndStart(
                        locale: Localizations.localeOf(context).languageCode,
                      );
                  if (session != null && context.mounted) {
                    context.go(AppRoute.session.path);
                  }
                }
              : null,
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
/// **合っているかを問わない。** ここで直す手段が無い(セッションはもう
/// 作られていて、撮り直すと今日の1回を使い直すことになる)のに問いかけると、
/// 答えようのない問いになる。事実として置いておけば、ちがっていれば
/// 会話の最初に本人が言う — それが §1-1 の「誤読の保険」そのもの。
class _ProblemReadback extends StatelessWidget {
  const _ProblemReadback({required this.problem});

  final SessionProblem problem;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

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
          Text(strings.captureProblemTitle, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          // 長い問題文(契約の上限は600字)でも、ここだけで送りきる。
          // 折りたたむと、読み合わせという目的そのものが消える。
          Text(problem.text, style: Theme.of(context).textTheme.bodyLarge),
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
        // サーバが `label` に入れてくる(ADR 0006)。
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
