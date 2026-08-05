import 'package:flutter/widgets.dart';

/// 日英2ロケール(handoff §3-7 審査員対応)。
///
/// arb + codegen を使わず手書きにしているのは、`flutter test` を
/// codegenなしで通せるようにするため(リポジトリ単体で動くことがNext Genの要件)。
/// 文言が増えて手に負えなくなったら flutter_localizations の gen へ移す。
@immutable
class AppStrings {
  const AppStrings(this.locale);

  final Locale locale;

  static const List<Locale> supportedLocales = <Locale>[Locale('ja'), Locale('en')];

  static AppStrings of(BuildContext context) =>
      Localizations.of<AppStrings>(context, AppStrings) ?? const AppStrings(Locale('ja'));

  bool get _ja => locale.languageCode == 'ja';

  String _pick(String ja, String en) => _ja ? ja : en;

  // --- オンボーディング ---
  String get onboardingTitle =>
      _pick('答えは教えません。', 'We never give you the answer.');
  String get onboardingBody => _pick(
        'ノートを撮ると、後輩が質問します。\n説明しているうちに、\n自分でも気づいていなかった穴が見つかります。',
        'Photograph your notes and a junior student will ask you questions.\n'
            'While explaining, you find the gaps you did not know you had.',
      );
  String get onboardingCta => _pick('はじめる', 'Get started');
  String get onboardingNext => _pick('つぎへ', 'Next');

  /// 2枚目。何をする4分間なのかを、先に絵で見せる。
  String get onboardingHowTitle => _pick('やることは、これだけ。', 'This is all you do.');
  String get onboardingStepCapture =>
      _pick('今日やったノートを撮る', 'Photograph the notes you worked on today');
  String get onboardingStepAsked =>
      _pick('後輩が2〜3問きいてくる', 'Your kohai asks you two or three questions');
  String get onboardingStepExplain =>
      _pick('声に出して説明する(5分)', 'Explain it out loud (5 minutes)');
  String get onboardingStepKarte =>
      _pick('言えたことと穴が、カルテに残る', 'What you said and what stalled become your karte');

  /// 権限は使う直前に聞く。ここでは予告だけして、初回離脱を作らない。
  String get onboardingPermissionNote => _pick(
        'カメラ・マイク・通知の許可は、使う直前にお願いします',
        'We ask for camera, microphone and notification access only when they are needed',
      );

  // --- ホーム ---
  String get homeGreeting => _pick('今日のノート、見せてください', 'Show me your notes today');
  String get homeCapture => _pick('ノートを撮る', 'Take a photo');
  String streakDays(int days) => _pick('$days日つづけて説明中', '$days-day streak');
  String filledHoles(int count) => _pick('埋めた穴 $count', '$count gaps filled');
  String openHoles(int count) => _pick('残っている穴 $count', '$count gaps open');

  /// ホームの復習カード。再訪の起点で、通知の着地先でもある。
  String get homeOpenHoleLabel => _pick('埋めていない穴', 'A gap still open');
  String homeOpenHoleMore(int count) =>
      _pick('ほかに $count こ', '$count more');

  /// 残りセッション。事実だけ淡々と(§6 煽らない)。
  String remainingSessions(int count) =>
      _pick('今日の無料セッション: 残り$count回', 'Free sessions left today: $count');
  String get remainingSessionsNone =>
      _pick('今日の無料セッションは使いきりました', 'You have used today\'s free session');
  String get remainingSessionsUnlimited => _pick('セッションは無制限です', 'Unlimited sessions');
  String get homeUnlock => _pick('無制限にする', 'Go unlimited');
  String get homeFirstRun => _pick(
        'まだ穴はありません。最初の1枚から始まります。',
        'No gaps yet. It starts with your first photo.',
      );

  // --- 撮影確認 ---
  String get captureConfirmTitle => _pick('この単元で合っていますか?', 'Is this the right topic?');
  String get captureConfirmHint =>
      _pick('ちがっていたらタップして外せます', 'Tap to remove anything that is wrong');
  String get captureStart => _pick('説明をはじめる', 'Start explaining');

  /// カメラを断られたとき。黙ってホームに戻さない。
  String get captureCameraDenied => _pick(
        'カメラを使えませんでした。設定アプリから許可すると、ノートを撮れます。',
        "We couldn't use the camera. Allow it in Settings to photograph your notes.",
      );
  String get captureOpenSettings => _pick('設定をひらく', 'Open Settings');

  // --- 会話 ---
  String get sessionListening => _pick('聞いています', 'Listening');
  String get sessionThinking => _pick('考えています', 'Thinking');
  String get sessionPass => _pick('うまく言えない', "I can't explain this yet");
  String get sessionEnd => _pick('今日はここまで', "That's it for today");
  String remaining(int seconds) {
    final String minutes = (seconds ~/ 60).toString();
    final String rest = (seconds % 60).toString().padLeft(2, '0');
    return _pick('のこり $minutes:$rest', '$minutes:$rest left');
  }

