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

  // --- エラー ---
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
