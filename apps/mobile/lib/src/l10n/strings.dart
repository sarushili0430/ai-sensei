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

  static const List<Locale> supportedLocales = <Locale>[
    Locale('ja'),
    Locale('en')
  ];

  /// 端末の言語 → このアプリの言語。
  ///
  /// Flutter の既定は「一致しなければ supportedLocales の先頭」なので、
  /// 何もしないとスペイン語の端末に**日本語**が出る。日本語を望んだ人にだけ
  /// 日本語を出し、それ以外は英語に寄せる。
  static Locale resolve(List<Locale>? preferred) {
    for (final Locale locale in preferred ?? const <Locale>[]) {
      if (locale.languageCode == 'ja') return const Locale('ja');
      if (locale.languageCode == 'en') return const Locale('en');
    }
    return preferred == null || preferred.isEmpty
        ? const Locale('ja')
        : const Locale('en');
  }

  static AppStrings of(BuildContext context) =>
      Localizations.of<AppStrings>(context, AppStrings) ??
      const AppStrings(Locale('ja'));

  /// BuildContext を持たない層(コントローラ)から引くための入口。
  /// APIに送るのと同じ言語コードを渡す。未対応の言語は日本語に落ちる。
  static AppStrings forLanguage(String languageCode) =>
      AppStrings(Locale(languageCode));

  bool get _ja => locale.languageCode == 'ja';

  String _pick(String ja, String en) => _ja ? ja : en;

  // --- オンボーディング ---

  /// 1枚目 — 約束(ピボット計画 §0 の憲法改正後の一言)。
  ///
  /// 改行位置は成り行きに任せず、**2拍の切れ目で必ず折る**。
  /// 「教える」だけを読むと手元の無料AIと同じものに見えるので、
  /// 前半と後半が同じ重みで目に入る必要がある。
  String get onboardingTitle => _pick(
        '答えを教える。\nそのあと、あなたに教え返してもらう。',
        'The AI tutor that teaches you —\nthen asks you to teach it back.',
      );
  String get onboardingBody => _pick(
        '問題を撮ると、先輩が板書つきで教えます。\nそのあと「いまの、説明してみて」。\n詰まったところが、あなたの穴です。',
        'Photograph the problem and your senpai teaches you on the board.\n'
            'Then: "Now explain that back to me."\n'
            'Wherever you stall is your gap.',
      );
  String get onboardingCta => _pick('はじめる', 'Get started');
  String get onboardingNext => _pick('つぎへ', 'Next');

  /// 2枚目。何をする時間なのかを、先に絵で見せる。
  /// 4行はピボット計画 §2 のコアループそのもの(撮る → 教わる → 教え返す → 穴が残る)。
  String get onboardingHowTitle => _pick('やることは、これだけ。', 'This is all you do.');
  String get onboardingStepCapture => _pick('わからない問題とノートを撮る',
      'Photograph the problem you are stuck on, with your notes');
  String get onboardingStepTaught => _pick(
      '先輩が板書つきで教えてくれる', 'Your senpai teaches you, working it out on the board');
  String get onboardingStepExplain =>
      _pick('「いまの、説明してみて」に答える', 'Answer: "Now explain that back to me"');
  String get onboardingStepKarte => _pick('詰まったところが、穴としてカルテに残る',
      'Wherever you stalled becomes a gap in your karte');

  /// 権限は使う直前に聞く。ここでは予告だけして、初回離脱を作らない。
  String get onboardingPermissionNote => _pick(
        'カメラ・マイク・通知の許可は、使う直前にお願いします',
        'We ask for camera, microphone and notification access only when they are needed',
      );

  /// 3枚目 — リハーサル。読むだけの説明を、**一度やってみる**に変える。
  ///
  /// 板書も質問も固定の台本。写真も撮らないし声も録らない
  /// (だから権限もまだ要らない)。
  String get onboardingTryTitle => _pick('ためしに、1問だけ。', 'Try it once.');
  String get onboardingTryNotebookLabel =>
      _pick('撮った問題', 'The problem you photographed');
  String get onboardingTryNotebook => _pick('x² − 4x + k = 0 が異なる2つの実数解をもつ',
      'x² − 4x + k = 0 has two distinct real roots');

  /// 板書の見出し。ここから下は、先輩が書いたもの。
  String get onboardingTryBoardLabel => _pick('先輩の板書', "Your senpai's board");

  /// 板書の1手順目。**日本語なので `text` 要素として置く**
  /// (LaTeXの中に日本語を入れると文字化けする・計画書§3-6d)。
  /// 2手順目は数式なので、ロケールを持たず Dart 側の定数にしてある。
  String get onboardingTryBoardText =>
      _pick('解が2つ ⇔ D > 0', 'Two roots ⇔ D > 0');

  /// 教え返してもらう番。**答えはもう上の板書に出ている。**
  /// それでも説明できるとは限らない、というのがこの1枚の主張。
  String get onboardingTryQuestion => _pick('じゃあ、いまの説明してみて。なんで D を見るんだっけ?',
      'Now explain it back — why do we look at D?');

  /// 長押しの案内。読み上げを使っている人にはタップに切り替える。
  String get onboardingTryHold => _pick('長押しして教え返す', 'Hold to teach it back');
  String get onboardingTryTap => _pick('タップして教え返す', 'Tap to teach it back');
  String get onboardingTryHolding => _pick('聞いています', 'Listening');
  String get onboardingTryHint => _pick('押したままにしてください', 'Keep holding');

  /// 本番と取り違えられると信頼を落とす。まだ録っていないことを先に言う。
  String get onboardingTryNotRecording =>
      _pick('ここではまだ録音しません', 'Nothing is recorded here yet');

  /// 反応は先輩の口調(ため口)。UIの案内文だけは敬体のまま分けてある。
  String get onboardingTrySaidReaction =>
      _pick('いいね。それが言えれば大丈夫。', 'Nice — if you can say that, you have it.');
  String get onboardingTrySaid => _pick(
        '判別式を見る理由を、自分の言葉で説明できた',
        'You explained why we look at the discriminant, in your own words',
      );

  /// パスは失敗ではない(§0 の約束3。ここは改正されていない)。
  /// 教える側に配役が変わっても、責めないことは変えない。
  String get onboardingTryHoleReaction =>
      _pick('大丈夫。ここが最初の穴だね。', "That's fine — this is your first gap.");
  String get onboardingTryHole => _pick('判別式を「なぜ」見るのかで、説明が止まった',
      'You stalled on why we look at the discriminant');
  String get onboardingTryAgain => _pick('もう一度ためす', 'Try that again');

  /// 4枚目 — リハーサルの結果が、そのままカルテの見本になる。
  String get onboardingKarteTitle => _pick('これが、カルテです。', 'This is your karte.');
  String get onboardingKarteBody => _pick(
        '教え返せたところは黄色、詰まったところはピンク。点数はつきません。',
        'What you taught back is yellow. Where you stalled is pink. There is no score.',
      );
  String get onboardingReviewTitle =>
      _pick('穴は、埋まるまでたずねます', 'We keep asking until the gap is filled');
  String get onboardingReviewTomorrow => _pick('あした', 'Tomorrow');
  String get onboardingReviewDay3 => _pick('3日後', 'In 3 days');
  String get onboardingReviewDay7 => _pick('7日後', 'In 7 days');

  /// 約束(1枚目)とやること(2枚目)は飛ばさせない。
  /// 出すのは、あとから足した2枚だけ。
  String get onboardingSkip => _pick('とばす', 'Skip');

  // --- ホーム ---
  //
  // ピボット(計画書§2)でコアループが「後輩に説明する」から
  // 「先輩に教わる → 教え返す」に変わった。あいさつも入口の名前も先輩のものにする。
  String get homeGreeting =>
      _pick('今日は、どこでつまずいた?', 'Where did you get stuck today?');

  /// 今日の入口。撮る → 授業モード(§4-1。従量原価が発生する側)。
  ///
  /// **「ノートを撮る」とは書かない。** 撮るのは手段で、
  /// ここでユーザーが選んでいるのは「教わる」こと。
  String get homeLesson => _pick('先輩に教わる', 'Get taught by your senpai');

  /// 自習室の入口(§4-2。無料・原価ゼロ)。
  String get homeStudyRoom => _pick('自習室に入る', 'Go to the study room');

  String streakDays(int days) => _pick('$days日つづけて説明中', '$days-day streak');
  String filledHoles(int count) => _pick('埋めた穴 $count', '$count gaps filled');

  /// ホームの復習カード。再訪の起点で、通知の着地先でもある。
  /// 詳細がまだ手元に無い短い間も、件数に逃げず内容のカードとして見せる。
  String get homeOpenHoleLabel => _pick('前に見つけた単元', 'A topic you found before');

  /// 今日はもう授業をしない、という**先輩の判断**(§6-3)。
  ///
  /// 「本日の残り回数 0/3」とは書かない。数字を見せた瞬間に不満になるし、
  /// 見えていれば残りの使い道を計算し始める。上限は制限ではなく
  /// 「詰め込みすぎても入らない」という先生の判断として出す。
  String get homeEnoughForToday => _pick(
        '今日はここまでにしよっか。詰め込みすぎても入らないから、明日また続きやろう。',
        "Let's call it a day. Cramming more won't stick — we'll pick this up tomorrow.",
      );

  /// 上の判断の隣に置く、契約への道。
  /// **「無制限にする」とは書かない**(§6-3 でフェアユース上限が入ったので、嘘になる)。
  String get homeUnlock => _pick('もっと教わる', 'Get more lessons');
  String get homeFirstRun => _pick('まだ穴はありません。最初の1問から始まります。',
      'No gaps yet. It starts with your first question.');

  // --- 撮影確認 ---
  String get captureConfirmTitle =>
      _pick('この単元で合っていますか?', 'Is this the right topic?');
  String get captureConfirmHint =>
      _pick('ちがっていたらタップして外せます', 'Tap to remove anything that is wrong');

  /// **「説明をはじめる」ではない。** ピボット前はここから生徒が説明していたが、
  /// いま始まるのは授業(先輩が板書つきで教える・§4-1)。
  String get captureStart => _pick('授業をはじめる', 'Start the lesson');

  // --- 撮ったものの確認(解析の前) ---

  /// 解析はセッションを作る = 今日の1回を使う操作なので、その前に一度だけ挟む。
  String get captureReviewTitle => _pick('撮れました', 'Got it');

  /// 枠の見出し。**ノートを「任意」に見せ替えない。**
  ///
  /// ノートが無くても始められるようにはなったが(手も付けていない問題を
  /// 持ってきた生徒のため)、**あるほうが良いことは変わっていない** —
  /// どこで手が止まったかが、先輩の切り分けの出発点になる。
  /// 「任意」と書くと、撮れる人まで撮らなくなる。
  String get capturePhotoNotes => _pick('ノート', 'Your notes');
  String get capturePhotoProblem => _pick('問題(任意)', 'The problem (optional)');

  /// まだ撮っていない枠の操作名。
  /// **「問題も撮る」とは書かない** — ノートを撮らない人には「も」が合わない。
  String get captureTakeNotes => _pick('ノートを撮る', 'Take your notes');
  String get captureAddProblem => _pick('問題を撮る', 'Take the problem');
  String get captureRetake => _pick('撮り直す', 'Retake');

  /// §4-1 の言い回しそのまま。**ヒントであって要求ではない。**
  /// 1枚に問題とノートの両方が写ることが多いので、2枚必須にすると
  /// 撮影の摩擦だけが増える。
  String get captureProblemHint => _pick(
        '問題も写っていると、先輩が迷子になりません',
        "If the problem is in the shot too, your senpai won't get lost",
      );

  /// 枠を分けている理由を、そのまま利点として書く。
  /// 教科書・問題集の紙面は他者の著作物なので、解析後に破棄される(§4-1)。
  String get captureProblemDiscarded => _pick(
        '問題の写真は、読み取ったあとに消えます',
        'The photo of the problem is deleted once it has been read',
      );

  /// 読み取った問題文の見出し。**誤読がいちばん早く表面化する場所。**
  ///
  /// 「合っていますか?」と聞かない。ここで直す手段が無い(セッションは
  /// もう作られている)のに問いかけると、答えようのない問いになる。
  /// 事実として置いておけば、ちがっていれば会話の最初に本人が言う —
  /// それが計画書 §1-1 の「誤読の保険」そのもの。
  String get captureProblemTitle =>
      _pick('先輩は、この問題だと思っています', 'This is the problem your senpai sees');

  /// カメラを断られたとき。黙ってホームに戻さない。
  String get captureCameraDenied => _pick(
        'カメラを使えませんでした。設定アプリから許可すると、ノートを撮れます。',
        "We couldn't use the camera. Allow it in Settings to photograph your notes.",
      );
  String get captureOpenSettings => _pick('設定をひらく', 'Open Settings');

  /// カメラを開けなかったとき(許可はあるが端末側の理由)。許可の話と混ぜない。
  String get captureCameraFailed => _pick('カメラを開けませんでした。もう一度おためしください。',
      "We couldn't open the camera. Please try again.");

  /// Premium のフェアユース上限。数や課金導線ではなく、先輩の判断として締める。
  String get captureFairUseLimitReached => _pick(
        '今日はここまでにしよっか。詰め込みすぎても入らないから。明日また続きやろう。',
        "Let's call it a day. Cramming more won't stick — we'll pick this up tomorrow.",
      );

  // --- 会話 ---
  String get sessionListening => _pick('聞いています', 'Listening');
  String get sessionThinking => _pick('考えています', 'Thinking');

  /// 会話が終わって、カルテを書いているあいだ。
  ///
  /// **何が起きているかを書く。** 「考えています」のままだと会話が続いて
  /// いるように見えて、もう一度「今日はここまで」を押させてしまう。
  String get sessionSummarizing => _pick('カルテを書いています…', 'Writing your karte…');

  /// つないでから先輩が入ってくるまで。無言の数秒を「止まっている」に見せない。
  String get sessionConnecting => _pick('先輩を呼んでいます…', 'Getting your senpai…');

  /// 授業モード(計画書§4-1)。先輩が板書を書き始めたが、まだ何も喋っていないとき。
  ///
  /// **「聞いています」を出さない。**聞いているのはこちらではなく生徒のほうで、
  /// いま起きているのは説明。字幕の初期値をここで取り違えると、
  /// 板書が出ているのに「話しかけないと進まない画面」に見える。
  String get sessionSenpaiTeaching =>
      _pick('先輩が説明しています', 'Your senpai is explaining');

  /// 教え返し。板書は残したまま、こちらが喋る番になったとき
  /// (コアループ §2「じゃあ今の、説明してみて」)。
  String get sessionExplainBack => _pick('説明してみて', 'Now you explain it');

  /// 板書がとぎれたとき(封筒の欠落・順序違反を検知した)。
  ///
  /// **黙って虫食いのまま出さない。**抜けたことに気づけないと、
  /// 抜けたやり方のまま覚えてしまう。落としたのはこちら側なので、
  /// 生徒のせいに読める言い方にはしない。
  String get sessionBoardGap => _pick(
        '板書はここまでしか届きませんでした。続きは先輩に聞いてください。',
        'The board only came through this far. Ask your senpai for the rest.',
      );
  String get sessionPass => _pick('うまく言えない', "I can't explain this yet");

  /// パスは画面だけで完結させず、先輩にも伝える(教え方を変えてもらう)。
  String get sessionPassMessage => _pick(
        'うまく言えません。ちがう聞き方をしてもらえますか?',
        "I can't explain this yet. Could you ask it a different way?",
      );
  String get sessionEnd => _pick('今日はここまで', "That's it for today");

  /// つながらなかったとき。**「聞いています」のまま黙らせない。**
  String get sessionConnectionFailed => _pick(
        'つながりませんでした。電波のいいところで、もう一度おためしください。',
        "We couldn't connect. Try again where the signal is better.",
      );

  /// ルームには入れたが、先輩が来なかった(エージェント側の問題)。
  /// ユーザーのせいではないので、そう読める言い方にする。
  String get sessionSenpaiUnavailable => _pick(
        '先輩が来られませんでした。少し時間をおいて、もう一度呼んでみてください。',
        "Your senpai couldn't make it. Give it a moment and try again.",
      );
  String get sessionRetry => _pick('もう一度呼ぶ', 'Try again');
  String get sessionBackHome => _pick('ホームにもどる', 'Back to home');
  String remaining(int seconds) {
    final String minutes = (seconds ~/ 60).toString();
    final String rest = (seconds % 60).toString().padLeft(2, '0');
    return _pick('のこり $minutes:$rest', '$minutes:$rest left');
  }

  // --- 祝福 ---
  String get celebrationThanks =>
      _pick('説明、ありがとうございました', 'Thanks for explaining');
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
      _pick('あしたの夜、先輩がもう一度きいてきます', 'Your senpai will ask again tomorrow night');

  /// 通知の許可を求める場所はここだけ。穴が見えた直後に、先輩からのお願いとして聞く。
  ///
  /// **疑問符を落とさないこと。** ここを「あしたの夜、もう一度きくね」と
  /// 言い切りに直すと、許可を求める文が予告に変わる。先輩は言い切れる立場なので、
  /// 頼む形にしてあること自体が約束4の歯止めになっている。
  String get karteReviewAsk =>
      _pick('あしたの夜、もう一度きいてもいい?', 'Mind if I ask you again tomorrow night?');
  String get karteReviewDenied => _pick(
        '通知が切れています。設定アプリから戻せます。',
        'Notifications are off. You can turn them back on in Settings.',
      );

  /// カルテの生成が会話直後に間に合わなかったとき。作り直しではなく取りに行く。
  String get karteRetrieve => _pick('カルテを取りに行く', 'Fetch my karte');
  String get karteRetrieving => _pick('取りに行っています…', 'Fetching…');

  /// 待っているあいだ、押せないボタンの上に置く説明。
  ///
  /// ボタンの文言だけだと、**押せないボタンが出ているだけ**にしか見えない。
  /// 何を待っているのか(と、待てば届くこと)をここで言う。
  String get karteWriting => _pick(
        '先輩がカルテを書いています。届いたら、ここに出ます。',
        'Your senpai is writing your karte. It will appear here when it is ready.',
      );

  /// 待つと決めた時間ぶん待っても届かなかった。行き止まりにしないための言い方。
  String get karteTakingLong => _pick(
        '思ったより時間がかかっています。もう一度取りに行けます。',
        "It's taking longer than expected. You can try fetching it again.",
      );
  String get karteStillCooking => _pick(
        'まだ書いている途中でした。少しあとで、もう一度おためしください。',
        "It's still being written. Please try again in a moment.",
      );
  String get karteRetry => _pick('言い直してみる', 'Explain it again');
  String get karteDone => _pick('今日はここまで', "That's it for today");

  // --- 復習 ---
  String get reviewTitle => _pick('埋めにいく穴', 'Gaps to fill');
  String get reviewStart => _pick('30秒で説明する', 'Explain in 30 seconds');
  String get reviewLocked =>
      _pick('穴の復習はPremiumの機能です', 'Reviewing past gaps is a Premium feature');

  /// 埋めた穴のセクション。ペイウォールが謳う「履歴」はここで果たす。
  String reviewFilledTitle(int count) =>
      _pick('埋めた穴 — $count つ', 'Gaps filled — $count');
  String get reviewFilledEmpty =>
      _pick('ここに、埋めた穴がたまっていきます', 'The gaps you fill will collect here');
  String reviewFilledDays(int days) => switch (days) {
        0 => _pick('今日 埋めた', 'Filled today'),
        1 => _pick('きのう 埋めた', 'Filled yesterday'),
        _ => _pick('$days日前に埋めた', 'Filled $days days ago'),
      };

  /// 穴がひとつも無いとき。「何もない」ではなく「今は無い」として見せる。
  String get reviewEmpty =>
      _pick('いまは、埋めにいく穴がありません', 'There are no gaps waiting right now');
  String get reviewBackHome => _pick('ホームにもどる', 'Back to home');

  // --- 設定 ---
  String get settingsTitle => _pick('設定', 'Settings');
  String get settingsSectionAccount => _pick('契約', 'Subscription');
  String get settingsSectionNotifications => _pick('通知', 'Notifications');
  String get settingsSectionAbout => _pick('このアプリについて', 'About');

  /// 1/3/7日の再訪のトグル。**ここが約束4のいちばん危ないところ。**
  ///
  /// 後輩の「再説明のお願い」は、構造的に煽れなかった —
  /// 教わる側からの**お願い**なので、断れるし、催促に読みようがない。
  /// 先輩は「勉強しろ」と言える立場なので、同じ枠に
  /// 「リマインド」「忘れていませんか」を入れると、その瞬間に催促になる。
  ///
  /// なので**届くものの中身**で名づける(誰が命じるか、ではなく)。
  /// 英語も `Reminders`(=催促の語)を避ける。
  String get settingsNotifications =>
      _pick('先輩からのおさらい', 'Check-backs from your senpai');
  String get settingsNotificationsOn => _pick('届きます', 'On');
  String get settingsNotificationsOff => _pick('届きません', 'Off');
  String get settingsNotificationsOpenSettings =>
      _pick('通知の設定をひらく', 'Open notification settings');
  String get settingsPrivacy => _pick('プライバシーポリシー', 'Privacy policy');
  String get settingsTerms => _pick('利用規約', 'Terms of use');

  /// AI生成物の報告導線。App Review で見られる(handoff §5)。
  ///
  /// **報告してほしい中身が、憲法改正で変わった。** 旧版は
  /// 「答えを教えてしまっている」を報告理由に挙げていたが、いまは答えを教えるのが
  /// 約束1(§0)なので、それは不具合ではなく仕様。代わりに、教えるようになったことで
  /// 初めて危険になったもの —**間違ったことを教える**— を先頭に置く。
  /// 報告の対象も質問だけでなく板書と説明を含むので、そう書く。
  String get settingsReport =>
      _pick('気になった内容を報告する', 'Report something that felt wrong');
  String get settingsReportBody => _pick(
        '先輩の説明や板書、質問が、問題と関係ない・間違っている・不快だった場合に送ってください。',
        "Tell us if your senpai's explanation, board or question was off-topic, "
            'incorrect, or felt wrong.',
      );
  String get settingsVersion => _pick('バージョン', 'Version');
  String get settingsDeviceId =>
      _pick('端末ID(問い合わせ用)', 'Device ID (for support)');
  String get settingsCopied => _pick('コピーしました', 'Copied');
  String get settingsOpenFailed => _pick('ひらけませんでした。あとで試してみてください。',
      "We couldn't open that. Please try again later.");

  // --- ペイウォール ---
  String get paywallTitle => _pick('穴を、埋めきる。', 'Fill every gap.');
  String get paywallPrice => _pick(
      'Premium ¥580/月 ・ はじめの7日間は無料', 'Premium ¥580/month · First 7 days free');

  /// ペイウォールを**開く**ボタン(復習画面など)。ここで無料日数を約束しない。
  /// ストアの商品にトライアルが付いているかは、Offering を読むまで分からない。
  String get paywallCta => _pick('Premiumをみる', 'See Premium');

  /// 購入ボタン。トライアルがあるときは [planFreeTrial] に差し替わる。
  String get paywallSubscribe => _pick('このプランではじめる', 'Start with this plan');
  String get paywallDismiss => _pick('無料のまま続ける', 'Keep using the free version');

  /// 自動更新であることは購入画面に書く義務がある(Guideline 3.1.2)。
  /// 「解約できます」だけでは、更新されることを伝えたことにならない。
  String get paywallCancelNote => _pick('登録は自動更新されます。いつでも解約できます',
      'Your subscription renews automatically. Cancel anytime');
  String get paywallFree => _pick('無料', 'Free');
  String get paywallPremium => _pick('Premium', 'Premium');
  String get paywallRowSessions => _pick('セッション', 'Sessions');
  String get paywallRowKarte => _pick('カルテ', 'Karte');
  String get paywallRowFollowup => _pick('先輩のあと追い質問', 'Follow-up questions');
  String get paywallEverydayOne => _pick('毎日1問', 'One question every day');
  String get paywallEverydayQuestions => _pick('毎日、何問でも', 'Questions every day');
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

  // --- 購入のお礼 ---
  //
  // 「ご購入ありがとうございます」と書けない場合が3つある。
  // 無料トライアル(まだ1円も払っていない)・復元(買い直していない)・
  // 決済は通ったが未反映(祝ってはいけない)。見出しを分けているのはそのため。

  /// 買った。素直にお礼を言っていい唯一のケース。
  String get thanksTitle => _pick('ありがとうございます', 'Thank you');
  String get thanksBody =>
      _pick('これから、いくらでも聞きます。', 'From now on, ask me as much as you like.');

  /// 無料トライアルが始まった。**お礼ではなく、事実から書く。**
  String thanksTrialTitle(int days) =>
      _pick('$days日間、ぜんぶ使えます', 'Everything is open for $days days');

  /// 期限が読めなかったとき。日数を騙るくらいなら、日数を言わない。
  /// ここでお礼に落とすと、払っていない人にお礼を言うことになる。
  String get thanksTrialTitlePlain => _pick('ぜんぶ、使えます', 'Everything is open');

  /// 課金がいつ始まるかを、先に、はっきり言う(§6)。
  String thanksTrialBody(String date) => _pick('$date までは無料です。その日から請求が始まります。',
      "It's free until $date. Billing starts that day.");

  /// 機種変更などで戻ってきた人。買い直していないので、お礼は言わない。
  String get thanksRestoredTitle => _pick('おかえりなさい', 'Welcome back');
  String thanksRestoredBody(String date) =>
      _pick('契約は $date まで有効です。', 'Your subscription is active until $date.');

  /// 解放されたもの。ペイウォールの比較表と同じ3つを、同じ順で出す。
  String get thanksUnlockedSessions =>
      _pick('1日1回の上限がなくなりました', 'The once-a-day limit is gone');
  String get thanksUnlockedHistory =>
      _pick('埋めた穴が、ぜんぶ残ります', 'Every gap you fill stays on record');
  String get thanksUnlockedFollowup =>
      _pick('先輩があと追いで質問します', 'Your senpai follows up with more questions');

  String get thanksStart => _pick('はじめる', 'Get started');

  /// 自動更新であることは、祝っている画面でも省かない(Guideline 3.1.2)。
  String thanksRenewsOn(String date) =>
      _pick('$date に更新されます・いつでも解約できます', 'Renews on $date · Cancel anytime');
  String get thanksCancelAnytime => _pick('いつでも解約できます', 'Cancel anytime');

  // --- 購入の復元・契約の管理 ---
  String get paywallRestore => _pick('購入を復元する', 'Restore purchases');
  // 復元できたときの文言はここに無い。SnackBar ではなく、
  // お礼の画面([ThanksScreen])が「おかえりなさい」を出す。
  String get paywallRestoredNothing => _pick('このアカウントに、復元できる購入は見つかりませんでした',
      'No previous purchases were found for this account');
  String get manageSubscription => _pick('契約の管理', 'Manage subscription');
  String premiumEndsOn(String date) => _pick('$date に終わります。それまではこのまま使えます',
      'Ends on $date. Everything stays available until then');
  String premiumRenewsOn(String date) =>
      _pick('$date に更新されます', 'Renews on $date');
  String premiumBillingStarts(String date) =>
      _pick('$date から請求が始まります', 'Billing starts on $date');

  /// 契約している印。ホーム右上と設定に出す。
  ///
  /// **ランクや称号ではない。** 数えるのは連続日数と埋めた穴だけなので
  /// (handoff §7)、ここは「今どっちの状態か」の表示に留める。
  /// 商品名なので日英で変えない。
  String get premiumBadge => 'Premium';
  String get premiumActive => _pick('有効', 'Active');
  String get premiumTrialBadge => _pick('無料おためし中', 'Free trial');

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
  String get purchaseErrorNotAllowed => _pick('この端末では購入できない設定になっています。',
      'This device is not allowed to make purchases.');
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

  String get errorGeneric => _pick('うまくいきませんでした。少し時間をおいて試してみてください。',
          'Something went wrong. Please try again shortly.');

  /// 圏外・タイムアウトなど、送信そのものが届かなかったとき。
  /// サーバの文言が返ってこない経路なので、アプリ側で持つ。
  String get errorNetwork => _pick(
        'うまく送れませんでした。電波の届くところで、もう一度お願いします。',
        "We couldn't send that. Please try again where the signal is better.",
      );
  String get errorRetry => _pick('もう一度', 'Try again');

  // --- 先輩の表情(読み上げ用のラベル。`senpai_face.dart` の `SenpaiMood` と対応)---
  String get senpaiWaiting => _pick('先輩が待っています', 'Your senpai is waiting');
  String get senpaiListening => _pick('先輩が聞いています', 'Your senpai is listening');

  /// **教え返しが伝わった側の顔。** `just got it` のままだと
  /// 「先輩がいま単元を理解した」と読めてしまうので、納得の向きを変える。
  String get senpaiDelighted => _pick('先輩が納得しています', 'Your senpai is convinced');

  /// 困っているのは**先輩のほう**(`SenpaiMood.puzzled` の定義)。
  /// 生徒が詰まったときには出ないので、「考えています」ではなく困り顔として読む。
  String get senpaiPuzzled =>
      _pick('先輩が困っています', 'Your senpai is having trouble');

  // --- 板書の読み上げ(`board_speech.dart`)---
  //
  // 板書は `Math.tex` と `CustomPaint` で描かれていて、そのままでは
  // **VoiceOver から完全に不可視**。板書はプロダクトの中心なので、
  // ここが欠けると目が見えない生徒には授業が存在しないのと同じになる。
  //
  // **英字はそのまま残す。** 1文字の英字はスクリーンリーダーがロケールなりに
  // 読むので、「エックス」と書くと二重に読まれたり英語音声で崩れたりする。
  // 言葉にするのは**構造と記号**だけ。

  /// 分数。**日本語は「B分のA」で順序が逆になる。**
  String boardSpeechFraction(String numerator, String denominator) =>
      _pick('$denominator 分の $numerator', '$numerator over $denominator');
  String boardSpeechSquareRoot(String body) => _pick('ルート $body', 'square root of $body');
  String boardSpeechNthRoot(String n, String body) =>
      _pick('$n 乗根 $body', 'the $n-th root of $body');
  String boardSpeechPower(String exponent) => _pick('の $exponent 乗', 'to the power of $exponent');
  String boardSpeechSubscript(String index) => _pick('の 添字 $index', 'sub $index');
  String boardSpeechVector(String body) => _pick('ベクトル $body', 'vector $body');

  /// 図形は「厳密な読み上げ」より「**何が描かれているか**」で足りる。
  String boardSpeechTriangle(String vertices, String marks) => _pick(
        '三角形 $vertices。$marks',
        'Triangle $vertices. $marks',
      );
  String boardSpeechRightAngle(String vertex) => _pick('頂点 $vertex は直角', 'a right angle at $vertex');
  String boardSpeechAngle(String vertex, String label) =>
      _pick('頂点 $vertex の角は $label', 'the angle at $vertex is $label');
  String boardSpeechCircle(String radius, String labels) =>
      _pick('円。半径 $radius。$labels', 'A circle with radius $radius. $labels');
  String boardSpeechPlot(String fn, String min, String max, String marks) => _pick(
        'グラフ。$fn。x の範囲は $min から $max。$marks',
        'A graph of $fn for x from $min to $max. $marks',
      );

  /// 記号を言葉にする。**スクリーンリーダーごとの読み方の揺れを消す**ため、
  /// 記号のまま渡さずにこちらで言葉にしておく。
  Map<String, String> get boardSpeechSymbols => _ja
      ? const <String, String>{
          r'\cdot': ' かける ', r'\pm': ' プラスマイナス ', r'\leq': ' 以下 ',
          r'\geq': ' 以上 ', r'\neq': ' ノットイコール ', r'\to': ' に近づく ',
          r'\therefore': ' よって ', r'\because': ' なぜならば ',
          r'\sum': ' 総和 ', r'\int': ' 積分 ', r'\lim': ' 極限 ',
          r'\sin': ' サイン ', r'\cos': ' コサイン ', r'\tan': ' タンジェント ',
          r'\log': ' ログ ', r'\theta': ' シータ ', r'\alpha': ' アルファ ',
          r'\beta': ' ベータ ', r'\pi': ' パイ ',
          '=': ' イコール ', '+': ' プラス ', '-': ' マイナス ',
          '<': ' 小なり ', '>': ' 大なり ', '(': ' かっこ ', ')': ' かっことじ ',
        }
      : const <String, String>{
          r'\cdot': ' times ', r'\pm': ' plus or minus ', r'\leq': ' less than or equal to ',
          r'\geq': ' greater than or equal to ', r'\neq': ' not equal to ',
          r'\to': ' approaches ', r'\therefore': ' therefore ', r'\because': ' because ',
          r'\sum': ' the sum of ', r'\int': ' the integral of ', r'\lim': ' the limit of ',
          r'\sin': ' sine ', r'\cos': ' cosine ', r'\tan': ' tangent ',
          r'\log': ' log ', r'\theta': ' theta ', r'\alpha': ' alpha ',
          r'\beta': ' beta ', r'\pi': ' pi ',
          '=': ' equals ', '+': ' plus ', '-': ' minus ',
          '<': ' less than ', '>': ' greater than ', '(': ' open bracket ',
          ')': ' close bracket ',
        };

  // --- 自習室(§4-2。無料・原価ゼロ)---
  //
  // **マイクを開かない。STTもTTSもサーバ通信も動かさない。** それが原価ゼロの根拠なので、
  // ここの文言は「先輩が黙って隣にいる」以上のことを約束しない。
  //
  // 下の声かけは、いまはテキストの吹き出しだけ。計画書§4-2 は
  // 「事前生成した音声アセットの再生(TTS呼び出しゼロ)」を求めているが、
  // アセットがまだ無いので、この段では文字で出す。
  String get studyRoomTitle => _pick('自習室', 'Study room');

  /// 経過時間。数字そのものなので日英で変えない(`12:34`)。
  String studyRoomElapsed(int seconds) {
    final String minutes = (seconds ~/ 60).toString().padLeft(2, '0');
    final String rest = (seconds % 60).toString().padLeft(2, '0');
    return '$minutes:$rest';
  }

  /// 経過時間の読み上げ。秒まで読み上げても意味がないので分だけ渡す。
  String studyRoomElapsedLabel(int minutes) =>
      _pick('自習をはじめて$minutes分', '$minutes minutes into this session');

  /// 自習室でだけ、顔の既定のラベル(「先輩が待っています」)を上書きする。
  /// ここで価値になっているのは待つことではなく**となりにいること**(§4-2)。
  String get studyRoomSenpaiHere =>
      _pick('先輩がとなりにいます', 'Your senpai is here with you');

  /// 残っている板書。**この画面の主役**(§4-2「さっきの板書が残っている」)。
  String get studyRoomBoardTitle => _pick('さっきの板書', 'The board from earlier');
  String get studyRoomBoardEmpty => _pick(
        '板書はまだありません。先輩に1問教わると、ここに残ります。',
        'Nothing on the board yet. Once your senpai teaches you a question, it stays here.',
      );

  /// 板書が途中で切れていることの印(配送の欠落)。
  ///
  /// **失敗を報告する文にしない。** ユーザーには直せないし、自習室は
  /// 配送の失敗を蒸し返す場所ではない。それでも黙ってはいけないのは、
  /// 黙ると計画書§3-6b が横スクロールを却下した理由 —「これで全部だ」と
  /// 誤読させる — をそのまま再現するから。事実を一行だけ置く。
  String get studyRoomBoardTruncated =>
      _pick('ここから先は残っていません', "The rest of this board wasn't saved");

  /// **ここが課金の切れ目**(§4-2)。押すと授業モードが立ち上がる。
  String get studyRoomAsk => _pick('先輩、ちょっといい?', 'Senpai, got a minute?');
  String get studyRoomLeave => _pick('自習をおえる', 'Finish studying');

  /// マイクを開いていないことは、黙っていないで書く。
  /// 「先輩が隣にいる画面」は、聞かれていると誤解されうる形をしている。
  String get studyRoomMicOff => _pick('マイクは開いていません', 'Your mic is off');

  /// 先輩の声かけ。経過時間から引く(タイマーを増やさない)。
  String get studyRoomNudgeStart => _pick('じゃ、やってこっか。わからなくなったら呼んで',
      "Alright, get to it. Call me when you get stuck");
  String get studyRoomNudgeGoing => _pick('順調?', "How's it going?");
  String get studyRoomNudgeBreak => _pick('そろそろ休憩する?', 'Want to take a break?');
  String get studyRoomNudgeLong =>
      _pick('けっこう集中してるね。ひと息ついてきな', "You've been at this a while — go stretch");
}

class AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const AppStringsDelegate();

  @override
  bool isSupported(Locale locale) => AppStrings.supportedLocales
      .any((Locale it) => it.languageCode == locale.languageCode);

  @override
  Future<AppStrings> load(Locale locale) async => AppStrings(locale);

  @override
  bool shouldReload(AppStringsDelegate old) => false;
}
