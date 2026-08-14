import 'package:flutter/widgets.dart';

/// Two locales, Japanese and English.
///
/// Hand-written rather than arb + codegen so `flutter test` passes without a
/// codegen step (the repo has to work standalone). If the copy outgrows this,
/// move to flutter_localizations' generator.
@immutable
class AppStrings {
  const AppStrings(this.locale);

  final Locale locale;

  static const List<Locale> supportedLocales = <Locale>[
    Locale('ja'),
    Locale('en')
  ];

  /// Device language -> app language.
  ///
  /// Flutter defaults to the first entry in supportedLocales on no match, so
  /// doing nothing shows Japanese on a Spanish device. Japanese goes only to
  /// people who asked for it; everyone else gets English.
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

  /// Entry point for layers without a BuildContext (controllers). Pass the same
  /// language code sent to the API; unsupported languages fall back to Japanese.
  static AppStrings forLanguage(String languageCode) =>
      AppStrings(Locale(languageCode));

  bool get _ja => locale.languageCode == 'ja';

  String _pick(String ja, String en) => _ja ? ja : en;

  // --- Onboarding ---

  /// Page 1 — the promise.
  ///
  /// The line break is placed deliberately, always at the beat between the two
  /// halves. "We teach you" alone reads like any free AI, so both halves need
  /// equal visual weight.
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

  /// Page 2, showing what the time is for before anything else. The four lines
  /// are the core loop: shoot, get taught, teach back, a gap remains.
  String get onboardingHowTitle => _pick('やることは、これだけ。', 'This is all you do.');
  /// Notes are never a condition. "Photograph the problem and your notes" tells
  /// a student stuck with nothing written that this is not for them, right in the
  /// first explanation — and being stuck is a tutor's core business. Notes are
  /// still better to have, so they stay in parentheses.
  String get onboardingStepCapture => _pick('わからない問題を撮る(ノートがあれば一緒に)',
      "Photograph the problem you are stuck on (with your notes, if you have them)");
  String get onboardingStepTaught => _pick(
      '先輩が板書つきで教えてくれる', 'Your senpai teaches you, working it out on the board');
  String get onboardingStepExplain =>
      _pick('「いまの、説明してみて」に答える', 'Answer: "Now explain that back to me"');
  String get onboardingStepKarte => _pick('詰まったところが、穴としてカルテに残る',
      'Wherever you stalled becomes a gap in your karte');

  /// Permissions are asked just before use. This only forewarns, so nothing
  /// drives people away on first run.
  String get onboardingPermissionNote => _pick(
        'カメラ・マイク・通知の許可は、使う直前にお願いします',
        'We ask for camera, microphone and notification access only when they are needed',
      );

  /// Page 3 — the rehearsal, turning an explanation you only read into one you
  /// do once.
  ///
  /// Board and question are a fixed script; no photos and no recording, so no
  /// permissions are needed yet.
  String get onboardingTryTitle => _pick('ためしに、1問だけ。', 'Try it once.');
  String get onboardingTryNotebookLabel =>
      _pick('撮った問題', 'The problem you photographed');
  String get onboardingTryNotebook => _pick('x² − 4x + k = 0 が異なる2つの実数解をもつ',
      'x² − 4x + k = 0 has two distinct real roots');

  /// The board heading; everything below it is what senpai wrote.
  String get onboardingTryBoardLabel => _pick('先輩の板書', "Your senpai's board");

  /// The board's first step. It is prose, so it goes in a `text` element —
  /// Japanese inside LaTeX renders as mojibake. Step two is a formula, so it
  /// carries no locale and lives as a Dart constant.
  String get onboardingTryBoardText =>
      _pick('解が2つ ⇔ D > 0', 'Two roots ⇔ D > 0');

  /// Their turn to teach it back. The answer is already on the board above, and
  /// this page's claim is that having it does not mean you can explain it.
  String get onboardingTryQuestion => _pick('じゃあ、いまの説明してみて。なんで D を見るんだっけ?',
      'Now explain it back — why do we look at D?');

  /// The press-and-hold prompt; screen reader users get tap instead.
  String get onboardingTryHold => _pick('長押しして教え返す', 'Hold to teach it back');
  String get onboardingTryTap => _pick('タップして教え返す', 'Tap to teach it back');
  String get onboardingTryHolding => _pick('聞いています', 'Listening');
  String get onboardingTryHint => _pick('押したままにしてください', 'Keep holding');

  /// Being mistaken for the real thing costs trust, so say up front that nothing
  /// is being recorded yet.
  String get onboardingTryNotRecording =>
      _pick('ここではまだ録音しません', 'Nothing is recorded here yet');

  /// Reactions use senpai's casual register; UI guidance stays formal and is
  /// kept separate.
  String get onboardingTrySaidReaction =>
      _pick('いいね。それが言えれば大丈夫。', 'Nice — if you can say that, you have it.');
  String get onboardingTrySaid => _pick(
        '判別式を見る理由を、自分の言葉で説明できた',
        'You explained why we look at the discriminant, in your own words',
      );

  /// Passing is not failure, and that has not changed with senpai teaching: no
  /// blame either way.
  String get onboardingTryHoleReaction =>
      _pick('大丈夫。ここが最初の穴だね。', "That's fine — this is your first gap.");
  String get onboardingTryHole => _pick('判別式を「なぜ」見るのかで、説明が止まった',
      'You stalled on why we look at the discriminant');
  String get onboardingTryAgain => _pick('もう一度ためす', 'Try that again');

  /// Page 4 — the rehearsal's outcome becomes the sample karte.
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

  /// The promise (page 1) and the loop (page 2) cannot be skipped; the control
  /// appears only on the two pages added later.
  String get onboardingSkip => _pick('とばす', 'Skip');

  // --- Home ---
  //
  // The core loop changed from "explain to a junior" to "get taught by senpai,
  // then teach it back", so greetings and entry labels are senpai's.
  String get homeGreeting =>
      _pick('今日は、どこでつまずいた?', 'Where did you get stuck today?');

