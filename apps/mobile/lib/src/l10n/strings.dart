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

  // --- ホーム ---
  String get homeGreeting => _pick('今日のノート、見せてください', 'Show me your notes today');
  String get homeCapture => _pick('ノートを撮る', 'Take a photo');
  String streakDays(int days) => _pick('$days日つづけて説明中', '$days-day streak');
  String filledHoles(int count) => _pick('埋めた穴 $count', '$count gaps filled');
  String openHoles(int count) => _pick('残っている穴 $count', '$count gaps open');

  // --- 撮影確認 ---
  String get captureConfirmTitle => _pick('この単元で合っていますか?', 'Is this the right topic?');
  String get captureConfirmHint =>
      _pick('ちがっていたらタップして外せます', 'Tap to remove anything that is wrong');
  String get captureStart => _pick('説明をはじめる', 'Start explaining');

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
  String get karteRetry => _pick('言い直してみる', 'Explain it again');
  String get karteDone => _pick('今日はここまで', "That's it for today");

  // --- 復習 ---
  String get reviewTitle => _pick('埋めにいく穴', 'Gaps to fill');
  String get reviewStart => _pick('30秒で説明する', 'Explain in 30 seconds');
  String get reviewLocked =>
      _pick('穴の復習はPremiumの機能です', 'Reviewing past gaps is a Premium feature');

  // --- ペイウォール ---
  String get paywallTitle => _pick('穴を、埋めきる。', 'Fill every gap.');
  String get paywallPrice =>
      _pick('Premium ¥580/月 ・ はじめの7日間は無料', 'Premium ¥580/month · First 7 days free');
  String get paywallCta => _pick('7日間無料でためす', 'Try 7 days free');
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