  // --- 祝福 ---
  String get celebrationThanks => _pick('説明、ありがとうございました', 'Thanks for explaining');
  String celebrationFilled(int count) =>
      _pick('穴が$count つ、埋まりました', '$count gaps filled');

  // --- カルテ ---
  String get karteTitle => _pick('今日のカルテ', "Today's karte");
  String get karteSaidWell => _pick('言えたこと', 'What you explained');
  String karteHoles(int count) => _pick('穴 — $count つ', 'Gaps — $count');
  String get karteTermNotes => _pick('用語メモ', 'Terminology');
  String get karteNoHoles =>
      _pick('今日は、止まらずに説明できました', 'You explained it all the way through today');
  String get karteReviewToggle =>
      _pick('あしたの夜、後輩がもう一度ききます', 'Your kohai will ask again tomorrow night');

  /// 通知の許可を求める場所はここだけ。穴が見えた直後に、後輩からのお願いとして聞く。
  String get karteReviewAsk =>
      _pick('あしたの夜、もう一度きいてもいいですか?', 'May I ask you again tomorrow night?');
  String get karteReviewDenied => _pick(
        '通知が切れています。設定アプリから戻せます。',
        'Notifications are off. You can turn them back on in Settings.',
      );
  String get karteRetry => _pick('言い直してみる', 'Explain it again');
  String get karteDone => _pick('今日はここまで', "That's it for today");

  // --- 復習 ---
  String get reviewTitle => _pick('埋めにいく穴', 'Gaps to fill');
  String get reviewStart => _pick('30秒で説明する', 'Explain in 30 seconds');
  String get reviewLocked =>
      _pick('穴の復習はPremiumの機能です', 'Reviewing past gaps is a Premium feature');

  /// 埋めた穴のセクション。ペイウォールが謳う「履歴」はここで果たす。
  String reviewFilledTitle(int count) => _pick('埋めた穴 — $count つ', 'Gaps filled — $count');
  String get reviewFilledEmpty => _pick(
        'ここに、埋めた穴がたまっていきます',
        'The gaps you fill will collect here',
      );
  String reviewFilledDays(int days) => switch (days) {
        0 => _pick('今日 埋めた', 'Filled today'),
        1 => _pick('きのう 埋めた', 'Filled yesterday'),
        _ => _pick('$days日前に埋めた', 'Filled $days days ago'),
      };

  /// 穴がひとつも無いとき。「何もない」ではなく「今は無い」として見せる。
  String get reviewEmpty => _pick(
        'いまは、埋めにいく穴がありません',
        'There are no gaps waiting right now',
      );
  String get reviewBackHome => _pick('ホームにもどる', 'Back to home');

  // --- 設定 ---
  String get settingsTitle => _pick('設定', 'Settings');
  String get settingsSectionAccount => _pick('契約', 'Subscription');
  String get settingsSectionNotifications => _pick('通知', 'Notifications');
  String get settingsSectionAbout => _pick('このアプリについて', 'About');
  String get settingsNotifications => _pick('後輩からの再説明のお願い', 'Reminders from your kohai');
  String get settingsNotificationsOn => _pick('届きます', 'On');
  String get settingsNotificationsOff => _pick('届きません', 'Off');
  String get settingsNotificationsOpenSettings =>
      _pick('通知の設定をひらく', 'Open notification settings');
  String get settingsPrivacy => _pick('プライバシーポリシー', 'Privacy policy');
  String get settingsTerms => _pick('利用規約', 'Terms of use');

  /// AI生成物の報告導線。App Review で見られる(handoff §5)。
  String get settingsReport => _pick('気になる質問を報告する', 'Report a question that felt wrong');
  String get settingsReportBody => _pick(
        '後輩の質問が、ノートと関係ない・答えを教えてしまっている・不快だった場合に送ってください。',
        'Tell us if your kohai asked something unrelated, gave away an answer, or felt wrong.',
      );
  String get settingsVersion => _pick('バージョン', 'Version');
  String get settingsDeviceId => _pick('端末ID(問い合わせ用)', 'Device ID (for support)');
  String get settingsCopied => _pick('コピーしました', 'Copied');
  String get settingsOpenFailed => _pick(
        'ひらけませんでした。あとで試してみてください。',
        "We couldn't open that. Please try again later.",
      );

  // --- ペイウォール ---
  String get paywallTitle => _pick('穴を、埋めきる。', 'Fill every gap.');
  String get paywallPrice =>
      _pick('Premium ¥580/月 ・ はじめの7日間は無料', 'Premium ¥580/month · First 7 days free');
  /// ペイウォールを**開く**ボタン(復習画面など)。ここで無料日数を約束しない。
  /// ストアの商品にトライアルが付いているかは、Offering を読むまで分からない。
  String get paywallCta => _pick('Premiumをみる', 'See Premium');