  /// Greeting on a day senpai has closed out.
  ///
  /// Left as a question it would ask "where did you get stuck?" and then refuse
  /// the photo. The greeting must not contradict the action below it.
  String get homeGreetingDone =>
      _pick('今日はよくがんばったね', 'You put in good work today');

  /// Today's entrance: shoot, then lesson mode (the metered-cost side).
  ///
  /// It does not say "photograph your notes". Shooting is the means; what is
  /// being chosen here is being taught.
  String get homeLesson => _pick('先輩に教わる', 'Get taught by your senpai');

  String streakDays(int days) => _pick('$days日つづけて説明中', '$days-day streak');
  String filledHoles(int count) => _pick('埋めた穴 $count', '$count gaps filled');

  /// Home's review card: the start of a return visit and the notification's
  /// landing spot. Even while details are still loading it shows content rather
  /// than falling back to a count.
  String get homeOpenHoleLabel => _pick('前に見つけた単元', 'A topic you found before');

  /// Senpai's decision that there are no more lessons today.
  ///
  /// Never "0/3 left today". A number turns into a grievance on sight, and a
  /// visible remainder gets budgeted. The limit is presented as a teacher's
  /// judgement that cramming more in will not stick, not as a restriction.
  String get lessonEnoughForToday => _pick(
        '今日はここまでにしよっか。詰め込みすぎても入らないから。明日また続きやろう。',
        "Let's call it a day. Cramming more won't stick — we'll pick this up tomorrow.",
      );

  /// The path to subscribing, beside the decision above. It never says
  /// "unlimited" — a fair-use cap exists, so that would be a lie.
  String get homeUnlock => _pick('もっと教わる', 'Get more lessons');
  String get homeFirstRun => _pick('まだ穴はありません。最初の1問から始まります。',
      'No gaps yet. It starts with your first question.');

  // --- Capture confirmation ---
  String get captureConfirmTitle =>
      _pick('この単元で合っていますか?', 'Is this the right topic?');
  String get captureConfirmHint =>
      _pick('ちがっていたらタップして外せます', 'Tap to remove anything that is wrong');

  /// Not "start explaining". Before the pivot the student explained from here;
  /// now what starts is a lesson, with senpai teaching on the board.
  String get captureStart => _pick('授業をはじめる', 'Start the lesson');

  // --- Reviewing what was shot (before analysis) ---

  /// Heading when nothing has been shot yet; it appears before the camera.
  ///
  /// It asks what you have rather than telling you to photograph your notes, so
  /// having none reads as a state rather than a shortfall. The notes camera used
  /// to open on entry, leaving a stuck student at the shutter without ever seeing
  /// the problem slot (see `capture_screen.dart`).
  String get captureChooseTitle => _pick('何が手元にある?', 'What do you have?');

  /// Analysis creates a session — the operation that spends today's use — so one
  /// confirmation step is inserted before it.
  String get captureReviewTitle => _pick('撮れました', 'Got it');

  /// Hint when nothing has been shot: it grants permission to have no notes.
  ///
  /// Silence here leaves a stuck student no path but putting the page in the
  /// notes slot (the "remaining hole" `sessionPhotoParts` in `api.ts` names). No
  /// blame and no questions — just "if you haven't started yet", so whoever it
  /// applies to can pick it up themselves.
  String get captureEitherIsFine => _pick(
        'どちらか1枚で始められます。まだ手をつけていないなら、問題だけで大丈夫。',
        "Either one is enough to start. If you haven't tried it yet, just the problem is fine.",
      );

  /// Slot heading. Notes are never relabelled "optional".
  ///
  /// You can now start without notes (for a student who brought a problem they
  /// have not touched), but having them is still better: where your hand stopped
  /// is senpai's starting point for narrowing things down. Labelling it optional
  /// stops even people who could shoot notes from doing so.
  ///
  /// "(optional)" was dropped from the problem side too: on only one of them, the
  /// other reads as required. For a student without notes that inverts it — the
  /// one thing they can offer is marked optional and the one they cannot looks
  /// mandatory. [captureEitherIsFine] already says one is enough, so the slots
  /// carry names only.
  String get capturePhotoNotes => _pick('ノート', 'Your notes');
  String get capturePhotoProblem => _pick('問題', 'The problem');

  /// Action label for an empty slot. It avoids "photograph the problem too" —
  /// the "too" does not fit someone who is not shooting notes.
  String get captureTakeNotes => _pick('ノートを撮る', 'Take your notes');
  String get captureAddProblem => _pick('問題を撮る', 'Take the problem');
  String get captureRetake => _pick('撮り直す', 'Retake');

  /// A hint, not a requirement. One shot often captures both problem and notes,
  /// so requiring two would only add friction.
  ///
  /// Shown only to people who shot notes. Telling someone who shot the problem
  /// first (i.e. has no notes) that "including the problem helps" would nag them
  /// about something they already did.
  String get captureProblemHint => _pick(
        '問題も写っていると、先輩が迷子になりません',
        "If the problem is in the shot too, your senpai won't get lost",
      );

  /// States the reason for separate slots as a benefit: a textbook or workbook
  /// page is someone else's work, so it is discarded after analysis.
  String get captureProblemDiscarded => _pick(
        '問題の写真は、読み取ったあとに消えます',
        'The photo of the problem is deleted once it has been read',
      );

  /// Heading for the problem text that was read — the earliest place a
  /// misreading surfaces.
  ///
  /// It does not ask "is this right?". There is no way to fix it here (the
  /// session already exists), so asking would be unanswerable. Stated as fact,
  /// anyone who sees it is wrong says so at the start of the conversation, which
  /// is the insurance itself.
  String get captureProblemTitle =>
      _pick('先輩は、この問題だと思っています', 'This is the problem your senpai sees');

  /// When the camera is denied. Never silently drop back to home.
  ///
  /// It does not name which slot they came from: replying "you can photograph
  /// your notes" to someone shooting the problem because they have none piles
  /// irrelevance on top of a refusal.
  String get captureCameraDenied => _pick(
        'カメラを使えませんでした。設定アプリから許可すると、撮れるようになります。',
        "We couldn't use the camera. Allow it in Settings and you'll be able to take the photo.",
      );
  String get captureOpenSettings => _pick('設定をひらく', 'Open Settings');

