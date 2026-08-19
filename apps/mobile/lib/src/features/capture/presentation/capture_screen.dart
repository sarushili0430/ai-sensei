import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_cropper/image_cropper.dart';
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
/// **日次の持ち時間を押さえるのはここではない。** 押さえるのは会話が始まったときなので
/// (`api.ts` の `startSessionResponseSchema`)、解析まで進んでから撮り直しても
/// 授業の持ち時間は減らない。
///
/// **どちらか1枚で始められる**(§4-1)。1枚に問題とノートの両方が写ることが
/// 多いので、2枚必須にすると撮影の摩擦だけが増える。ここで出すのは「撮れ」ではなく
/// 「写っていると迷子になりません」というヒントに留める。
///
/// ## 枠のタップでシートを開く理由(カメラを直接開かない)
///
/// アルバムから入れる道を足したが、**置ける場所がここしか無かった。**
/// 枠は2つとも埋まっていて、片方を「アルバム専用」にはできない(どちらの枠に
/// 入れたかが破棄の前提なので、枠の意味を変えられない)。
///
/// **端末の写真をアプリ内にマス目で並べる案は採らなかった。** それには Android で
/// `READ_MEDIA_IMAGES`(広いアクセス)が要り、Google Play の Photo & Video
/// Permissions ポリシーで申告と審査の対象になる。通す条件は「システムのピッカー
/// ではコア機能が提供できない」ことで、**自前ピッカーを持っていること自体は
/// 資格にならないと条文が名指ししている。** この画面がPhoto Pickerでできないのは
/// 見た目と「1マス目に撮影ボタン」だけで、どちらも授業の成立には関わらない —
/// 申告に書ける材料が無い。なので**マス目はOSのピッカーに任せ、撮影ボタンだけ
/// 手前に出す**([_SourceSheet])。権限のダイアログも1つも増えていない。
///
/// ## 切り抜きを置く理由
///
/// `contract` の `problemTextMaxLength` が既知の失敗モードとしてこう書いている —
/// 「ページ全体を写すと、章末の解答や解説まで問題文として流れ込み、先輩が答えを
/// 読み上げるところから授業が始まってしまう」。600字の上限はその**安全弁**で、
/// 根本の対策ではなかった。切り抜きがその対策になる。
///
/// **置き場所はここしかない。** [CaptureController] は解析後の差し替えを弾くので、
/// 切り抜きが効くのは解析の前 = この画面だけ。**それでも任意に留める**
/// (促しは [AppStrings.captureCropHint] が出す)。
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

/// 枠に対してできること。[_SourceSheet] が返し、失敗したときの文言と
/// 「もう一度」の行き先にもそのまま使う。
enum _PickAction { camera, gallery, crop }

class _CaptureScreenState extends ConsumerState<CaptureScreen> {
  /// 断られた。閉じるのではなく、戻し方を出す。
  bool _denied = false;

  /// 許可はあるのに開けなかった(端末側の理由)。やり直しの導線を出す。
  bool _failed = false;

  /// カメラ・アルバム・切り抜きのどれかを開いている最中。まだ見せるものが無い。
  ///
  /// 「1枚も撮っていない」と区別が要る。撮らずに帰ってきた人には
  /// **枠を見せて留まってもらう**ので、写真の有無だけでは判断できない。
  ///
  /// 最初は立てておく。[reset] が次のフレームまで走らないので、寝かせて始めると
  /// **前回の写真が1フレームだけ見えてしまう**(コントローラは keepAlive)。
  bool _picking = true;

  /// 直近に触った枠。開けなかったときの「もう一度」を同じ枠へ戻すため。
  ///
  /// カメラの自動起動をやめてからは、**どちらの枠から来たかは本人の選択**なので、
  /// 失敗のたびにノートへ引き戻すと、ノートが無い生徒を無い枠へ送り返すことになる。
  bool _lastPickWasProblem = false;