  /// 購入ボタン。トライアルがあるときは [planFreeTrial] に差し替わる。
  String get paywallSubscribe => _pick('このプランではじめる', 'Start with this plan');
  String get paywallDismiss => _pick('無料のまま続ける', 'Keep using the free version');
  String get paywallCancelNote => _pick('いつでも解約できます', 'Cancel anytime');
  String get paywallFree => _pick('無料', 'Free');
  String get paywallPremium => _pick('Premium', 'Premium');
  String get paywallRowSessions => _pick('セッション', 'Sessions');
  String get paywallRowKarte => _pick('カルテ', 'Karte');
  String get paywallRowFollowup => _pick('後輩のあと追い質問', 'Follow-up questions');
  String get paywallOncePerDay => _pick('1日1回', 'Once a day');
  String get paywallUnlimited => _pick('無制限', 'Unlimited');
  String get paywallTodayOnly => _pick('当日のみ', 'Today only');
  String get paywallHistory => _pick('穴の復習と履歴', 'Review and history');

  /// 比較表の「あり」。`✓`(U+2713)は ZenMaruGothic に字形が無く、
  /// golden で空欄に見えていた。フォントが持っている字だけで書く。
  String get paywallIncluded => _pick('○', 'Yes');

  // --- プラン(RevenueCatのpackageから作る) ---
  String get planWeekly => _pick('1週間', 'Weekly');
  String get planMonthly => _pick('1か月', 'Monthly');
  String get planYearly => _pick('1年', 'Yearly');
  String planPerMonth(String price) => _pick('月あたり $price', '$price / month');

  /// 「おすすめ」ではなく計算した事実として出す(煽らない)。
  String get planBestValue => _pick('月あたりがいちばん安い', 'Lowest monthly price');
  String planFreeTrial(int days) =>
      _pick('はじめの$days日間は無料', 'First $days days free');

  // --- 購入の復元・契約の管理 ---
  String get paywallRestore => _pick('購入を復元する', 'Restore purchases');
  String get paywallRestored => _pick('購入を復元しました', 'Your purchase was restored');
  String get paywallRestoredNothing => _pick(
    'このアカウントに、復元できる購入は見つかりませんでした',
    'No previous purchases were found for this account',
  );
  String get manageSubscription => _pick('契約の管理', 'Manage subscription');
  String premiumUntil(String date) => _pick('$date まで有効です', 'Active until $date');
  String premiumEndsOn(String date) => _pick(
    '$date に終わります。それまではこのまま使えます',
    'Ends on $date. Everything stays available until then',
  );

  /// Test Store で動いているビルドの表示。実売と取り違えないための注記。
  String get testStoreNotice =>
      _pick('テストストアです(実際の請求は発生しません)', 'Test Store — you will not be charged');

  // --- エラー ---
  /// 購入が通ったのに entitlement が付かなかった。ダッシュボードの設定漏れ。
  String get purchaseErrorNotEntitled => _pick(
    '購入は完了しましたが、まだ反映されていません。'
    '少し時間をおいて「購入を復元する」を試してみてください。',
    'Your purchase went through but has not unlocked yet. '
        'Please wait a moment and tap "Restore purchases".',
  );
  String get purchaseErrorNetwork => _pick(
    '通信が届きませんでした。電波のいいところで、もう一度試してみてください。',
    "We couldn't reach the store. Please try again with a better connection.",
  );
  String get purchaseErrorStore => _pick(
    'ストア側で問題が起きています。少し時間をおいて試してみてください。',
    'The store is having trouble right now. Please try again shortly.',
  );
  String get purchaseErrorNotAllowed => _pick(
    'この端末では購入できない設定になっています。',
    'This device is not allowed to make purchases.',
  );
  String get purchaseErrorAlreadyOwned => _pick(
    'すでに契約があります。「購入を復元する」から戻せます。',
    'You already have a subscription. Tap "Restore purchases" to bring it back.',
  );
  String get purchaseErrorPending => _pick(
    '支払いの確認を待っています。完了すると自動で使えるようになります。',
    'Waiting for your payment to be confirmed. It will unlock automatically.',
  );
  String get purchaseErrorConfiguration => _pick(
    'いま購入できない状態です。直しますので、少し待ってください。',
    'Purchases are unavailable right now. We are looking into it.',
  );

  /// 「◯年◯月◯日」。intl を直接の依存に足さずに済ませるための最小の整形。
  String date(DateTime value) => _pick(
    '${value.year}年${value.month}月${value.day}日',
    '${_monthNames[value.month - 1]} ${value.day}, ${value.year}',
  );

  static const List<String> _monthNames = <String>[
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];


  String get errorGeneric =>
      _pick('うまくいきませんでした。少し時間をおいて試してみてください。',
          'Something went wrong. Please try again shortly.');
  String get errorRetry => _pick('もう一度', 'Try again');
}

class AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const AppStringsDelegate();

  @override
  bool isSupported(Locale locale) =>
      AppStrings.supportedLocales.any((Locale it) => it.languageCode == locale.languageCode);

  @override
  Future<AppStrings> load(Locale locale) async => AppStrings(locale);

  @override
  bool shouldReload(AppStringsDelegate old) => false;
}