  /// When the camera would not open despite permission (a device-side reason).
  /// Kept separate from the permission message.
  String get captureCameraFailed => _pick('カメラを開けませんでした。もう一度おためしください。',
      "We couldn't open the camera. Please try again.");

  // --- Conversation ---
  String get sessionListening => _pick('聞いています', 'Listening');
  String get sessionThinking => _pick('考えています', 'Thinking');

  /// While the conversation is over and the karte is being written.
  ///
  /// It says what is happening. "Thinking" would look like the conversation is
  /// still going and invite another tap on "done for today".
  String get sessionSummarizing => _pick('カルテを書いています…', 'Writing your karte…');

  /// Between connecting and senpai joining, so the silent seconds do not look
  /// like a stall.
  String get sessionConnecting => _pick('先輩を呼んでいます…', 'Getting your senpai…');

  /// Lesson mode: senpai has started writing but has not spoken yet.
  ///
  /// It never says "listening". The listener is the student, and what is
  /// happening is an explanation. Getting the caption's initial value wrong here
  /// makes a screen with a board look like it needs to be spoken to.
  String get sessionSenpaiTeaching =>
      _pick('先輩が説明しています', 'Your senpai is explaining');

  /// Teaching back: our turn to speak, with the board still up.
  String get sessionExplainBack => _pick('説明してみて', 'Now you explain it');

  /// Heading for the problem shown during a lesson.
  ///
  /// Deliberately different wording from capture's `captureProblemTitle`: that
  /// one is a pre-lesson check that senpai has the right problem, this one is a
  /// label saying what is being solved right now. Reusing the same sentence would
  /// park a confirmation question permanently above the board.
  String get sessionProblemTitle => _pick('問題', 'The problem');

  /// Expands the problem collapsed to three lines. It is collapsed so it cannot
  /// push the board off screen (the contract allows 600 characters).
  String get sessionProblemExpand => _pick('続きを読む', 'Read more');
  String get sessionProblemCollapse => _pick('畳む', 'Show less');

  /// When the board is truncated (a missing envelope or ordering violation).
  ///
  /// A hole-riddled board is never shown silently: not noticing the gap means
  /// learning the method with the gap in it. We dropped it, so the wording must
  /// never read as the student's fault.
  String get sessionBoardGap => _pick(
        '板書はここまでしか届きませんでした。続きは先輩に聞いてください。',
        'The board only came through this far. Ask your senpai for the rest.',
      );
  String get sessionPass => _pick('うまく言えない', "I can't explain this yet");

  /// A pass is not kept to the screen; senpai is told, so the teaching can change.
  String get sessionPassMessage => _pick(
        'うまく言えません。ちがう聞き方をしてもらえますか?',
        "I can't explain this yet. Could you ask it a different way?",
      );
  String get sessionEnd => _pick('今日はここまで', "That's it for today");

  /// When the connection failed. Never leave it silently on "listening".
  String get sessionConnectionFailed => _pick(
        'つながりませんでした。電波のいいところで、もう一度おためしください。',
        "We couldn't connect. Try again where the signal is better.",
      );

  /// Joined the room but senpai never came (an agent-side problem). It is not the
  /// user's fault, and the wording says so.
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

  // --- Celebration ---
  String get celebrationThanks =>
      _pick('説明、ありがとうございました', 'Thanks for explaining');
  String celebrationFilled(int count) =>
      _pick('穴が$count つ、埋まりました', '$count gaps filled');

  // --- Karte ---
  String get karteTitle => _pick('今日のカルテ', "Today's karte");
  String get karteSaidWell => _pick('言えたこと', 'What you explained');
  String karteHoles(int count) => _pick('穴 — $count つ', 'Gaps — $count');
  String get karteTermNotes => _pick('用語メモ', 'Terminology');
  String get karteNoHoles =>
      _pick('今日は、止まらずに説明できました', 'You explained it all the way through today');
  String get karteReviewToggle =>
      _pick('あしたの夜、先輩がもう一度きいてきます', 'Your senpai will ask again tomorrow night');

  /// The only place notification permission is requested, asked as a favour from
  /// senpai just after a gap appears.
  ///
  /// Keep the question mark. Turning it into a statement would change a request
  /// for permission into an announcement. Senpai is in a position to simply
  /// assert, so phrasing it as a request is itself the safeguard.
  String get karteReviewAsk =>
      _pick('あしたの夜、もう一度きいてもいい?', 'Mind if I ask you again tomorrow night?');
  String get karteReviewDenied => _pick(
        '通知が切れています。設定アプリから戻せます。',
        'Notifications are off. You can turn them back on in Settings.',
      );

  /// When karte generation did not finish right after the conversation. It
  /// fetches rather than regenerates.
  String get karteRetrieve => _pick('カルテを取りに行く', 'Fetch my karte');
  String get karteRetrieving => _pick('取りに行っています…', 'Fetching…');

  /// Explanation above the disabled button while waiting.
  ///
  /// The button label alone just looks like a disabled button. This says what is
  /// being waited for, and that waiting will deliver it.
  String get karteWriting => _pick(
        '先輩がカルテを書いています。届いたら、ここに出ます。',
        'Your senpai is writing your karte. It will appear here when it is ready.',
      );

  /// It did not arrive within the time we chose to wait. Worded so it is not a
  /// dead end.
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

  /// The board kept in the karte.
  ///
  /// The in-lesson board dies with the conversation screen, so the karte is the
  /// only place it can be read back afterwards. If "said well" and "gaps" are the
  /// conversation's outcome, this is what senpai actually wrote during it, so a
  /// gap can be pointed back at while discussing it. With no board, the whole
  /// section is omitted.
  String get karteBoardTitle => _pick('先輩が書いたもの', 'What your senpai wrote');

  /// The marker that the board is cut off (a delivery gap).
  ///
  /// Not phrased as a failure report: the user cannot fix it, and the karte is
  /// not the place to relitigate delivery. Silence is still wrong, because it
  /// reproduces exactly the problem that got horizontal scrolling rejected —
  /// being misread as "that's all". One line of fact.
  String get karteBoardTruncated =>
      _pick('ここから先は残っていません', "The rest of this board wasn't saved");