  /// 直近に選んだ操作。**文言も「もう一度」の行き先も、押したものに合わせる。**
  ///
  /// アルバムを押した人に「カメラを使えませんでした」と返すと、設定アプリの
  /// どこを開けばいいのか分からなくなる。切り抜きで失敗した人を撮り直しへ
  /// 引き戻すのも同じで、写真はもう入っている。
  _PickAction _lastAction = _PickAction.camera;

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

  /// ノートの枠。**必須ではない**(サーバは `kind: new` でどちらか1枚を要求する)。
  Future<void> _tapNotes() => _openSourceSheet(forProblem: false);

  /// 問題の枠。これだけでも始められる(§4-1)。
  Future<void> _tapProblem() => _openSourceSheet(forProblem: true);

  /// 写真の入れ方を選ぶシートを開く。**枠のタップはすべてここに来る。**
  ///
  /// カメラを直接開かず一枚挟んでいるのは、アルバムの導線を置く場所がここしか
  /// 無いから(理由の全文はクラスのコメント)。撮る人のタップは1つ増えるが、
  /// **この画面はもともと「何を撮るか」を選ばせるために止まっている**ので、
  /// 止まる場所が増えたわけではない。
  Future<void> _openSourceSheet({required bool forProblem}) async {
    final CaptureState state = ref.read(captureControllerProvider);
    final File? photo = forProblem ? state.problemPhoto : state.photo;
    final AppStrings strings = AppStrings.of(context);

    final _PickAction? action = await showModalBottomSheet<_PickAction>(
      context: context,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.card)),
      ),
      builder: (BuildContext context) => _SourceSheet(
        label: forProblem ? strings.capturePhotoProblem : strings.capturePhotoNotes,
        // 切り抜きは写真が入っているときだけ。空の枠に出しても、押せない操作が増える。
        hasPhoto: photo != null,
      ),
    );

    // シートを閉じただけ。**どこにも戻さない** — 枠はそのまま見えている。
    if (action == null || !mounted) return;

    switch (action) {
      case _PickAction.camera:
        await _pick(forProblem: forProblem, source: ImageSource.camera);
      case _PickAction.gallery:
        await _pick(forProblem: forProblem, source: ImageSource.gallery);
      case _PickAction.crop:
        if (photo != null) await _crop(forProblem: forProblem, file: photo);
    }
  }

  Future<void> _pick({
    required bool forProblem,
    required ImageSource source,
  }) async {
    setState(() {
      _denied = false;
      _failed = false;
      _picking = true;
      _lastPickWasProblem = forProblem;
      _lastAction = source == ImageSource.camera
          ? _PickAction.camera
          : _PickAction.gallery;
    });

    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(
        source: source,
        imageQuality: 85,
        // **長辺に上限を置く。** カメラは端末の撮影解像度で頭打ちになるが、
        // アルバムには他のアプリで撮った48MPの1枚もパノラマも入っている。
        // 解析は画像をそのままVision APIへ渡すので、大きすぎる1枚はサイズの
        // 上限に当たり、**生徒からは「サーバのエラー」としてしか見えない形**で落ちる。
        //
        // 数字は切り抜き([_crop])と揃えてある。読み取りは `claude-sonnet-5` で
        // 長辺2576pxまではそのまま効くので、**読み取りの精度は落ちない。**
        // ここで先に切っておかないと、切り抜き側の上限だけでは素通りする経路
        // (アルバムから選んで切り抜かない)が残る。
        maxWidth: 2576,
        maxHeight: 2576,
        // EXIFは使っていない。**落とすとiOSで写真の許可ダイアログが出なくなる**
        // (フルのメタデータを求めなければPHPickerで済むため)。
        // アルバムの導線を足しても、許可を1つも増やさずに済んでいるのはここ。
        requestFullMetadata: false,
      );
    } on PlatformException catch (error, stack) {
      // ここで拾わないと、受け取り手がいないまま未処理例外になり、撮影画面ごと落ちる。
      debugPrint('写真を開けませんでした(${error.code}): ${error.message}\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        if (_kPermissionErrorCodes.contains(error.code)) {
          _denied = true;
        } else {
          _failed = true;
        }
      });
      return;
    } on Object catch (error, stack) {
      // プラグインの想定外(ファイルの読み出し失敗など)。落とさずにやり直させる。
      debugPrint('写真を取得できませんでした: $error\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        _failed = true;
      });
      return;
    }

    // 撮らず/選ばずに帰ってきた。許可が無いなら設定への行き方を出す —
    // 何度開いても結果が同じなので、そこだけは別扱いにする。
    // **枠で出し分けない。** どちらの枠も本人が選んで開いたものなので、
    // 許可が無いことを片方でだけ知らせる理由が無い。
    //
    // **それ以外は、どこにも戻さずこの画面に留まる。**
    // 以前はホームへ降ろしていたが、降ろすと選び直せない —
    // ノートを撮ろうとしてやめた人が、問題の枠にたどり着けなくなる。
    // 本当にやめたい人は、この画面の戻るで降りられる(push で来ている)。
    if (picked == null) {
      if (!mounted) return;
      final bool denied = await _isDenied(source);
      if (!mounted) return;
      setState(() {
        _picking = false;
        _denied = denied;
      });
      return;
    }

    if (!mounted) return;
    // ここでは解析しない(理由はクラスのコメント)。
    _store(forProblem: forProblem, file: File(picked.path));
  }

  /// 入っている写真を切り抜く。**解析の前だけ効く操作。**
  ///
  /// [CaptureController] が解析後の差し替えを弾くので、ここから先で呼んでも
  /// 黙って捨てられる。呼び口は [_SourceSheet] だけで、そのシートは
  /// 解析前の画面([_PhotoReview])からしか開かない。
  Future<void> _crop({required bool forProblem, required File file}) async {
    setState(() {
      _denied = false;
      _failed = false;
      _picking = true;
      _lastPickWasProblem = forProblem;
      _lastAction = _PickAction.crop;
    });

    final AppStrings strings = AppStrings.of(context);
    final CroppedFile? cropped;
    try {
      cropped = await ImageCropper().cropImage(
        sourcePath: file.path,
        // **切り抜きで稼いだ解像度を、ここで捨てない。**
        // 読み取りは `claude-sonnet-5`(`backend/api/wrangler.toml`)で、
        // 長辺2576pxまではそのまま効く(超えた分はモデル側で縮小される)。
        // 上限を切るのはアップロードのためで、精度のためではない。
        maxWidth: 2576,
        maxHeight: 2576,
        uiSettings: <PlatformUiSettings>[
          AndroidUiSettings(
            toolbarTitle: strings.captureCrop,
            toolbarColor: AppColors.blue,
            toolbarWidgetColor: Colors.white,
            activeControlsWidgetColor: AppColors.blue,
            // **比率は固定しない。** 問題は横長のことも縦長のこともあるので、
            // 枠を決め打ちすると切り抜けない紙面が出る。
            lockAspectRatio: false,
          ),
          IOSUiSettings(title: strings.captureCrop, aspectRatioLockEnabled: false),
        ],
      );
    } on Object catch (error, stack) {
      // ネイティブ側の失敗(Androidで UCropActivity の宣言漏れ、など)。
      debugPrint('切り抜けませんでした: $error\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        _failed = true;
      });
      return;
    }

    if (!mounted) return;
    // やめて帰ってきた。**元の写真をそのまま残す**(捨てると撮り直しになる)。
    if (cropped == null) {
      setState(() => _picking = false);
      return;
    }
    _store(forProblem: forProblem, file: File(cropped.path));
  }

  /// 撮った/選んだ/切り抜いたものを、対応する枠へ入れる。
  ///
  /// **枠の対応を1か所に閉じ込めておく。** 取り違えると、他者の著作物が
  /// ノートとしてR2に保存される(`api.ts` の `sessionPhotoParts`)。
  void _store({required bool forProblem, required File file}) {
    final CaptureController controller = ref.read(captureControllerProvider.notifier);
    if (forProblem) {
      controller.setProblemPhoto(file);
    } else {
      controller.setPhoto(file);
    }
    setState(() => _picking = false);
  }

  /// 開けなかったものを、そのまま開き直す。
  ///
  /// **撮り直しに固定しない。** 切り抜きで失敗した人の写真はもう入っているし、
  /// アルバムで失敗した人をカメラへ送るのも的外れになる。
  Future<void> _retryLast(CaptureState state) {
    final bool forProblem = _lastPickWasProblem;
    if (_lastAction == _PickAction.crop) {
      final File? photo = forProblem ? state.problemPhoto : state.photo;
      // 切り抜く元が無い(セッションが消えて写真ごと捨てられた)なら、入れ直しから。
      if (photo == null) return _openSourceSheet(forProblem: forProblem);
      return _crop(forProblem: forProblem, file: photo);
    }
    return _pick(
      forProblem: forProblem,
      source: _lastAction == _PickAction.gallery
          ? ImageSource.gallery
          : ImageSource.camera,
    );
  }

  Future<void> _analyze() async {
    final String locale = Localizations.localeOf(context).languageCode;
    await ref.read(captureControllerProvider.notifier).analyze(locale: locale);
  }

  /// 外した単元を反映してから会話を始める。**日次の持ち時間を押さえるのはここ。**
  ///
  /// 失敗したときの「もう一度」もここへ戻す(理由は [_body] のエラー分岐)。
  Future<void> _start() async {
    final String locale = Localizations.localeOf(context).languageCode;
    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .confirmAndStart(locale: locale);
    if (session != null && mounted) context.go(AppRoute.session.path);
  }

  /// 何も返ってこなかったのが、**やめたからか許可が無いからか**を見分ける。
  ///
  /// **アルバムは照会しない。** OSのピッカー(iOSはPHPicker・AndroidはPhoto
  /// Picker)経由なので、そもそも写真の許可が要らない。ここで許可を見にいくと、
  /// 許可していない端末で「やめただけ」を「断られた」と誤診して、
  /// 出しても意味のない設定画面へ送ることになる。
  ///
  /// 照会そのものも失敗しうる。ここで落とすと、やめただけの人まで巻き込む。
  Future<bool> _isDenied(ImageSource source) async {
    if (source == ImageSource.gallery) return false;
    try {
      final PermissionStatus status = await Permission.camera.status;
      return status.isDenied || status.isPermanentlyDenied || status.isRestricted;
    } on Object catch (error) {
      debugPrint('カメラの許可を確認できませんでした: $error');
      return false; // 許可の問題と決めつけない
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

    if (_denied) {
      return _ErrorView(
        // **押したものに合わせる。** アルバムを押した人に「カメラを使えません
        // でした」と返すと、設定アプリのどこを開けばいいのか分からなくなる。
        message: _lastAction == _PickAction.gallery
            ? strings.capturePhotosDenied
            : strings.captureCameraDenied,
        retryLabel: strings.captureOpenSettings,
        onRetry: openAppSettings,
      );
    }

    if (_failed) {
      return _ErrorView(
        message: switch (_lastAction) {
          _PickAction.camera => strings.captureCameraFailed,
          _PickAction.gallery => strings.capturePhotosFailed,
          _PickAction.crop => strings.captureCropFailed,
        },
        // 開けなかったものへ戻す。撮り直しに固定すると、ノートが無い生徒を
        // 無い枠へ送り返したり、切り抜きに失敗しただけの人の写真を捨てたりする。
        onRetry: () => _retryLast(state),
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
        // サーバ側で会話時間を押さえていることがあり、撮り直すとその仮押さえを捨てる。
        // `/start` は同じIDなら二重に確保しないので、押し直すほうが正しい
        // (セッションごと消えていれば `analysis` も捨てられ、撮り直しに戻る)。
        onRetry: lessonLimitReached
            ? null
            : state.analysis != null
                ? _start
                // やり直すのは、直前に触っていた枠と操作(ノートとは限らない)。
                : () => _retryLast(state),
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
        onTapNotes: _tapNotes,
        onTapProblem: _tapProblem,
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
///   - 問題が入っている人 … **ここは今まで無言だった。** 切り抜きを足したので、
///     `contract` の `problemTextMaxLength` が書いている失敗モード(ページ全体を
///     写すと章末の解答まで問題文として流れ込む)に、初めて言葉が届く
///
/// 全部を常時並べると、どの人にも大半は関係のない文章になる。
/// **どちらも撮る前に出る言葉なので、§4-1 の「警告にしない」は保たれている**
/// (`api.ts` の `problemSources` が言う、解析後に出すと2枚目が事実上の必須に
/// なる、という話とは別の軸)。
class _PhotoReview extends StatelessWidget {
  const _PhotoReview({
    required this.state,
    required this.onTapNotes,
    required this.onTapProblem,
    required this.onStart,
  });

  final CaptureState state;

  /// 枠を触ったとき。**撮影ではなく[_SourceSheet]を開く**(理由は
  /// [CaptureScreen] のコメント)。
  final VoidCallback onTapNotes;
  final VoidCallback onTapProblem;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // いまの埋まり方に合わせて、要る言葉だけを出す(理由はクラスのコメント)。
    //
    // **どの状態にも1つだけ出る。** 切り抜きを足したことで、いちばん進んだ状態
    // (問題が入っている)にも言うことができた。並べるのではなく、入れ替える。
    final String hint;
    if (!state.hasAnyPhoto) {
      hint = strings.captureEitherIsFine;
    } else if (state.problemPhoto == null) {
      hint = strings.captureProblemHint;
    } else {
      hint = strings.captureCropHint;
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
                  onTap: onTapNotes,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: _PhotoSlot(
                  label: strings.capturePhotoProblem,
                  photo: state.problemPhoto,
                  emptyLabel: strings.captureAddProblem,
                  onTap: onTapProblem,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        // **促しであって要求ではない。** 撮っていなくても下のボタンは押せる。
        Text(
          hint,
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

/// 写真1枚ぶんの枠。**タップすると入れ方のシートが開く**([_SourceSheet])。
class _PhotoSlot extends StatelessWidget {
  const _PhotoSlot({
    required this.label,
    required this.photo,
    required this.emptyLabel,
    required this.onTap,
  });

  final String label;
  final File? photo;

  /// まだ入れていないときの操作名。入れたあとは「写真を変える」に変わる
  /// — シートには撮り直す・アルバム・切り抜くが並ぶので、撮影だけを名指ししない。
  final String emptyLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final File? file = photo;
    final String actionLabel =
        file == null ? emptyLabel : AppStrings.of(context).captureChangePhoto;

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
                      // **切り取らない。** この枠は飾りではなく、「これで
                      // 合っている?」を解析の前に確かめる場所(ぶれ・見切れに
                      // 気づけないまま解析枠を消費するのを止めるために置いた)。
                      // `cover` は端を落とすので、**紙面が切れていることが
                      // いちばん出る場所がちょうど隠れる。** アルバムから
                      // 選べるようになって、横長の写真も長いスクリーンショットも
                      // 入ってくる。
                      : Image.file(file, fit: BoxFit.contain),
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

/// 写真の入れ方を選ぶシート。**マス目の1つ目が撮影ボタン。**
///
/// ## 端末の写真をここに並べない理由
///
/// 「マス目に最近の写真が並んで、1つ目が撮影ボタン」という形にするには、端末の
/// 写真ライブラリをアプリ側で読む必要がある。Androidではそれが
/// `READ_MEDIA_IMAGES`(広いアクセス)で、Google Play の Photo & Video
/// Permissions ポリシー(2025-05-28 全面適用)の申告・審査対象になる。
/// 通す条件は「システムのピッカーでは**コア機能が提供できない**」ことで、
/// **自前ピッカーを持っていること自体は資格にならないと条文が名指ししている。**
///
/// このアプリがPhoto Pickerでできないのは「見た目」と「1つ目の撮影ボタン」だけで、
/// どちらも授業の成立には関わらない — 申告に書ける材料が無い。
/// なので**マス目はOSのピッカーに任せ、撮影ボタンだけ手前に出した。**
/// [AppStrings.capturePickGallery] を押した先がOSのピッカーで、
/// あれ自体が写真のマス目になっている。**権限は1つも増えていない。**
///
/// (`android/app/src/main/AndroidManifest.xml` にも同じ理由を残してある。
/// 権限を足すときは、申告に何を書くかを先に決めること。)
class _SourceSheet extends StatelessWidget {
  const _SourceSheet({required this.label, required this.hasPhoto});

  /// どちらの枠を触っているか(ノート / 問題)。
  ///
  /// **枠の名前を出す。** シートが開いた時点で、どちらを触っているかが
  /// 隠れる(枠がシートの裏に回る)ので、取り違えたまま入れられてしまう。
  /// 問題の紙面をノート枠に入れると、他者の著作物がR2に保存される。
  final String label;

  /// 写真が入っているか。入っていれば撮影が「撮り直す」になり、切り抜きが増える。
  final bool hasPhoto;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              label,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.lg),
            // **`IntrinsicHeight` を外すと落ちる。** マスの高さを揃えるための
            // `stretch` は、高さの上限が無い場所(この `Column` は `min`)では
            // 子に無限の高さを配ってしまう。ここで高さを確定させてから配る。
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Expanded(
                    child: _SheetTile(
                      icon: Icons.photo_camera_outlined,
                      label:
                          hasPhoto ? strings.captureRetake : strings.capturePickCamera,
                      // **撮るを1つ目に、色つきで置く。** この画面の主役は撮影で、
                      // アルバムは「すでに撮ってある人」の道。並びで主従を示す。
                      primary: true,
                      onTap: () => Navigator.of(context).pop(_PickAction.camera),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: _SheetTile(
                      icon: Icons.photo_library_outlined,
                      label: strings.capturePickGallery,
                      onTap: () => Navigator.of(context).pop(_PickAction.gallery),
                    ),
                  ),
                  if (hasPhoto) ...<Widget>[
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: _SheetTile(
                        icon: Icons.crop,
                        label: strings.captureCrop,
                        onTap: () => Navigator.of(context).pop(_PickAction.crop),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// シートの1マス。
///
/// **高さを固定しない。** 正方形に見えるだけの余白を持たせて、中身で伸ばす。
/// `AspectRatio` で正方形に切ると、文字を大きくしている端末で
/// アイコンとラベルがはみ出す(このリポジトリが `layout_overflow_test` で
/// 見ている壊れ方そのもの)。
class _SheetTile extends StatelessWidget {
  const _SheetTile({
    required this.icon,
    required this.label,
    required this.onTap,
    this.primary = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// 一等地。色を敷いて、並びの主役だと分かるようにする。
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final Color foreground = primary ? Colors.white : AppColors.ink;

    return Semantics(
      button: true,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
          decoration: BoxDecoration(
            color: primary ? AppColors.blue : AppColors.background,
            border: Border.all(color: primary ? AppColors.blue : AppColors.border),
            borderRadius: BorderRadius.circular(AppRadius.card),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, color: foreground, size: 28),
              const SizedBox(height: AppSpacing.sm),
              Text(
                label,
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: foreground),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TopicConfirm extends ConsumerStatefulWidget {
  const _TopicConfirm({required this.state, required this.onStart});

  final CaptureState state;

  /// 会話を始める。失敗したときの「もう一度」も同じ操作へ戻る。
  final Future<void> Function() onStart;

  @override
  ConsumerState<_TopicConfirm> createState() => _TopicConfirmState();
}

class _TopicConfirmState extends ConsumerState<_TopicConfirm> {
  /// 問題文を打ち込んでいる最中か。
  ///
  /// **画面ごと差し替えない。** 別画面にすると、いま確かめている単元のチップが
  /// 見えなくなり、戻ってくるまで何を直しているのか分からなくなる。
  bool _editing = false;

  /// 打ち直しを送っている最中。
  ///
  /// **`CaptureState.isSubmitting` は使わない。** あれが立つと [_body] が
  /// スピナーを出して画面ごと消えるので、いま打った本文が見えなくなる。
  bool _saving = false;

  /// 打ち直しが弾かれた理由(サーバの文言)。**入力欄の下に出す。**
  ///
  /// `CaptureState.error` に載せると全面のエラー表示になり、直す場所へ
  /// 戻る道ごと消える(`CaptureController.submitProblemText`)。
  String? _editError;

  Future<void> _submitProblem(String text) async {
    setState(() {
      _saving = true;
      _editError = null;
    });
    final String locale = Localizations.localeOf(context).languageCode;
    final ApiException? error = await ref
        .read(captureControllerProvider.notifier)
        .submitProblemText(text, locale: locale);
    if (!mounted) return;
    setState(() {
      _saving = false;
      _editError = error?.message;
      // 通ったときだけ閉じる。弾かれたら本文を残したまま直してもらう。
      if (error == null) _editing = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final CaptureState state = widget.state;
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
                // **読めなかったときも黙らない。直せる口と一緒に出す。**
                //
                // ここは長いあいだ意図して無言だった。読めなかったと告げるだけだと、
                // 撮り直さないかぎり消えない警告になり、**任意のはずの2枚目が
                // 事実上の必須**になるため。その代わり、失敗が最初に表に出るのは
                // 会話の中 —「問題、読んでもらってもいい?」と、**画面に見えている
                // 問題を声で入れ直す**ところだった。
                //
                // 打ち直す口([_ProblemEditor])と同時に出すなら、警告にはならない。
                // その場で終わる話になるので、撮り直しを迫っていない。
                if (_editing)
                  _ProblemEditor(
                    initialText: problem?.text ?? '',
                    saving: _saving,
                    error: _editError,
                    onCancel: () => setState(() {
                      _editing = false;
                      _editError = null;
                    }),
                    onSubmit: _submitProblem,
                  )
                else
                  _ProblemReadback(
                    problem: problem,
                    outcome: state.problemOutcome,
                    onEdit: () => setState(() => _editing = true),
                  ),
                const SizedBox(height: AppSpacing.lg),
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
          // 打ち込んでいる最中は始めない。**打った本文が届かないまま
          // 授業が始まる**のが、この画面でいちばん起きてはいけない裏切り。
          onPressed: state.canStart && !_editing ? widget.onStart : null,
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
/// **合っているかを問わない。** ここは読み合わせの場で、正誤の申告を求める場では
/// ない。問いかけにすると全員が答えを迫られる。事実として置いておけば、
/// ちがっている人だけが [onEdit] から直しにいく。
///
/// ## 読めなかったときも、ここに出る
///
/// 以前は読めているときだけ出して、**読めなかったときは黙って進めていた。**
/// 告げるだけでは撮り直しを迫る警告にしかならず、任意のはずの2枚目が事実上の
/// 必須になるためで、その判断自体は正しかった。問題は、**黙った結果として
/// 失敗が会話の中で露呈していた**こと — 先輩が「問題、読んでもらってもいい?」と
/// 聞き、生徒は**画面に見えている問題を、もう一度声で入れ直していた。**
///
/// 打ち直す口ができたので、告げても行き止まりにならない。だから出す。
/// **落ち方ごとに言葉を変える**のも同じ理由で、「読み取れませんでした」だけでは
/// 次に何をすればいいかが分からない。
class _ProblemReadback extends StatelessWidget {
  const _ProblemReadback({
    required this.problem,
    required this.outcome,
    required this.onEdit,
  });

  /// 読み取れた問題文。**読めなければ null**(そのときは落ち方を出す)。
  final SessionProblem? problem;

  /// [problem] が null になった理由。分からなければ既定の文言に倒す。
  final ProblemOutcome? outcome;

  final VoidCallback onEdit;

  /// 落ち方ごとの一行。**「撮り直して」とは言わない** — 撮り直しの導線は
  /// この画面に無く(セッションはもう作られている)、言えば行き止まりが増える。
  String _outcomeMessage(AppStrings strings) => switch (outcome) {
        ProblemOutcome.tooLong => strings.captureProblemTooLong,
        ProblemOutcome.solutionIncluded => strings.captureProblemHadSolution,
        ProblemOutcome.notAProblem => strings.captureProblemNotAQuestion,
        _ => strings.captureProblemNotRead,
      };

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final SessionProblem? problem = this.problem;

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
          if (problem != null) ...<Widget>[
            Text(strings.captureProblemTitle, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.xs),
            // 長い問題文(契約の上限は600字)でも、ここだけで送りきる。
            // 折りたたむと、読み合わせという目的そのものが消える。
            Text(problem.text, style: Theme.of(context).textTheme.bodyLarge),
          ] else ...<Widget>[
            // **咎めない書き方にする。** 撮った本人に落ち度がある言い方をすると、
            // 直せる口が隣にあっても押しにくくなる。
            Text(_outcomeMessage(strings), style: Theme.of(context).textTheme.bodyLarge),
            const SizedBox(height: AppSpacing.xs),
            Text(strings.captureProblemFixHint, style: Theme.of(context).textTheme.bodySmall),
          ],
          GhostButton(
            label: problem != null ? strings.captureProblemEdit : strings.captureProblemAdd,
            onPressed: onEdit,
          ),
        ],
      ),
    );
  }
}

/// 問題文を打ち込む欄。**授業が始まる前に直せる、唯一の口。**
///
/// 問題の紙面は解析後に破棄される(著作物。`api.ts` の `sessionPhotoParts`)ので、
/// **あとから機械が読み直す手段は無い。** 読めなかったときの救済も、誤読の訂正も、
/// ここを通る以外に道がない。
///
/// **写真の撮り直しにはしない。** 解答が混ざる・紙面を丸ごと写すといった落ち方の
/// 原因は「紙面のどこを写したか」なので、同じ写真を投げ直しても同じものが返る。
/// テキストなら、その場で終わる。
class _ProblemEditor extends StatefulWidget {
  const _ProblemEditor({
    required this.initialText,
    required this.saving,
    required this.error,
    required this.onCancel,
    required this.onSubmit,
  });

  /// 読み取れていた本文。読めていなければ空(いちから打つ)。
  final String initialText;
  final bool saving;

  /// サーバに弾かれた理由。**そのまま出す**(煽らない文体で書かれている)。
  final String? error;

  final VoidCallback onCancel;
  final Future<void> Function(String text) onSubmit;

  @override
  State<_ProblemEditor> createState() => _ProblemEditorState();
}

class _ProblemEditorState extends State<_ProblemEditor> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialText);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final String? error = widget.error;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          TextField(
            controller: _controller,
            autofocus: true,
            // 問題文は1行では終わらない。**上限までは伸ばす** —
            // 打っている本文が見えないと、読み合わせにならない。
            minLines: 3,
            maxLines: 8,
            // 契約の上限。ここで止めておけば、超えてから弾かれる往復が起きない。
            maxLength: problemTextMaxLength,
            keyboardType: TextInputType.multiline,
            textInputAction: TextInputAction.newline,
            enabled: !widget.saving,
            decoration: InputDecoration(
              hintText: strings.captureProblemFieldHint,
              border: const OutlineInputBorder(),
            ),
            // 空のままでは送れない(サーバも受け取らない)。
            onChanged: (_) => setState(() {}),
          ),
          if (error != null) ...<Widget>[
            Text(
              error,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
          ChunkyButton(
            label: strings.captureProblemSave,
            onPressed: _controller.text.trim().isEmpty || widget.saving
                ? null
                : () => widget.onSubmit(_controller.text),
          ),
          GhostButton(
            label: strings.captureProblemCancel,
            onPressed: widget.saving ? null : widget.onCancel,
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