  // --- Review ---
  String get reviewTitle => _pick('埋めにいく穴', 'Gaps to fill');
  String get reviewSaidIt => _pick('言えた', 'I could explain it');
  String get reviewNotYet => _pick('まだ言えない', 'Not yet');

  /// "Not yet" is not a lost point. Worded so senpai takes it on and nobody is
  /// blamed for choosing it.
  String get reviewNotYetLead => _pick(
        'じゃあ、先輩ともう一回見てみよっか',
        "Let's go through it together, then",
      );
  String get reviewAskSenpai => _pick('先輩に聞く', 'Ask senpai');
  String get reviewLater => _pick('あとにする', 'Later');
  String get reviewVoicePremium => _pick(
        '声で先輩に聞き直す授業はPremiumです。小テストは無料のまま使えます。',
        'Calling your senpai back by voice uses Premium lesson mode. Quick quizzes stay free.',
      );

  /// The filled-gaps section; this is the "history" the paywall advertises.
  String reviewFilledTitle(int count) =>
      _pick('埋めた穴 — $count つ', 'Gaps filled — $count');
  String get reviewFilledEmpty =>
      _pick('ここに、埋めた穴がたまっていきます', 'The gaps you fill will collect here');
  String reviewFilledDays(int days) => switch (days) {
        0 => _pick('今日 埋めた', 'Filled today'),
        1 => _pick('きのう 埋めた', 'Filled yesterday'),
        _ => _pick('$days日前に埋めた', 'Filled $days days ago'),
      };

  /// When there are no gaps. Presented as "none right now", not "nothing here".
  String get reviewEmpty =>
      _pick('いまは、埋めにいく穴がありません', 'There are no gaps waiting right now');
  String get reviewBackHome => _pick('ホームにもどる', 'Back to home');

  // --- Settings ---
  String get settingsTitle => _pick('設定', 'Settings');
  String get settingsSectionAccount => _pick('契約', 'Subscription');
  String get settingsSectionNotifications => _pick('通知', 'Notifications');
  String get settingsSectionAbout => _pick('このアプリについて', 'About');

  // School stage. It narrows the topic search and does not restrict learning:
  // choosing junior high forbids no senior-high topic, it only changes which
  // range is searched first when matching a photo.
  String get settingsSectionSchoolStage => _pick('学年', 'School');
  String get settingsSchoolStageJuniorHigh => _pick('中学生', 'Junior high');
  String get settingsSchoolStageHighSchool => _pick('高校生', 'High school');
  String get settingsSchoolStageHint =>
      _pick('撮った写真から単元を探す範囲が変わります', 'Changes which topics we look for in your photo');

  /// The toggle for the 1/3/7-day revisits — the riskiest spot for the promise
  /// not to nag.
  ///
  /// A junior asking to have something re-explained structurally could not nag:
  /// it was a request from the learner, refusable and unreadable as pressure.
  /// Senpai is in a position to say "go study", so putting "reminders" or "have
  /// you forgotten?" in the same slot becomes nagging on the spot.
  ///
  /// So it is named for what arrives, not for who is telling you. The English
  /// avoids `Reminders` for the same reason.
  String get settingsNotifications =>
      _pick('先輩からのおさらい', 'Check-backs from your senpai');
  String get settingsNotificationsOn => _pick('届きます', 'On');
  String get settingsNotificationsOff => _pick('届きません', 'Off');
  String get settingsNotificationsOpenSettings =>
      _pick('通知の設定をひらく', 'Open notification settings');
  String get settingsPrivacy => _pick('プライバシーポリシー', 'Privacy policy');
  String get settingsTerms => _pick('利用規約', 'Terms of use');

  /// The reporting path for AI-generated content; App Review looks for it.
  ///
  /// What we want reported changed with the pivot. The old version listed "it
  /// gave away the answer", but giving the answer is now the promise, so that is
  /// the spec rather than a bug. In its place comes what only became dangerous
  /// once we started teaching: teaching something wrong. The scope covers the
  /// board and the explanation as well as the question, and says so.
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

  // --- Paywall ---
  String get paywallTitle => _pick('穴を、埋めきる。', 'Fill every gap.');

  /// One-line Premium blurb. The only number is the string the Offering returned.
  ///
  /// We never append "/month" ourselves, since that would be false on a weekly
  /// product; the plan name ([planMonthly] and friends) goes through as is. Word
  /// order matches in both locales, so it skips `_pick` (as [premiumBadge] does).
  String paywallPriceLine(String plan, String price) => 'Premium $plan $price';

  /// When the price has not loaded yet (celebration screen). No stand-in number.
  ///
  /// A hard-coded price would disagree with the store's checkout the moment the
  /// dashboard changed, leaving people deciding on mismatched information. It
  /// says only what the comparison's Premium column ([paywallEverydayQuestions])
  /// says.
  String get paywallPricePending => _pick('Premium なら、毎日つづけて何問も聞けます',
      'With Premium you can ask several questions a day');

  /// When our own paywall could not load the Offering.
  ///
  /// The buy button is disabled, so the reason is stated too. Still no numbers:
  /// the Offering also owns whether a trial exists, so "free for 7 days" cannot
  /// be claimed either.
  String get paywallPriceUnavailable => _pick(
      'いまは金額を読み込めていません。少しあとで、もう一度ひらいてみてください。',
      "We can't load the price right now. Please try opening this again in a moment.");

  /// The button that opens the paywall (from review and elsewhere). It promises
  /// no trial days: whether the store product has a trial is unknown until the
  /// Offering is read.
  String get paywallCta => _pick('Premiumをみる', 'See Premium');

  /// The buy button; replaced by [planFreeTrial] when a trial exists.
  String get paywallSubscribe => _pick('このプランではじめる', 'Start with this plan');
  String get paywallDismiss => _pick('無料のまま続ける', 'Keep using the free version');

  /// Stating auto-renewal on the purchase screen is required (guideline 3.1.2).
  /// "You can cancel" alone does not convey that it renews.
  String get paywallCancelNote => _pick('登録は自動更新されます。いつでも解約できます',
      'Your subscription renews automatically. Cancel anytime');
  String get paywallFree => _pick('無料', 'Free');
  String get paywallPremium => _pick('Premium', 'Premium');
  String get paywallRowSessions => _pick('セッション', 'Sessions');
  String get paywallRowKarte => _pick('カルテ', 'Karte');
  String get paywallRowFollowup => _pick('先輩のあと追い質問', 'Follow-up questions');
  String get paywallEverydayOne => _pick('毎日1問', 'One question every day');

  /// Premium's session allowance.
  ///
  /// It must never say "as many as you like". `PREMIUM_SESSIONS_PER_DAY` is a
  /// fair-use cap, so promising unlimited means the API refuses after purchase.
  /// Hiding numbers applies to the remaining-count display during use, not to
  /// lying where someone decides whether to buy — that would contradict an honest
  /// paywall head on. The cap is never hit in normal use, so that is what it
  /// says.
  String get paywallEverydayQuestions => _pick('毎日、続けて何問も', 'Several questions a day');
  String get paywallTodayOnly => _pick('当日のみ', 'Today only');
  String get paywallHistory => _pick('穴の復習と履歴', 'Review and history');

  /// "Included" in the comparison. `✓` (U+2713) has no glyph in ZenMaruGothic
  /// and rendered blank in goldens, so only characters the font has are used.
  String get paywallIncluded => _pick('○', 'Yes');

  // --- Plans (built from RevenueCat packages) ---
  String get planWeekly => _pick('1週間', 'Weekly');
  String get planMonthly => _pick('1か月', 'Monthly');
  String get planYearly => _pick('1年', 'Yearly');
  String planPerMonth(String price) => _pick('月あたり $price', '$price / month');

  /// Presented as a computed fact, not a recommendation.
  String get planBestValue => _pick('月あたりがいちばん安い', 'Lowest monthly price');
  String planFreeTrial(int days) =>
      _pick('はじめの$days日間は無料', 'First $days days free');

  // --- Thank-you ---
  //
  // Three cases where "thank you for your purchase" cannot be written: a free
  // trial (nothing paid yet), a restore (nothing re-bought), and payment that
  // went through without an entitlement (nothing to celebrate). Hence the
  // separate headings.

  /// Bought. The one case where a plain thank-you is honest.
  String get thanksTitle => _pick('ありがとうございます', 'Thank you');
  String get thanksBody =>
      _pick('これから、いくらでも聞きます。', 'From now on, ask me as much as you like.');

  /// A free trial started. Lead with the fact, not with thanks.
  String thanksTrialTitle(int days) =>
      _pick('$days日間、ぜんぶ使えます', 'Everything is open for $days days');

  /// When the expiry could not be read. Better to say no number than a made-up
  /// one; falling back to thanks would thank someone who has not paid.
  String get thanksTrialTitlePlain => _pick('ぜんぶ、使えます', 'Everything is open');

  /// States plainly and up front when billing begins.
  String thanksTrialBody(String date) => _pick('$date までは無料です。その日から請求が始まります。',
      "It's free until $date. Billing starts that day.");

  /// Someone back after a device change. Nothing was re-bought, so no thanks.
  String get thanksRestoredTitle => _pick('おかえりなさい', 'Welcome back');
  String thanksRestoredBody(String date) =>
      _pick('契約は $date まで有効です。', 'Your subscription is active until $date.');

  /// What was unlocked: the same three items as the paywall comparison, in the
  /// same order.
  String get thanksUnlockedSessions =>
      _pick('1日1回の上限がなくなりました', 'The once-a-day limit is gone');
  String get thanksUnlockedHistory =>
      _pick('埋めた穴が、ぜんぶ残ります', 'Every gap you fill stays on record');
  String get thanksUnlockedFollowup =>
      _pick('先輩があと追いで質問します', 'Your senpai follows up with more questions');

  String get thanksStart => _pick('はじめる', 'Get started');

  /// Auto-renewal is stated even on a celebratory screen (guideline 3.1.2).
  String thanksRenewsOn(String date) =>
      _pick('$date に更新されます・いつでも解約できます', 'Renews on $date · Cancel anytime');
  String get thanksCancelAnytime => _pick('いつでも解約できます', 'Cancel anytime');

  // --- Restore and subscription management ---
  String get paywallRestore => _pick('購入を復元する', 'Restore purchases');
  // There is no wording here for a successful restore: [ThanksScreen] says
  // "welcome back" instead of a SnackBar.
  String get paywallRestoredNothing => _pick('このアカウントに、復元できる購入は見つかりませんでした',
      'No previous purchases were found for this account');
  String get manageSubscription => _pick('契約の管理', 'Manage subscription');
  String premiumEndsOn(String date) => _pick('$date に終わります。それまではこのまま使えます',
      'Ends on $date. Everything stays available until then');
  String premiumRenewsOn(String date) =>
      _pick('$date に更新されます', 'Renews on $date');
  String premiumBillingStarts(String date) =>
      _pick('$date から請求が始まります', 'Billing starts on $date');

  /// The subscribed marker, shown top right on home and in settings.
  ///
  /// Not a rank or a title: we count only streak days and filled gaps, so this
  /// stays a plain statement of which state you are in. It is a product name, so
  /// it is identical in both locales.
  String get premiumBadge => 'Premium';
  String get premiumActive => _pick('有効', 'Active');
  String get premiumTrialBadge => _pick('無料おためし中', 'Free trial');

  /// Shown on builds running against the Test Store, so it is not mistaken for a
  /// real sale.
  String get testStoreNotice =>
      _pick('テストストアです(実際の請求は発生しません)', 'Test Store — you will not be charged');

  // --- Errors ---
  /// The purchase went through without an entitlement — a dashboard
  /// misconfiguration.
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

  /// A formatted date. Minimal formatting, to avoid adding intl as a direct
  /// dependency.
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

  /// When the request never arrived (no signal, a timeout). No server wording
  /// comes back on this path, so the app carries its own.
  String get errorNetwork => _pick(
        'うまく送れませんでした。電波の届くところで、もう一度お願いします。',
        "We couldn't send that. Please try again where the signal is better.",
      );
  String get errorRetry => _pick('もう一度', 'Try again');

  // --- Senpai's expressions (a11y labels matching `SenpaiMood`) ---
  String get senpaiWaiting => _pick('先輩が待っています', 'Your senpai is waiting');
  String get senpaiListening => _pick('先輩が聞いています', 'Your senpai is listening');

  /// The face of a teach-back landing. `just got it` would read as senpai having
  /// just understood the topic, so the direction is reversed.
  String get senpaiDelighted => _pick('先輩が納得しています', 'Your senpai is convinced');

  /// Senpai is the one struggling (see `SenpaiMood.puzzled`). It never appears
  /// when a student is stuck, so it reads as troubled, not "thinking".
  String get senpaiPuzzled =>
      _pick('先輩が困っています', 'Your senpai is having trouble');

  // --- Board narration (`board_speech.dart`) ---
  //
  // The board is drawn with `Math.tex` and `CustomPaint`, leaving it entirely
  // invisible to VoiceOver. It is the heart of the product, so missing it means
  // a blind student has no lesson at all.
  //
  // Latin letters stay as they are: a screen reader reads a single letter per
  // its locale, and spelling it out would double it up or break under an English
  // voice. Only structure and symbols become words.

  /// Fractions. Japanese states the denominator first, reversing the order.
  String boardSpeechFraction(String numerator, String denominator) =>
      _pick('$denominator 分の $numerator', '$numerator over $denominator');
  String boardSpeechSquareRoot(String body) => _pick('ルート $body', 'square root of $body');
  String boardSpeechNthRoot(String n, String body) =>
      _pick('$n 乗根 $body', 'the $n-th root of $body');
  String boardSpeechPower(String exponent) => _pick('の $exponent 乗', 'to the power of $exponent');
  String boardSpeechSubscript(String index) => _pick('の 添字 $index', 'sub $index');
  String boardSpeechVector(String body) => _pick('ベクトル $body', 'vector $body');

  /// Overlines (`\overline{AB}` / `\bar{x}`): segments, conjugates and means.
  /// The meaning depends on context, so narration goes only as far as "there is
  /// a bar".
  String boardSpeechOverline(String body) => _pick('$body の上に線', '$body with a bar');

  /// For figures, "what is drawn" is enough; exact narration is not required.
  String boardSpeechTriangle(String vertices, String marks) => _pick(
        '三角形 $vertices。$marks',
        'Triangle $vertices. $marks',
      );
  String boardSpeechRightAngle(String vertex) => _pick('頂点 $vertex は直角', 'a right angle at $vertex');
  String boardSpeechAngle(String vertex, String label) =>
      _pick('頂点 $vertex の角は $label', 'the angle at $vertex is $label');
  /// Narration for an English example. An underline makes no sound, so focus is
  /// put into words.
  String boardSpeechSentence(String text, String gloss, String focus) {
    final StringBuffer buffer = StringBuffer(text);
    if (gloss.isNotEmpty) buffer.write(_pick('。訳は $gloss', '. Meaning: $gloss'));
    if (focus.isNotEmpty) buffer.write(_pick('。注目するのは $focus', '. The focus is $focus'));
    return buffer.toString();
  }

  /// Narration for a comparison table: columns and rows folded into one sentence,
  /// since there is no way to have it read as a table.
  String boardSpeechCompare(String title, String columns, String rows) {
    final String heading = title.isEmpty ? _pick('対比表', 'A comparison') : title;
    return _pick('$heading。$columns の順に、$rows', '$heading. Columns: $columns. Rows: $rows');
  }

  /// Separator when folding a comparison into one sentence; it becomes a pause.
  String get boardSpeechCompareSeparator => _pick(' と ', ' vs ');

  String boardSpeechCircle(String radius, String labels) =>
      _pick('円。半径 $radius。$labels', 'A circle with radius $radius. $labels');
  String boardSpeechPlot(String fn, String min, String max, String marks) => _pick(
        'グラフ。$fn。x の範囲は $min から $max。$marks',
        'A graph of $fn for x from $min to $max. $marks',
      );

  /// Narration for a construction. SVG cannot be read out, so the `alt` the
  /// server sends alongside is used as is (the server owns the declaration, so it
  /// can write the wording). This boilerplate applies only when `alt` is missing.
  String get boardSpeechFigure => _pick('図', 'A figure');

  /// Turns symbols into words, so readings do not vary between screen readers.
  ///
  /// Order matters: `board_speech.dart` runs `replaceAll` top to bottom, so
  /// longer entries come first (matching `\cdot` before `\cdots` would turn it
  /// into "times s"). For the same reason `\infty` precedes `\in` and `\leq`
  /// precedes `\le`. When adding an entry, check that nothing above it is a
  /// prefix of it.
  Map<String, String> get boardSpeechSymbols => _ja
      ? const <String, String>{
          // Degrees. Without folding the `^` too it narrates as "90 to the
          // degree power", since exponent folding does not match `\`.
          r'^\circ': ' 度 ',
          r'\cdots': ' 以下同様に ', r'\ldots': ' 以下同様に ', r'\dots': ' 以下同様に ',
          r'\cdot': ' かける ', r'\pm': ' プラスマイナス ', r'\mp': ' マイナスプラス ',
          r'\times': ' かける ', r'\div': ' わる ',
          r'\leq': ' 以下 ',
          r'\geq': ' 以上 ', r'\neq': ' ノットイコール ', r'\to': ' に近づく ',
          r'\le': ' 以下 ', r'\ge': ' 以上 ', r'\ne': ' ノットイコール ',
          r'\lt': ' 小なり ', r'\gt': ' 大なり ', r'\approx': ' およそ等しい ',
          r'\therefore': ' よって ', r'\because': ' なぜならば ',
          r'\Leftrightarrow': ' 同値 ', r'\Rightarrow': ' ならば ',
          // Shapes
          r'\angle': ' 角 ', r'\triangle': ' 三角形 ', r'\perp': ' に垂直 ',
          r'\parallel': ' に平行 ', r'\sim': ' 相似 ', r'\cong': ' 合同 ',
          r'\equiv': ' 合同 ', r'\circ': ' 度 ',
          // Sets
          r'\emptyset': ' 空集合 ', r'\varnothing': ' 空集合 ',
          r'\infty': ' 無限大 ', r'\notin': ' に属さない ', r'\in': ' に属する ',
          r'\subset': ' は部分集合 ', r'\supset': ' を含む ',
          r'\cap': ' かつ ', r'\cup': ' または ',
          r'\sum': ' 総和 ', r'\int': ' 積分 ', r'\lim': ' 極限 ',
          r'\sin': ' サイン ', r'\cos': ' コサイン ', r'\tan': ' タンジェント ',
          r'\log': ' ログ ', r'\ln': ' 自然対数 ', r'\theta': ' シータ ',
          r'\alpha': ' アルファ ',
          r'\beta': ' ベータ ', r'\pi': ' パイ ',
          // Set braces. Without wording them before the structural `{}` are
          // dropped, only the backslashes remain in the narration.
          r'\{': ' 集合 かっこ ', r'\}': ' 集合 かっことじ ',
          '=': ' イコール ', '+': ' プラス ', '-': ' マイナス ',
          '<': ' 小なり ', '>': ' 大なり ', '(': ' かっこ ', ')': ' かっことじ ',
        }
      : const <String, String>{
          r'^\circ': ' degrees ',
          r'\cdots': ' and so on ', r'\ldots': ' and so on ', r'\dots': ' and so on ',
          r'\cdot': ' times ', r'\pm': ' plus or minus ', r'\mp': ' minus or plus ',
          r'\times': ' times ', r'\div': ' divided by ',
          r'\leq': ' less than or equal to ',
          r'\geq': ' greater than or equal to ', r'\neq': ' not equal to ',
          r'\le': ' less than or equal to ', r'\ge': ' greater than or equal to ',
          r'\ne': ' not equal to ', r'\lt': ' less than ', r'\gt': ' greater than ',
          r'\approx': ' approximately equals ',
          r'\to': ' approaches ', r'\therefore': ' therefore ', r'\because': ' because ',
          r'\Leftrightarrow': ' if and only if ', r'\Rightarrow': ' implies ',
          r'\angle': ' angle ', r'\triangle': ' triangle ', r'\perp': ' perpendicular to ',
          r'\parallel': ' parallel to ', r'\sim': ' is similar to ',
          r'\cong': ' is congruent to ', r'\equiv': ' is congruent to ', r'\circ': ' degrees ',
          r'\emptyset': ' the empty set ', r'\varnothing': ' the empty set ',
          r'\infty': ' infinity ', r'\notin': ' is not in ', r'\in': ' is in ',
          r'\subset': ' is a subset of ', r'\supset': ' contains ',
          r'\cap': ' intersect ', r'\cup': ' union ',
          r'\sum': ' the sum of ', r'\int': ' the integral of ', r'\lim': ' the limit of ',
          r'\sin': ' sine ', r'\cos': ' cosine ', r'\tan': ' tangent ',
          r'\log': ' log ', r'\ln': ' natural log ', r'\theta': ' theta ',
          r'\alpha': ' alpha ',
          r'\beta': ' beta ', r'\pi': ' pi ',
          r'\{': ' open brace ', r'\}': ' close brace ',
          '=': ' equals ', '+': ' plus ', '-': ' minus ',
          '<': ' less than ', '>': ' greater than ', '(': ' open bracket ',
          ')': ' close bracket ',
        };

  // --- Parent report ---
  //
  // This text reaches a parent, so it abbreviates less than in-app labels do.
  // The only numbers are filled gaps and streak days; nothing readable as
  // accuracy, score or ranking appears.
  String get parentReportTitle => _pick('今月のレポート', 'This month\'s report');
  String get parentReportOpen =>
      _pick('今月の親レポートをひらく', 'Open this month\'s parent report');
  String parentReportPeriod(String start, String end) => _pick('$start〜$end', '$start – $end');
  String parentReportFilledLine(int count) =>
      _pick('今月、埋めた穴: $count', 'Gaps filled this month: $count');
  String parentReportStreakLine(int days) =>
      _pick('連続日数: $days日', 'Current streak: $days days');
  String get parentReportTopicsTitle =>
      _pick('説明できるようになった単元', 'Topics they can now explain');
  String get parentReportTopicsEmpty =>
      _pick('今月は、ここに載る単元がまだありません', 'No topics to list here yet this month');
  String get parentReportQuotesTitle => _pick('本人の言葉', 'In their own words');
  String get parentReportQuotesEmpty =>
      _pick('今月は、ここに載る説明がまだありません', 'No explanation to quote here yet this month');
  String parentReportQuote(String quote) => _pick('「$quote」', '“$quote”');

  /// The price shown to a parent. Numbers appear only when the Offering provided
  /// them.
  ///
  /// A hard-coded price would leave the email showing the old amount the day the
  /// RevenueCat product changed. Without one, it guesses nothing and says the
  /// store's purchase screen is authoritative.
  String parentReportPriceNote({String? plan, String? price}) {
    if (plan == null || price == null) {
      return _pick(
        '料金はストアの購入画面で確認できます。',
        'The current price is shown in the store purchase screen.',
      );
    }
    final String line = paywallPriceLine(plan, price);
    return _pick(
      'この先も続ける場合の料金は、$lineです。',
      'The current price to keep going is $line.',
    );
  }

  String get parentReportPreviewNote => _pick(
        '下に見えている本文が、そのままメールに入ります。引用も含めて、送る前に確認してください。',
        'The text below goes into the email exactly as shown. Review every quote before sharing.',
      );
  String get parentReportSendEmail => _pick('メールで親に送る', 'Email this to a parent');
  String get parentReportDraftNote => _pick(
        'メールの下書きを開くだけです。宛先と送信は、メールアプリで決められます。',
        'This only opens a draft. You choose the recipient and send it from your mail app.',
      );
  String get parentReportMailSubject =>
      _pick('カタルテ 今月のレポート', 'Katarute — this month\'s report');
  String get parentReportLocked => _pick(
        '親レポートは、まだ開いていません。Premiumになると、今月の記録を見てから親に送れます。',
        'The parent report is not open yet. Premium lets you review this month\'s record before emailing it.',
      );

  // --- Self-reported gaps ---
  //
  // The student is the only grader. "Not yet" is tied to no failure, deduction
  // or lost streak; it sits in the same place as an option that changes nothing.
  // No remaining counts and no completion rates.
  String get holeSelfReportQuestion =>
      _pick('これ、言えるようになった?', 'Can you explain this now?');
  String get holeSelfReportNoPressure => _pick(
        '決めるのはあなたです。「まだ」を選んでも、穴も記録もそのままです。',
        'You decide. Choosing “not yet” leaves your gap and record unchanged.',
      );
  String get holeSelfReportLater => _pick(
        '今は決めなくても、あとで復習画面から選べます。',
        'You can leave this for now and choose later from the review screen.',
      );
  String get holeSelfReportFilling =>
      _pick('カルテに反映しています…', 'Updating your karte…');

  // --- Study plan (paid, built by voice) ---
  //
  // No input field labels. Senpai asks for dates, scope and materials aloud in
  // turn, and the screen carries only "start talking" plus headings for reading
  // the finished plan.
  String get planTitle => _pick('学習計画', 'Study plan');
  String get planIntroTitle =>
      _pick('テストまで、一緒に組もっか。', "Let's map out the test.");
  String get planIntroBody => _pick(
    'テストの日、範囲、使っている教材を、先輩がひとつずつ聞きます。入力欄はありません。',
    'Your senpai asks for the date, the range, and what you study from — one at a time, out loud.',
  );
  String get planCreate => _pick('先輩と計画をつくる', 'Make a plan with senpai');
  String get planRebuild => _pick('口で組み直す', 'Rebuild it out loud');
  String get planConnecting => _pick('先輩を呼んでいます', 'Calling your senpai');
  String get planListening => _pick('聞いています', 'Listening');
  String get planSaving => _pick('計画をまとめています', 'Putting your plan together');
  String get planEndConversation => _pick('今日はここまで', "Let's stop here");
  String get planLoadFailed => _pick(
    '計画を読み込めませんでした。電波の届くところでもう一度お願いします。',
    "We couldn't load your plan. Please try again with a better connection.",
  );
  String get planConnectionFailed => _pick(
    'うまくつながりませんでした。マイクと電波を確かめてみてください。',
    "We couldn't connect. Check your mic and connection, then try again.",
  );
  String get planSenpaiUnavailable => _pick(
    '先輩を呼べませんでした。少し時間をおいて、もう一度お願いします。',
    "Your senpai couldn't join. Please try again in a moment.",
  );
  String get planResultPending => _pick(
    '新しい計画をまだ受け取れていません。前の計画はこのまま残しています。',
    "The new plan hasn't arrived yet. Your previous plan is still here.",
  );
  String planRevisionNote(String said) =>
      _pick('「$said」を受けて組み直しました。', 'Rebuilt after: “$said”');
  String planExamDate(String date) => _pick('テスト: $date', 'Test: $date');
  String get planScope => _pick('範囲', 'Range');
  String get planMaterials => _pick('使う教材', 'Materials');
  String get planNoMaterials =>
      _pick('教材なし。ノートで進めます', 'No book needed — use your notes');
  String get planRestDay => _pick('休む日', 'Day off');
  String planMinutes(int minutes) => _pick('$minutes分', '$minutes min');
  String planItemStatus(String status) => switch (status) {
    'done' => _pick('できた', 'Done'),
    'moved' => _pick('組み直した', 'Moved'),
    _ => _pick('これから', 'Up next'),
  };

  /// The topic_id prefix identifies the curriculum (ADR 0005 / 0006). It yields
  /// only a subject name (a school year for junior high), never a percentage or
  /// comprehension score.
  ///
  /// Adding a prefix means adding it here too. The mapping also lives in
  /// `packages/curriculum/src/schema.ts` and `packages/contract/src/karte.ts`,
  /// making this the third copy (contract is a dependency-free layer, so it
  /// cannot be shared). Forgetting falls back to the default "math" and labels
  /// English topics as math — `test/curriculum_label_test.dart` catches it across
  /// every course code.
  String planSubject(String topicId) {
    final String code = topicId.split('-').first;
    return switch (code) {
      'M1' => _pick('数学I', 'Mathematics I'),
      'MA' => _pick('数学A', 'Mathematics A'),
      'M2' => _pick('数学II', 'Mathematics II'),
      'MB' => _pick('数学B', 'Mathematics B'),
      'M3' => _pick('数学III', 'Mathematics III'),
      'MC' => _pick('数学C', 'Mathematics C'),
      'J1' => _pick('中1 数学', 'Grade 7 Math'),
      'J2' => _pick('中2 数学', 'Grade 8 Math'),
      'J3' => _pick('中3 数学', 'Grade 9 Math'),
      'JE' => _pick('中学英語', 'Junior high English'),
      'E1' => _pick('英コミュI', 'English Communication I'),
      'E2' => _pick('英コミュII', 'English Communication II'),
      'L1' => _pick('論表I', 'Logic and Expression I'),
      'A1' => 'Algebra 1',
      'GE' => 'Geometry',
      'A2' => 'Algebra 2',
      'PC' => 'Precalculus',
      'CL' => 'Calculus',
      'ST' => 'Statistics',
      _ => _pick('数学', 'Math'),
    };
  }

  // --- Bottom navigation ---
  //
  // Held separately from feature names: shortening a screen title should not
  // silently change a tab's announcement, or the three global destinations would
  // drift between devices and languages.
  String get navigationHome => _pick('ホーム', 'Home');
  String get navigationPlan => _pick('計画', 'Plan');
  String get navigationSettings => _pick('設定', 'Settings');
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
