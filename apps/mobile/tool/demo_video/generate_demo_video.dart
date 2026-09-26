/// 紹介動画(デモ動画)を**実画面から**書き出す。
///
/// ```bash
/// cd apps/mobile
/// FFMPEG=/path/to/ffmpeg fvm flutter test tool/demo_video/generate_demo_video.dart
/// # 片方だけ: --plain-name 'ja' / --plain-name 'en'
/// ```
///
/// 出力: `docs/store/demo-video/demo-{ja,en}.mp4`(1920x1080・30fps・H.264)と、
/// 章ごとの静止画 `docs/store/demo-video/frames/{ja,en}-*.png`(見直し用)。
///
/// ## 何が本物で、何が台本か
///
/// **画面・画面遷移・状態の持ち方はすべて本物**(`AppRouter` と各コントローラを
/// そのまま動かしている)。台本に置き換えているのは、端末の外にあるものだけ:
///
/// | 置き換えたもの | 中身 |
/// | --- | --- |
/// | backend/api | `http` の MockClient。**`packages/contract/fixtures` の JSON** を返す。ApiClient のパースは本物 |
/// | LiveKit の部屋(agent) | 板書の封筒を**本物の [BoardInbox]** に1通ずつ流す。中身は `board-lesson*.json` |
/// | カメラ | image_picker のチャネルに、ここで描いた問題の写真を返させる |
/// | ロック画面の通知 | OS の画面なので描いた。文面は `buildPracticeNotification`(guardrail)の出力そのまま |
///
/// 声(TTS)は入れていない。先輩の冒頭の一言(`assets/audio`)もまだ無音の
/// プレースホルダなので、字幕(画面の吹き出し)だけで見せる。
///
/// **Shipaton の提出物には、これとは別に実機の録画が要る**("footage that shows
/// the Project functioning on the device"。`docs/shipaton_submission.md` §0-1)。
/// これは紹介動画と、実機で撮るときの台本(順番と間)を兼ねる。
///
/// 絵の正はコード(`generate_store_screenshots.dart` と同じ方針)。動画を
/// 編集ソフトで直さず、ここを直して書き出し直すこと。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/brand/app_mark.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/application/last_board_controller.dart';
import 'package:ai_sensei/src/features/session/application/board_inbox.dart';
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:ai_sensei/src/routing/app_router.dart';
import 'package:ai_sensei/src/theme/app_theme.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../test/support/harness.dart';

const String _outDir = '../../docs/store/demo-video';
const String _fixtures = '../../packages/contract/fixtures';

const int _fps = 30;
const Duration _frame = Duration(microseconds: 1000000 ~/ _fps);

/// 動画の寸法。YouTube / Devpost の 16:9。
const Size _stageSize = Size(1920, 1080);

/// 端末の論理サイズ(iPhone 15 Pro)。ストアのスクショと同じ。
const Size _phoneLogical = Size(393, 852);

/// 端末の画面を置く場所。高さ 1000px に拡大して描く(ベクタのまま拡大するので滲まない)。
const double _phoneHeight = 1000;
const double _phoneScale = _phoneHeight / 852;
const double _phoneLeft = 1170;
const double _phoneTop = 40;
const double _bezel = 12;
final Rect _phoneRect = Rect.fromLTWH(
  _phoneLeft,
  _phoneTop,
  _phoneLogical.width * _phoneScale,
  _phoneHeight,
);

void main() {
  setUpAll(loadAppFonts);

  for (final _Script script in <_Script>[_ja, _en]) {
    testWidgets(
      script.locale,
      (WidgetTester tester) => _record(tester, script),
      timeout: Timeout.none,
    );
  }
}

// ---------------------------------------------------------------------------
// 監督(台本どおりに画面を操作して、1フレームずつ書き出す)
// ---------------------------------------------------------------------------

Future<void> _record(WidgetTester tester, _Script s) async {
  // ignore: invalid_use_of_visible_for_testing_member
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences preferences = await SharedPreferences.getInstance();

  final Directory temp = Directory.systemTemp.createTempSync('demo_video');
  addTearDown(() => temp.deleteSync(recursive: true));
  final File photo = (await tester.runAsync(() => _writeProblemPhoto(s, temp)))!;

  // カメラ: 撮った体で、描いた写真のパスを返す(本物の `_pick` の道を通す)。
  const MethodChannel picker = MethodChannel('plugins.flutter.io/image_picker');
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    picker,
    (MethodCall call) async => call.method == 'pickImage' ? photo.path : null,
  );
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(picker, null));
  mockPermissionHandler();

  final _DemoServer server = _DemoServer(s);
  final ProviderContainer container = ProviderContainer(
    overrides: <Object?>[
      preferencesProvider.overrideWithValue(preferences),
      onboardedProvider.overrideWithValue(true),
      deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
      apiClientProvider.overrideWithValue(
        ApiClient(
          baseUrl: 'http://demo.invalid',
          deviceId: '11111111-2222-3333-4444-555555555555',
          client: server.client,
        ),
      ),
      sessionControllerProvider.overrideWith(_ScriptedSession.new),
    ].cast(),
  );
  addTearDown(container.dispose);

  await tester.binding.setSurfaceSize(_stageSize);
  tester.view.physicalSize = _stageSize;
  tester.view.devicePixelRatio = 1;
  addTearDown(() async {
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });

  final _Stage stage = _Stage();
  final GlobalKey boundaryKey = GlobalKey();
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundaryKey,
      child: _StageView(
        stage: stage,
        script: s,
        phone: _PhoneApp(container: container, locale: Locale(s.locale)),
      ),
    ),
  );

  final _Recorder rec = await _Recorder.start(
    tester,
    boundaryKey,
    '$_outDir/demo-${s.locale}.mp4',
    voices: s.withAudio ? _Voices.load('$_outDir/audio/${s.locale}') : null,
  );
  // --- 0. 表紙 ---
  stage.update(card: _Card.title);
  rec.say('narr-title');
  await rec.hold(3400);
  await rec.snapshot('${s.locale}-00-title');
  await rec.waitNarration(tailMs: 500);

  // 日英の文言は非同期に読み込まれるので、表紙のあいだに揃ってから引く。
  final AppStrings strings = AppStrings.of(tester.element(find.byType(Scaffold).first));

  // 見出しとアプリの文言がかぶる(「撮る」)ので、アプリの要素は端末の中だけで探す。
  const _InApp inApp = _InApp();

  // --- 1. 撮る ---
  stage.update(card: _Card.none, caption: s.captions[0]);
  rec.say('narr-snap');
  await rec.hold(1800);
  await rec.snapshot('${s.locale}-01-home');
  await rec.tap(inApp.byKey(const ValueKey<String>('home-primary-lesson')));
  await rec.holdUntil(inApp.text(strings.captureChooseTitle));
  await rec.hold(1300);
  await rec.tap(inApp.text(strings.capturePhotoProblem).first);
  await rec.holdUntil(inApp.text(strings.capturePickCamera));
  await rec.hold(900);
  await rec.tap(inApp.text(strings.capturePickCamera));
  await rec.holdUntil(inApp.byType(Image));
  await rec.hold(1600);
  await rec.snapshot('${s.locale}-02-photo');
  await rec.tap(inApp.text(strings.captureStart));
  // 解析(Vision LLM)の待ち。サーバの台本が間を持つ。
  await rec.holdUntil(inApp.text(strings.captureConfirmTitle));
  await rec.holdUntil(inApp.text(strings.captureStart));
  await rec.hold(2600);
  await rec.snapshot('${s.locale}-03-topics');
  await rec.waitNarration();
  await rec.reveal(inApp.text(strings.captureStart));
  await rec.tap(inApp.text(strings.captureStart));

  // --- 2. 教わる ---
  await rec.holdUntil(inApp.text(strings.sessionUnderstood));
  stage.update(caption: s.captions[1]);
  rec.say('narr-learn');
  final _ScriptedSession session =
      container.read(sessionControllerProvider.notifier) as _ScriptedSession;
  await rec.hold(1100, onSecond: session.tick);
  session.senpaiJoined();
  await rec.hold(500, onSecond: session.tick);
  // 先輩はナレーションに重ねて喋らない。
  await rec.waitNarration(onSecond: session.tick);
  session.speak(s.openingLine);
  stage.update(voice: _Voice(s.openingLine));
  await rec.speak('senpai-opening', 2000, onSecond: session.tick);

  final _Lesson lesson = _Lesson.load(s);
  session.deliver(lesson.open);
  await rec.hold(500, onSecond: session.tick);
  for (final BoardChannelMessage message in lesson.steps) {
    final BoardStep step = (message as BoardStepMessage).step;
    session.deliver(message);
    session.speak(step.speech);
    stage.update(voice: _Voice(step.speech));
    await rec.speak(
      'senpai-step-${step.index}',
      1100 + step.speech.length * s.msPerChar,
      onSecond: session.tick,
    );
    if (step.index == s.replyAfterStep) {
      await rec.snapshot('${s.locale}-04-board');
      session.studentTurn();
      await rec.hold(600, onSecond: session.tick);
      stage.update(caption: s.captions[2], voice: _Voice(s.studentReply, student: true));
      await rec.speak('student-reply', 2400, onSecond: session.tick);
      session.userTurn();
      await rec.hold(900, onSecond: session.tick);
    }
  }
  await rec.hold(1200, onSecond: session.tick);
  await rec.snapshot('${s.locale}-05-board-full');

  // --- 3. わかった ---
  stage.update(caption: s.captions[3], clearVoice: true);
  rec.say('narr-gotit');
  await rec.hold(1800, onSecond: session.tick);
  await rec.tap(inApp.text(strings.sessionUnderstood));
  await rec.holdUntil(inApp.byKey(const Key('celebration-done')));
  await rec.hold(3600);
  await rec.snapshot('${s.locale}-06-celebration');
  await rec.waitNarration();
  await rec.tap(inApp.byKey(const Key('celebration-done')));
  await rec.hold(900);

  // --- 4. 3日後の通知 ---
  server.daysLater = 3;
  stage.update(caption: s.captions[4], lockScreen: true);
  rec.say('narr-later');
  await rec.hold(1100);
  stage.update(notification: true);
  await rec.hold(2800);
  await rec.snapshot('${s.locale}-07-notification');
  await rec.waitNarration();
  await rec.tapVisual(find.byKey(const ValueKey<String>('demo-notification')));
  container.read(appRouterProvider).go('/review?problem=${Uri.encodeQueryComponent(s.practiceId)}');
  await rec.hold(200);
  stage.update(lockScreen: false, notification: false);

  // --- 5. 答えて採点 ---
  await rec.holdUntil(inApp.byType(TextField));
  stage.update(caption: s.captions[5]);
  rec.say('narr-answer');
  await rec.hold(1500);
  await rec.tapVisual(inApp.byType(TextField));
  await tester.showKeyboard(inApp.byType(TextField));
  for (int i = 1; i <= s.answer.length; i++) {
    await tester.enterText(inApp.byType(TextField), s.answer.substring(0, i));
    await rec.hold(s.locale == 'ja' ? 90 : 55);
  }
  await rec.hold(900);
  await rec.snapshot('${s.locale}-08-answer');
  FocusManager.instance.primaryFocus?.unfocus();
  await rec.tap(inApp.text(strings.practiceSubmit));
  await rec.holdUntil(inApp.text(strings.practiceCorrect));
  await rec.hold(4600);
  await rec.snapshot('${s.locale}-09-graded');
  await rec.waitNarration();

  // --- 6. 続ける ---
  stage.update(caption: s.captions[6]);
  rec.say('narr-keep');
  await rec.reveal(inApp.byKey(const Key('practice-home')));
  await rec.hold(700);
  await rec.tap(inApp.byKey(const Key('practice-home')));
  await rec.holdUntil(inApp.byKey(const ValueKey<String>('home-primary-lesson')));
  await rec.hold(3600);
  await rec.snapshot('${s.locale}-10-home-after');
  await rec.waitNarration(tailMs: 600);

  // --- 7. 締め ---
  stage.update(card: _Card.end);
  rec.say('narr-end');
  await rec.hold(4800);
  await rec.waitNarration(tailMs: 2200);
  await rec.snapshot('${s.locale}-11-end');

  await rec.finish();
  // ignore: avoid_print
  print('demo-${s.locale}.mp4: ${rec.frames} frames (${rec.frames / _fps}s)');
}

/// 端末の中(アプリ)だけを探す finder。
class _InApp {
  const _InApp();

  Finder _scope(Finder finder) => find.descendant(of: find.byType(_PhoneApp), matching: finder);
  Finder text(String text) => _scope(find.text(text));
  Finder byKey(Key key) => _scope(find.byKey(key));
  Finder byType(Type type) => _scope(find.byType(type));
}

/// 声とBGM(`generate_demo_audio.ts` が用意する)。
class _Voices {
  _Voices._(this._dir, this._ms);

  factory _Voices.load(String dir) {
    final File manifest = File('$dir/manifest.json');
    if (!manifest.existsSync() || !File('$dir/bgm.mp3').existsSync()) {
      throw StateError('$dir に声とBGMがありません。先に generate_demo_audio.ts を走らせてください');
    }
    final Map<String, dynamic> json =
        jsonDecode(manifest.readAsStringSync()) as Map<String, dynamic>;
    return _Voices._(dir, <String, int>{
      for (final MapEntry<String, dynamic> e in json.entries)
        e.key: (e.value as Map<String, dynamic>)['ms'] as int,
    });
  }

  final String _dir;
  final Map<String, int> _ms;

  int? durationMs(String id) => _ms[id];
  String file(String id) => '$_dir/$id.m4a';
  String get bgm => '$_dir/bgm.mp3';
}

/// 1フレームずつ描いて ffmpeg へ流す。
///
/// `toImage` は本物の非同期を要るので、毎フレーム `runAsync` の中で撮る
/// (fake_async のゾーンでは完了しない)。副作用として、写真の読み出しや
/// デコードのような本物の I/O も、このすき間で進む。
class _Recorder {
  _Recorder._(this._tester, this._key, this._ffmpeg, this._path, this._videoPath, this._voices);

  final WidgetTester _tester;
  final GlobalKey _key;
  final Process _ffmpeg;
  final String _path;
  final String _videoPath;
  final _Voices? _voices;
  int frames = 0;

  /// 鳴らした声(何フレーム目に、どの音声を)。最後にまとめてミックスする。
  final List<(int, String)> _cues = <(int, String)>[];
  int _narrationEndsAt = 0;

  static String get _ffmpegPath => Platform.environment['FFMPEG'] ?? 'ffmpeg';

  static Future<_Recorder> start(
    WidgetTester tester,
    GlobalKey key,
    String path, {
    _Voices? voices,
  }) async {
    File(path).parent.createSync(recursive: true);
    // 声を入れるときは、いったん映像だけを書き出してから音を重ねる。
    final String videoPath = voices == null ? path : '$path.video.mp4';
    final Process process = (await tester.runAsync(
      () => Process.start(_ffmpegPath, <String>[
        '-y',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        '${_stageSize.width.toInt()}x${_stageSize.height.toInt()}',
        '-r',
        '$_fps',
        '-i',
        '-',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        videoPath,
      ]),
    ))!;
    unawaited(process.stderr.transform(utf8.decoder).forEach(stderr.write));
    return _Recorder._(tester, key, process, path, videoPath, voices);
  }

  RenderRepaintBoundary get _boundary =>
      _key.currentContext!.findRenderObject()! as RenderRepaintBoundary;

  Future<void> frame() async {
    await _tester.pump(_frame);
    await _tester.runAsync(() async {
      final ui.Image image = await _boundary.toImage();
      final ByteData? rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      image.dispose();
      _ffmpeg.stdin.add(rgba!.buffer.asUint8List());
      await _ffmpeg.stdin.flush();
    });
    frames++;
  }

  /// [onSecond] は動画の中の1秒ごとに呼ぶ(授業の残り時間を減らすため)。
  Future<void> hold(int ms, {VoidCallback? onSecond}) async {
    final int count = (ms * _fps / 1000).round();
    for (int i = 0; i < count; i++) {
      await frame();
      if (onSecond != null && frames % _fps == 0) onSecond();
    }
  }

  /// 声を鳴らす(この瞬間に置く)。長さ(ミリ秒)を返す。音声が無ければ 0。
  ///
  /// ナレーション(`narr-`)は鳴らしたまま画面の操作を続けられる。
  /// 次のナレーションや先輩の声の前には [waitNarration] で終わるのを待つ。
  int say(String id) {
    final int? ms = _voices?.durationMs(id);
    if (ms == null) return 0;
    _cues.add((frames, id));
    if (id.startsWith('narr-')) {
      _narrationEndsAt = frames + (ms * _fps / 1000).ceil();
    }
    return ms;
  }

  /// 先輩・生徒の声。**喋り終わるまで**次へ進まない(音声が無ければ [fallbackMs])。
  Future<void> speak(String id, int fallbackMs, {VoidCallback? onSecond}) async {
    final int ms = say(id);
    await hold(ms == 0 ? fallbackMs : ms + 550, onSecond: onSecond);
  }

  /// 鳴っているナレーションが終わるまで撮り続ける。
  Future<void> waitNarration({int tailMs = 300, VoidCallback? onSecond}) async {
    final int end = _narrationEndsAt + (tailMs * _fps / 1000).round();
    if (_voices == null || frames >= end) return;
    await hold(((end - frames) * 1000 / _fps).round(), onSecond: onSecond);
  }

  /// 現れるまで撮り続ける。待ち時間(通信・アニメーション)もそのまま映す。
  Future<void> holdUntil(Finder finder, {int maxMs = 15000}) async {
    for (int waited = 0; waited < maxMs; waited += 1000 ~/ _fps) {
      if (finder.evaluate().isNotEmpty) return;
      await frame();
    }
    fail('${finder.describeMatch(Plurality.one)} が現れませんでした');
  }

  /// タップの位置に波紋を出してから、本当に叩く。
  Future<void> tap(Finder finder) async {
    await tapVisual(finder);
    await _tester.tap(finder, warnIfMissed: false);
    await hold(200);
  }

  /// 波紋だけ(叩いた結果は呼び出し側が起こす)。
  Future<void> tapVisual(Finder finder) async {
    _stageOf().update(tapAt: _tester.getCenter(finder));
    await hold(260);
  }

  /// 画面の外にあるものを、スクロールして見せる。飛ばさずに動かして映す。
  Future<void> reveal(Finder finder) async {
    final Element element = finder.evaluate().first;
    unawaited(
      Scrollable.ensureVisible(
        element,
        duration: const Duration(milliseconds: 450),
        curve: Curves.easeInOut,
        alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
      ),
    );
    await hold(600);
  }

  _Stage _stageOf() => (_tester.widget(find.byType(_StageView)) as _StageView).stage;

  Future<void> snapshot(String name) async {
    await _tester.runAsync(() async {
      final ui.Image image = await _boundary.toImage();
      final ByteData? png = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      final File file = File('$_outDir/frames/$name.png');
      file.parent.createSync(recursive: true);
      file.writeAsBytesSync(png!.buffer.asUint8List(), flush: true);
    });
  }

  Future<void> finish() async {
    await _tester.runAsync(() async {
      await _ffmpeg.stdin.close();
      final int code = await _ffmpeg.exitCode;
      if (code != 0) throw StateError('ffmpeg が $code で終了しました');
      final _Voices? voices = _voices;
      if (voices != null) {
        await _mix(voices);
        File(_videoPath).deleteSync();
      }
    });
  }

  /// 声を置いた位置に並べ、BGMを**声の下で自動的に絞って**(sidechain)重ねる。
  Future<void> _mix(_Voices voices) async {
    final double seconds = frames / _fps;
    final List<String> inputs = <String>['-i', _videoPath, '-i', voices.bgm];
    final List<String> filters = <String>[];
    for (int i = 0; i < _cues.length; i++) {
      final (int frame, String id) = _cues[i];
      final int delay = (frame * 1000 / _fps).round();
      inputs.addAll(<String>['-i', voices.file(id)]);
      filters.add(
        '[${i + 2}:a]aformat=sample_rates=48000:channel_layouts=stereo,'
        'adelay=$delay:all=1[c$i]',
      );
    }
    final String voiceInputs = <String>[for (int i = 0; i < _cues.length; i++) '[c$i]'].join();
    filters
      ..add('${voiceInputs}amix=inputs=${_cues.length}:normalize=0:dropout_transition=0[voice]')
      ..add('[voice]asplit=2[vmain][vkey]')
      ..add(
        '[1:a]atrim=0:${seconds.toStringAsFixed(3)},asetpts=PTS-STARTPTS,'
        'aformat=sample_rates=48000:channel_layouts=stereo,volume=0.5,'
        'afade=t=in:st=0:d=1.5,afade=t=out:st=${(seconds - 3.5).toStringAsFixed(3)}:d=3.5[bg]',
      )
      ..add('[bg][vkey]sidechaincompress=threshold=0.015:ratio=6:attack=40:release=700[bgd]')
      ..add('[bgd][vmain]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]');

    final ProcessResult result = await Process.run(_ffmpegPath, <String>[
      '-y',
      '-loglevel',
      'error',
      ...inputs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      seconds.toStringAsFixed(3),
      '-movflags',
      '+faststart',
      _path,
    ]);
    if (result.exitCode != 0) throw StateError('音声のミックスに失敗しました: ${result.stderr}');
  }
}

// ---------------------------------------------------------------------------
// 会話(LiveKit の部屋の代わり)
// ---------------------------------------------------------------------------

/// 部屋へはつながず、台本から状態を進める。
///
/// 板書は本物の [BoardInbox] を通す。封筒の順番・宛先の検査も、
/// 板書の積み方も、実機でagentから受けたときと同じ道になる。
class _ScriptedSession extends SessionController {
  BoardInbox? _inbox;

  @override
  SessionState build() => const SessionState(phase: SessionPhase.connecting, remainingSeconds: 300);

  @override
  Future<void> connect(SessionStart session, {required String locale}) async {
    _inbox = BoardInbox(sessionId: session.sessionId);
    state = SessionState(
      phase: SessionPhase.connecting,
      remainingSeconds: session.limits.maxSeconds,
    );
  }

  void tick() {
    if (state.phase == SessionPhase.connecting || state.isUnderstood) return;
    state = state.copyWith(remainingSeconds: state.remainingSeconds - 1);
  }

  void senpaiJoined() => state = state.copyWith(phase: SessionPhase.listening);

  void speak(String text) => state = state.copyWith(
    phase: state.board.hasBoard ? SessionPhase.senpaiTeaching : SessionPhase.senpaiSpeaking,
    lastSenpaiText: text,
  );

  void studentTurn() => state = state.copyWith(
    phase: state.board.hasBoard ? SessionPhase.explainBack : SessionPhase.listening,
    awaitingStudent: true,
  );

  void userTurn() => state = state.copyWith(awaitingStudent: false);

  void deliver(BoardChannelMessage message) {
    final BoardInbox inbox = _inbox!;
    if (!inbox.accept(message)) throw StateError('板書の封筒を受け取れませんでした: $message');
    final BoardSnapshot board = inbox.snapshot;
    state = state.copyWith(
      board: board,
      awaitingSolving: board.awaitsSolving,
      awaitingStudent: board.awaitsStudent,
      phase: SessionPhase.senpaiTeaching,
    );
    ref.read(lastBoardControllerProvider.notifier).set(board.steps, truncated: board.hasGap);
  }

  /// 「わかった」。本物は agent へ到達を知らせてから [finish] に合流する。
  /// ここでは部屋が無いので、その後ろ(祝福へ進むまで)だけを同じ順で踏む。
  @override
  Future<void> understood() async {
    if (state.isUnderstood) return;
    state = state.copyWith(isUnderstood: true, awaitingSolving: false, awaitingStudent: false);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    state = state.copyWith(phase: SessionPhase.summarizing);
    await Future<void>.delayed(const Duration(milliseconds: 700));
    ref.read(sessionOutcomeControllerProvider.notifier).set(const SessionOutcome(kind: 'new'));
    state = state.copyWith(phase: SessionPhase.finished);
  }
}

/// `board-lesson*.json` を、agent が送るのと同じ封筒(`board_open` → `board_step`…)に包む。
class _Lesson {
  _Lesson(this.open, this.steps);

  factory _Lesson.load(_Script s) {
    final BoardLesson lesson = BoardLesson.fromJson(_readFixture(s.lessonFixture));
    ensureSequentialStepIndices(lesson);
    const String boardId = 'brd_demo';
    int seq = 0;
    return _Lesson(
      BoardChannelMessage.boardOpen(
        v: 1,
        sessionId: s.sessionId,
        boardId: boardId,
        seq: seq++,
        title: lesson.title,
        topicIds: lesson.topicIds,
      ),
      <BoardChannelMessage>[
        for (final BoardStep step in lesson.steps.take(s.stepCount))
          BoardChannelMessage.boardStep(
            v: 1,
            sessionId: s.sessionId,
            boardId: boardId,
            seq: seq++,
            step: step,
          ),
      ],
    );
  }

  final BoardChannelMessage open;
  final List<BoardChannelMessage> steps;
}

// ---------------------------------------------------------------------------
// backend/api の代わり(契約の fixture を返す)
// ---------------------------------------------------------------------------

class _DemoServer {
  _DemoServer(this.s) {
    client = MockClient(_handle);
  }

  final _Script s;
  late final MockClient client;

  /// 0 = 授業の日。3 = 通知が届いた日。
  int daysLater = 0;
  bool _answered = false;

  Future<http.Response> _handle(http.Request request) async {
    final String path = request.url.path;
    final String method = request.method;

    if (method == 'POST' && path == '/v1/sessions') {
      // 写真の読み取り(Vision LLM)。実機でもこのくらい待つ。
      await Future<void>.delayed(const Duration(milliseconds: 1800));
      return _json(s.analysis, 201);
    }
    if (path.endsWith('/topics')) return _json(s.analysis, 200);
    if (path.endsWith('/start')) {
      await Future<void>.delayed(const Duration(milliseconds: 600));
      return _json(_start(), 200);
    }
    if (path.endsWith('/result')) return _json(_result(), 200);
    if (path == '/v1/me/progress') return _json(_progress(), 200);
    if (method == 'GET' && path == '/v1/me/practice') return _json(_queue(), 200);
    if (path == '/v1/me/practice/${s.practiceId}') {
      if (method == 'POST') {
        // 採点(LLM)。
        await Future<void>.delayed(const Duration(milliseconds: 2800));
        _answered = true;
        return _json(_answer(request), 200);
      }
      return _json(_practiceItem(), 200);
    }
    return _json(<String, dynamic>{
      'error': <String, dynamic>{'code': 'not_found', 'message': 'not in the demo script'},
    }, 404);
  }

  Map<String, dynamic> _start() {
    final Map<String, dynamic> json = _readFixture('start-session-response.json');
    return <String, dynamic>{
      ...json,
      'session_id': s.sessionId,
      'livekit': <String, dynamic>{
        ...(json['livekit'] as Map<String, dynamic>),
        'room': s.sessionId,
      },
      // fixture は「今日はもう使い切った」側の例なので、授業ができる日に差し替える。
      'limits': <String, dynamic>{
        'max_seconds': 300,
        'remaining_seconds_today': 900,
        'lesson_allowed_today': true,
      },
    };
  }

  Map<String, dynamic> _result() {
    final Map<String, dynamic> json = _readFixture('complete-session-response.json');
    return <String, dynamic>{
      ...json,
      'practice_problem': s.practiceProblem,
      'progress': _progressBody(),
      // 初回のペイウォールは出さない(RevenueCat の商品が端末に無い)。
      'show_paywall': false,
    };
  }

  Map<String, dynamic> _progressBody() {
    final Map<String, dynamic> base =
        _readFixture('practice-answer-response.json')['progress'] as Map<String, dynamic>;
    // 答えるまでは1日少なく・1問少なく見せる。答えた瞬間に fixture の値(3日・12問)になる。
    return _answered
        ? <String, dynamic>{...base, 'open_problems': 0}
        : <String, dynamic>{
            ...base,
            'streak_days': (base['streak_days'] as int) - 1,
            'solved_problems': (base['solved_problems'] as int) - 1,
            'open_problems': daysLater > 0 ? 1 : 0,
          };
  }

  Map<String, dynamic> _progress() => <String, dynamic>{
    ..._readFixture('progress-response.json'),
    'progress': _progressBody(),
  };

  Map<String, dynamic> _practiceItem() => <String, dynamic>{
    'problem': s.practiceProblem,
    'days_since': daysLater,
    'topic_label': s.topicLabel,
    'last_verdict': null,
  };

  Map<String, dynamic> _queue() {
    final Map<String, dynamic> fixture = _readFixture(s.queueFixture);
    final List<dynamic> olderSolved = fixture['solved'] as List<dynamic>;
    return <String, dynamic>{
      'items': <dynamic>[if (daysLater > 0 && !_answered) _practiceItem()],
      'solved': <dynamic>[
        if (_answered)
          <String, dynamic>{
            'problem': s.practiceProblem,
            'topic_label': s.topicLabel,
            'days_since_solved': 0,
          },
        ...olderSolved,
      ],
    };
  }

  Map<String, dynamic> _answer(http.Request request) {
    final Map<String, dynamic> json = _readFixture('practice-answer-response.json');
    final String response =
        (jsonDecode(request.body) as Map<String, dynamic>)['response'] as String;
    return <String, dynamic>{
      ...json,
      'attempt': <String, dynamic>{
        ...(json['attempt'] as Map<String, dynamic>),
        'problem_id': s.practiceId,
        'response': response,
        'verdict': 'correct',
        'comment': s.gradingComment,
      },
      // 採点で1問解けた。ホームの「解きにくい問題」は残らない。
      'progress': _progressBody(),
      'next_schedule': <dynamic>[
        for (final dynamic entry in json['next_schedule'] as List<dynamic>)
          <String, dynamic>{...(entry as Map<String, dynamic>), 'problem_id': s.practiceId},
      ],
    };
  }

  /// サーバは UTF-8 で返す。`http.Response` の文字列版は latin1 なのでバイト列で返す。
  http.Response _json(Map<String, dynamic> body, int status) => http.Response.bytes(
    utf8.encode(jsonEncode(body)),
    status,
    headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
  );
}

Map<String, dynamic> _readFixture(String name) =>
    jsonDecode(File('$_fixtures/$name').readAsStringSync()) as Map<String, dynamic>;

// ---------------------------------------------------------------------------
// 台本(ロケールごと。板書も復習問題も課程ごと切り替わる。ADR 0005)
// ---------------------------------------------------------------------------

@immutable
class _Caption {
  const _Caption({
    required this.step,
    required this.headline,
    this.marker,
    this.markerColor = AppColors.said,
    this.sub,
  });

  /// 左上の章番号と名前(「1 撮る」)。
  final String step;
  final String headline;
  final String? marker;
  final Color markerColor;
  final String? sub;
}

@immutable
class _Script {
  const _Script({
    required this.locale,
    required this.sessionId,
    required this.appName,
    required this.tagline,
    required this.taglineMarker,
    required this.subjects,
    required this.footnote,
    required this.captions,
    required this.photoLabel,
    required this.photoInstruction,
    required this.photoEquation,
    required this.analysis,
    required this.lessonFixture,
    required this.stepCount,
    required this.msPerChar,
    required this.openingLine,
    required this.replyAfterStep,
    required this.studentReply,
    required this.senpaiVoiceLabel,
    required this.studentVoiceLabel,
    required this.practiceProblem,
    required this.topicLabel,
    required this.queueFixture,
    required this.answer,
    required this.gradingComment,
    required this.notificationHeading,
    required this.notificationBody,
    required this.lockTime,
    required this.lockDate,
    required this.now,
    required this.endLine,
    this.withAudio = false,
    this.musicCredit,
  });

  final String locale;
  final String sessionId;
  final String appName;
  final String tagline;
  final String taglineMarker;
  final String subjects;

  /// 何が本物で何が台本かの一言。画面の隅に出し続ける。
  final String footnote;
  final List<_Caption> captions;

  // 撮る問題の紙面
  final String photoLabel;
  final String photoInstruction;
  final String photoEquation;

  /// `POST /v1/sessions` の応答(`create-session-response*.json` の形)。
  final Map<String, dynamic> analysis;

  final String lessonFixture;

  /// 使う手順の数。最後の類題(`awaits_solving`)の手前で「わかった」を押す。
  final int stepCount;

  /// 字幕1文字あたりの間。日本語と英語で読む速さが違う。
  final int msPerChar;
  final String openingLine;

  /// この手順のあとで生徒が声で答える(先輩の「だから?」への返事)。
  final int replyAfterStep;
  final String studentReply;
  final String senpaiVoiceLabel;
  final String studentVoiceLabel;

  final Map<String, dynamic> practiceProblem;
  String get practiceId => practiceProblem['id'] as String;
  final String topicLabel;
  final String queueFixture;
  final String answer;
  final String gradingComment;

  /// `buildPracticeNotification`(packages/guardrail)の出力そのまま。
  final String notificationHeading;
  final String notificationBody;
  final String lockTime;
  final String lockDate;
  final String now;
  final String endLine;

  /// ナレーション・声・BGMを入れるか(`docs/store/demo-video/audio/<locale>/`)。
  final bool withAudio;

  /// BGMのクレジット(CC BY は表記が利用の条件)。締めのカードに出す。
  final String? musicCredit;
}

const _Script _ja = _Script(
  locale: 'ja',
  sessionId: 'ses_01J8Z9K2QF7X3M4N5P6R7S8T9V',
  appName: 'カタルテ',
  tagline: '「わかった」と言えるまで教える。\n3日後に、ほんとうにそうか聞く。',
  taglineMarker: 'ほんとうにそうか聞く',
  subjects: '中学・高校の数学と英語',
  footnote: '画面は実際のアプリです。AIの応答(読み取り・板書・採点)はデモ用の台本で再生しています。',
  captions: <_Caption>[
    _Caption(
      step: '1  撮る',
      headline: 'わからない問題を、撮る。',
      marker: '撮る',
      sub: '写真から単元と問題文を読み取ります。\nノートがあれば一緒に。',
    ),
    _Caption(
      step: '2  教わる',
      headline: 'AIの先輩が、\n板書つきで教える。',
      marker: '板書つきで',
      sub: '数式や計算は板書に。\n声は「だから?」と問いかけるだけ。',
    ),
    _Caption(
      step: '2  教わる',
      headline: '答えるのは、声で。',
      marker: '声で',
      sub: '先輩は言いっぱなしにせず、\n節目ごとに問いかけます。',
    ),
    _Caption(
      step: '3  わかった',
      headline: '授業を終わらせるのは、\n生徒の「わかった」。',
      marker: '「わかった」',
      sub: '押すまで同じ板書に積み続けます。\n押すと、その板書から復習問題が1問できます。',
    ),
    _Caption(
      step: '4  3日後',
      headline: '3日後、先輩から\nおさらいが届く。',
      marker: 'おさらいが届く',
      markerColor: AppColors.hole,
      sub: '1問だけ。30秒で終わるやつ。\n通知も煽らず、先輩の声で。',
    ),
    _Caption(
      step: '5  答える',
      headline: 'テキストで答えると、\nAIが採点する。',
      marker: 'AIが採点する',
      sub: '間違えた問題は、翌日・3日後・7日後に\nもう一度たずねます。',
    ),
    _Caption(
      step: '6  続ける',
      headline: '数えるのは、\n続けた日数と解けた問題。',
      marker: '続けた日数と解けた問題',
      markerColor: AppColors.streak,
      sub: '点数も順位も出しません。',
    ),
  ],
  photoLabel: '問 3',
  photoInstruction: '次の2次方程式の実数解の個数を求めよ。',
  photoEquation: 'x² − 3x + 2 = 0',
  analysis: <String, dynamic>{
    'session_id': 'ses_01J8Z9K2QF7X3M4N5P6R7S8T9V',
    'kind': 'new',
    'detected_topics': <Map<String, dynamic>>[
      <String, dynamic>{
        'topic_id': 'M1-NIJI-HANBETSU',
        'course': '数学I',
        'unit': '二次関数',
        'topic': '二次方程式の判別式と実数解の個数',
        'label': '数学I',
        'confidence': 0.93,
      },
    ],
    'problem': <String, dynamic>{
      'text': '次の2次方程式の実数解の個数を求めよ。 x^2 - 3x + 2 = 0',
      'source': 'problem_photo',
    },
    'problem_outcome': 'read',
  },
  lessonFixture: 'board-lesson.json',
  stepCount: 7,
  msPerChar: 115,
  openingLine: 'なるほど、じゃあ一緒に見てみようか。',
  replyAfterStep: 5,
  studentReply: '2個!',
  senpaiVoiceLabel: '先輩の声',
  studentVoiceLabel: 'きみの声',
  practiceProblem: <String, dynamic>{
    'id': 'prb_01J8Z9M4RT9H8I7J6K5L4M3N2P',
    'session_id': 'ses_01J8Z9K2QF7X3M4N5P6R7S8T9V',
    'board_id': 'brd_demo',
    'topic_id': 'M1-NIJI-HANBETSU',
    'question': 'x² − 6x + 5 = 0 の解の個数は?',
    'created_at': '2026-08-03T13:24:07.000Z',
  },
  topicLabel: '判別式と解の個数',
  queueFixture: 'practice-queue-response.json',
  answer: 'D = 36 − 20 = 16 で D > 0 だから 2個',
  gradingComment: 'D を出してから符号で判断する、っていう順番がそのまま書けてる。そこがいちばん大事なところ。',
  notificationHeading: '3日前の判別式と解の個数、おぼえてる?',
  notificationBody: '1問だけ置いておくね。30秒で終わるやつ。',
  lockTime: '7:40',
  lockDate: '8月6日 木曜日',
  now: 'いま',
  endLine: 'iPhone / iPad ・ オープンソース(MIT)',
);

const _Script _en = _Script(
  locale: 'en',
  sessionId: 'ses_01J8Z9K2QF7X3M4N5P6R7S8T9W',
  appName: 'Katarute',
  tagline: 'Taught until you say “Got it.”\nAsked again in 3 days.',
  taglineMarker: 'Asked again in 3 days',
  subjects: 'High school mathematics',
  footnote:
      'Real app screens. The AI responses (reading, board, grading) are replayed from a demo script.',
  captions: <_Caption>[
    _Caption(
      step: '1  Snap',
      headline: 'Snap the problem\nyou are stuck on.',
      marker: 'Snap the problem',
      sub: 'The app reads the topic and the problem text.\nAdd your notes too, if you have them.',
    ),
    _Caption(
      step: '2  Learn',
      headline: 'Your AI senpai teaches you\n— on the board.',
      marker: 'on the board',
      sub: 'The math goes on the board.\nThe voice just asks: “So?”',
    ),
    _Caption(
      step: '2  Learn',
      headline: 'You answer out loud.',
      marker: 'out loud',
      sub: 'Your senpai never lectures on and on.\nIt checks in at every turn.',
    ),
    _Caption(
      step: '3  Got it',
      headline: 'The lesson ends when\nyou say “Got it.”',
      marker: '“Got it.”',
      sub:
          'Until then, it keeps building the same board.\nThen one review question is made from it.',
    ),
    _Caption(
      step: '4  3 days later',
      headline: 'Three days later,\nyour senpai checks back.',
      marker: 'checks back',
      markerColor: AppColors.hole,
      sub: 'Just one question. About 30 seconds.\nNo nagging, no streak threats.',
    ),
    _Caption(
      step: '5  Answer',
      headline: 'Type your answer.\nAI grades it.',
      marker: 'AI grades it',
      sub: 'Missed it? It asks again\nafter 1, 3 and 7 days.',
    ),
    _Caption(
      step: '6  Keep going',
      headline: 'We count days\nand solved problems.',
      marker: 'days\nand solved problems',
      markerColor: AppColors.streak,
      sub: 'Never a score. Never a ranking.',
    ),
  ],
  photoLabel: 'Problem 3',
  photoInstruction: 'Solve the inequality.',
  photoEquation: 'x² − 3x + 2 < 0',
  analysis: <String, dynamic>{
    'session_id': 'ses_01J8Z9K2QF7X3M4N5P6R7S8T9W',
    'kind': 'new',
    'detected_topics': <Map<String, dynamic>>[
      <String, dynamic>{
        'topic_id': 'A2-INEQ-QUADRATIC',
        'course': 'Algebra 2',
        'unit': 'Inequalities',
        'topic': 'Quadratic and rational inequalities',
        'label': 'Algebra 2',
        'confidence': 0.91,
      },
    ],
    'problem': <String, dynamic>{
      'text': 'Solve the inequality. x^2 - 3x + 2 < 0',
      'source': 'problem_photo',
    },
    'problem_outcome': 'read',
  },
  lessonFixture: 'board-lesson.en.json',
  stepCount: 6,
  msPerChar: 55,
  openingLine: "Okay, let's take a look at this together.",
  replyAfterStep: 1,
  studentReply: '(x − 1)(x − 2)',
  senpaiVoiceLabel: "Senpai's voice",
  studentVoiceLabel: 'Your voice',
  practiceProblem: <String, dynamic>{
    'id': 'prb_01J8Z9M4RT9H8I7J6K5L4M3N2Q',
    'session_id': 'ses_01J8Z9K2QF7X3M4N5P6R7S8T9W',
    'board_id': 'brd_demo',
    'topic_id': 'A2-INEQ-QUADRATIC',
    'question': 'Solve x² − 7x + 10 < 0.',
    'created_at': '2026-08-03T13:24:07.000Z',
  },
  topicLabel: 'quadratic inequality',
  queueFixture: 'practice-queue-response.json',
  answer: '(x − 2)(x − 5) < 0, so 2 < x < 5',
  gradingComment:
      'You found the roots first, then kept the part below zero. That order is the whole method.',
  notificationHeading: 'That quadratic inequality from 3 days ago — still with you?',
  notificationBody: 'Just one question. Takes about 30 seconds.',
  lockTime: '7:40',
  lockDate: 'Thursday, August 6',
  now: 'now',
  endLine: 'iPhone / iPad · Open source (MIT)',
  withAudio: true,
  musicCredit:
      'Music: “Carefree” Kevin MacLeod (incompetech.com) · Licensed under Creative Commons: By Attribution 4.0',
);

// ---------------------------------------------------------------------------
// 舞台(16:9 の画面。左に見出し、右に端末)
// ---------------------------------------------------------------------------

enum _Card { none, title, end }

/// 声の字幕。**アプリは板書が出ているあいだ字幕を出さない**(`session_screen.dart`:
/// 読むべきものは板書のほう)が、動画には音が無いので、舞台の側に出す。
@immutable
class _Voice {
  const _Voice(this.text, {this.student = false});

  final String text;
  final bool student;
}

class _Stage extends ChangeNotifier {
  _Card card = _Card.title;
  _Caption? caption;
  Offset? tapAt;
  int tapId = 0;
  _Voice? voice;
  bool lockScreen = false;
  bool notification = false;

  void update({
    _Card? card,
    _Caption? caption,
    Offset? tapAt,
    _Voice? voice,
    bool clearVoice = false,
    bool? lockScreen,
    bool? notification,
  }) {
    if (card != null) this.card = card;
    if (caption != null) this.caption = caption;
    if (tapAt != null) {
      this.tapAt = tapAt;
      tapId++;
    }
    if (voice != null) this.voice = voice;
    if (clearVoice) this.voice = null;
    if (lockScreen != null) this.lockScreen = lockScreen;
    if (notification != null) this.notification = notification;
    notifyListeners();
  }
}

const Color _canvasTop = Color(0xFFE6F4FE);
const Color _canvasBottom = Color(0xFFFBFAF7);
const String _font = 'ZenMaruGothic';

class _StageView extends StatelessWidget {
  const _StageView({required this.stage, required this.script, required this.phone});

  final _Stage stage;
  final _Script script;

  /// 端末の中身。**同じインスタンスを渡し続ける**(作り直すとアプリの状態が消える)。
  final Widget phone;

  @override
  Widget build(BuildContext context) {
    return MediaQuery(
      data: const MediaQueryData(size: _stageSize),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: DefaultTextStyle(
          style: const TextStyle(fontFamily: _font, color: AppColors.ink),
          child: ListenableBuilder(
            listenable: stage,
            builder: (BuildContext context, Widget? phoneChild) => Stack(
              children: <Widget>[
                const Positioned.fill(
                  key: ValueKey<String>('bg'),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: <Color>[_canvasTop, _canvasBottom],
                      ),
                    ),
                  ),
                ),
                Positioned(
                  key: const ValueKey<String>('caption'),
                  left: 150,
                  top: 190,
                  bottom: 0,
                  width: 900,
                  child: Align(
                    alignment: Alignment.topLeft,
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 450),
                      switchInCurve: Curves.easeOutCubic,
                      transitionBuilder: (Widget child, Animation<double> animation) =>
                          FadeTransition(
                            opacity: animation,
                            child: SlideTransition(
                              position: Tween<Offset>(
                                begin: const Offset(0, 0.06),
                                end: Offset.zero,
                              ).animate(animation),
                              child: child,
                            ),
                          ),
                      child: stage.caption == null
                          ? const SizedBox.shrink()
                          : _CaptionView(
                              key: ValueKey<_Caption>(stage.caption!),
                              caption: stage.caption!,
                            ),
                    ),
                  ),
                ),
                Positioned(
                  key: const ValueKey<String>('phone'),
                  left: _phoneRect.left - _bezel,
                  top: _phoneRect.top - _bezel,
                  child: _PhoneFrame(
                    child: Stack(
                      children: <Widget>[
                        Positioned.fill(child: phoneChild!),
                        Positioned.fill(
                          child: IgnorePointer(
                            ignoring: !stage.lockScreen,
                            child: AnimatedOpacity(
                              opacity: stage.lockScreen ? 1 : 0,
                              duration: const Duration(milliseconds: 550),
                              curve: Curves.easeInOut,
                              child: _LockScreen(script: script, notification: stage.notification),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                Positioned(
                  key: const ValueKey<String>('voice'),
                  left: 150,
                  top: 700,
                  width: 900,
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 280),
                    layoutBuilder: (Widget? current, List<Widget> previous) => Stack(
                      alignment: Alignment.topLeft,
                      children: <Widget>[...previous, ?current],
                    ),
                    child: stage.voice == null
                        ? const SizedBox.shrink()
                        : _VoiceLine(
                            key: ValueKey<String>(stage.voice!.text),
                            voice: stage.voice!,
                            label: stage.voice!.student
                                ? script.studentVoiceLabel
                                : script.senpaiVoiceLabel,
                          ),
                  ),
                ),
                Positioned(
                  key: const ValueKey<String>('footnote'),
                  left: 150,
                  right: _stageSize.width - _phoneRect.left + 60,
                  bottom: 40,
                  child: Text(
                    script.footnote,
                    style: const TextStyle(fontSize: 19, height: 1.5, color: AppColors.inkMuted),
                  ),
                ),
                if (stage.tapAt != null)
                  Positioned(
                    key: ValueKey<String>('tap-${stage.tapId}'),
                    left: stage.tapAt!.dx - 60,
                    top: stage.tapAt!.dy - 60,
                    child: const IgnorePointer(child: _TapRipple()),
                  ),
                Positioned.fill(
                  key: const ValueKey<String>('card'),
                  child: IgnorePointer(
                    ignoring: stage.card == _Card.none,
                    child: AnimatedOpacity(
                      opacity: stage.card == _Card.none ? 0 : 1,
                      duration: const Duration(milliseconds: 650),
                      curve: Curves.easeInOut,
                      child: _CardView(script: script, end: stage.card == _Card.end),
                    ),
                  ),
                ),
              ],
            ),
            child: phone,
          ),
        ),
      ),
    );
  }
}

/// 端末の縁。ストアのスクショは縁を描かないが、動画では「スマホの画面」だと
/// 一目で分かるほうが通じる(横長の画面の中に縦長の絵が浮くので)。
class _PhoneFrame extends StatelessWidget {
  const _PhoneFrame({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(_bezel),
      decoration: BoxDecoration(
        color: AppColors.ink,
        borderRadius: BorderRadius.circular(66),
        boxShadow: const <BoxShadow>[
          BoxShadow(color: Color(0x2633323D), blurRadius: 48, offset: Offset(0, 18)),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(54),
        child: SizedBox(
          width: _phoneRect.width,
          height: _phoneRect.height,
          child: FittedBox(
            child: SizedBox.fromSize(size: _phoneLogical, child: child),
          ),
        ),
      ),
    );
  }
}

/// 端末の中のアプリ。本番の `AiSenseiApp` と同じデリゲート・同じルータ。
///
/// `wrapRouter`(テストの足場)と違って**動きを止めない**。動画なので。
class _PhoneApp extends StatelessWidget {
  const _PhoneApp({required this.container, required this.locale});

  final ProviderContainer container;
  final Locale locale;

  @override
  Widget build(BuildContext context) {
    return MediaQuery(
      data: const MediaQueryData(size: _phoneLogical, devicePixelRatio: 3),
      child: UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light(),
          locale: locale,
          supportedLocales: AppStrings.supportedLocales,
          localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
            AppStringsDelegate(),
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          routerConfig: container.read(appRouterProvider),
        ),
      ),
    );
  }
}

class _CaptionView extends StatelessWidget {
  const _CaptionView({super.key, required this.caption});

  final _Caption caption;

  @override
  Widget build(BuildContext context) {
    final List<String> step = caption.step.split('  ');
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: const BoxDecoration(color: AppColors.ink, shape: BoxShape.circle),
              child: Text(
                step.first,
                style: const TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                  height: 1,
                ),
              ),
            ),
            const SizedBox(width: 18),
            Text(
              step.last,
              style: const TextStyle(
                fontSize: 30,
                fontWeight: FontWeight.w700,
                color: AppColors.inkMuted,
              ),
            ),
          ],
        ),
        const SizedBox(height: 34),
        _MarkerText(
          text: caption.headline,
          marker: caption.marker,
          markerColor: caption.markerColor,
          style: const TextStyle(
            fontFamily: _font,
            fontSize: 62,
            fontWeight: FontWeight.w700,
            height: 1.42,
            color: AppColors.ink,
          ),
        ),
        if (caption.sub != null) ...<Widget>[
          const SizedBox(height: 30),
          Text(
            caption.sub!,
            style: const TextStyle(
              fontSize: 32,
              fontWeight: FontWeight.w500,
              height: 1.6,
              color: AppColors.inkMuted,
            ),
          ),
        ],
      ],
    );
  }
}

/// 見出しの強調は bold ではなく蛍光マーカー(ストア素材と同じ作法)。
class _MarkerText extends StatelessWidget {
  const _MarkerText({
    required this.text,
    required this.style,
    this.marker,
    this.markerColor = AppColors.said,
    this.textAlign = TextAlign.left,
  });

  final String text;
  final String? marker;
  final Color markerColor;
  final TextStyle style;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final TextPainter painter = TextPainter(
          text: TextSpan(text: text, style: style),
          textAlign: textAlign,
          textDirection: TextDirection.ltr,
        )..layout(maxWidth: constraints.maxWidth);
        return CustomPaint(
          size: Size(
            textAlign == TextAlign.center ? constraints.maxWidth : painter.width,
            painter.height,
          ),
          painter: _MarkerPainter(painter, text, marker, markerColor, textAlign),
        );
      },
    );
  }
}

class _MarkerPainter extends CustomPainter {
  _MarkerPainter(this.painter, this.text, this.marker, this.color, this.align);

  final TextPainter painter;
  final String text;
  final String? marker;
  final Color color;
  final TextAlign align;

  @override
  void paint(Canvas canvas, Size size) {
    final Offset origin = align == TextAlign.center
        ? Offset((size.width - painter.width) / 2, 0)
        : Offset.zero;
    final int start = marker == null ? -1 : text.indexOf(marker!);
    if (start >= 0) {
      for (final TextBox box in painter.getBoxesForSelection(
        TextSelection(baseOffset: start, extentOffset: start + marker!.length),
      )) {
        final Rect r = box.toRect().shift(origin);
        if (r.width < 1) continue;
        canvas.drawRect(
          Rect.fromLTRB(r.left, r.top + r.height * 0.54, r.right, r.top + r.height * 0.95),
          Paint()..color = color.withValues(alpha: 0.92),
        );
      }
    }
    painter.paint(canvas, origin);
  }

  @override
  bool shouldRepaint(_MarkerPainter old) =>
      old.text != text || old.marker != marker || old.color != color;
}

/// 声の字幕の1行。先輩はアプリのマーク(= 先輩の顔)、生徒はマイク。
class _VoiceLine extends StatelessWidget {
  const _VoiceLine({super.key, required this.voice, required this.label});

  final _Voice voice;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 20, 30, 22),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(28),
        border: Border.all(
          color: voice.student ? AppColors.blue : AppColors.border,
          width: voice.student ? 3 : 2,
        ),
        boxShadow: const <BoxShadow>[
          BoxShadow(color: Color(0x1433323D), blurRadius: 24, offset: Offset(0, 8)),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (voice.student)
            Container(
              width: 60,
              height: 60,
              decoration: const BoxDecoration(color: AppColors.blue, shape: BoxShape.circle),
              child: const Icon(Icons.mic_rounded, color: Colors.white, size: 36),
            )
          else
            const _AppMarkBox(size: 60),
          const SizedBox(width: 20),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(
                      voice.student ? Icons.mic_none_rounded : Icons.volume_up_rounded,
                      size: 22,
                      color: AppColors.inkMuted,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.w700,
                        color: AppColors.inkMuted,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  voice.text,
                  style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w700, height: 1.45),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TapRipple extends StatelessWidget {
  const _TapRipple();

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: const Duration(milliseconds: 650),
      curve: Curves.easeOut,
      builder: (BuildContext context, double t, Widget? _) {
        final double radius = 20 + 36 * t;
        return SizedBox(
          width: 120,
          height: 120,
          child: Center(
            child: Container(
              width: radius * 2,
              height: radius * 2,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.blue.withValues(alpha: 0.38 * (1 - t)),
                border: Border.all(color: Colors.white.withValues(alpha: 1 - t), width: 4),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 表紙と締め。
class _CardView extends StatelessWidget {
  const _CardView({required this.script, required this.end});

  final _Script script;
  final bool end;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[_canvasTop, _canvasBottom],
        ),
      ),
      child: Center(
        child: SizedBox(
          width: 1400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const _AppMarkBox(size: 128),
                  const SizedBox(width: 36),
                  Text(
                    script.appName,
                    style: const TextStyle(fontSize: 84, fontWeight: FontWeight.w700, height: 1.2),
                  ),
                ],
              ),
              const SizedBox(height: 64),
              _MarkerText(
                text: script.tagline,
                marker: script.taglineMarker,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontFamily: _font,
                  fontSize: 58,
                  fontWeight: FontWeight.w700,
                  height: 1.5,
                  color: AppColors.ink,
                ),
              ),
              const SizedBox(height: 44),
              Text(
                end ? '${script.subjects}   ·   ${script.endLine}' : script.subjects,
                style: const TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.w500,
                  color: AppColors.inkMuted,
                ),
              ),
              if (end) ...<Widget>[
                const SizedBox(height: 18),
                const Text(
                  'github.com/sarushili0430/ai-sensei',
                  style: TextStyle(
                    fontSize: 28,
                    color: AppColors.blue,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (script.musicCredit != null) ...<Widget>[
                  const SizedBox(height: 56),
                  Text(
                    script.musicCredit!,
                    style: const TextStyle(fontSize: 20, color: AppColors.inkMuted),
                  ),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AppMarkBox extends StatelessWidget {
  const _AppMarkBox({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.22),
      child: CustomPaint(size: Size.square(size), painter: _AppMarkPainter()),
    );
  }
}

class _AppMarkPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) => AppMark.paint(canvas, size.width);

  @override
  bool shouldRepaint(_AppMarkPainter oldDelegate) => false;
}

/// 3日後のロック画面。**OS の画面なので描いている**(アプリの画面ではない)。
/// 文面だけは本番の通知と同じもの(`buildPracticeNotification` の出力)。
class _LockScreen extends StatelessWidget {
  const _LockScreen({required this.script, required this.notification});

  final _Script script;
  final bool notification;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[Color(0xFF1F2B4D), Color(0xFF51659A), Color(0xFFD6A48F)],
        ),
      ),
      child: DefaultTextStyle(
        style: const TextStyle(fontFamily: _font, color: Colors.white),
        child: Column(
          children: <Widget>[
            const SizedBox(height: 84),
            Text(
              script.lockDate,
              style: const TextStyle(
                fontSize: 19,
                fontWeight: FontWeight.w700,
                color: Color(0xDDFFFFFF),
              ),
            ),
            Text(
              script.lockTime,
              style: const TextStyle(fontSize: 92, fontWeight: FontWeight.w700, height: 1.1),
            ),
            const SizedBox(height: 36),
            AnimatedSlide(
              offset: notification ? Offset.zero : const Offset(0, -0.4),
              duration: const Duration(milliseconds: 450),
              curve: Curves.easeOutCubic,
              child: AnimatedOpacity(
                opacity: notification ? 1 : 0,
                duration: const Duration(milliseconds: 350),
                child: Container(
                  key: const ValueKey<String>('demo-notification'),
                  margin: const EdgeInsets.symmetric(horizontal: 12),
                  padding: const EdgeInsets.fromLTRB(14, 14, 16, 16),
                  decoration: BoxDecoration(
                    color: const Color(0xEBFFFFFF),
                    borderRadius: BorderRadius.circular(24),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      const _AppMarkBox(size: 40),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Row(
                              children: <Widget>[
                                Expanded(
                                  child: Text(
                                    script.notificationHeading,
                                    style: const TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w700,
                                      color: AppColors.ink,
                                      height: 1.35,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  script.now,
                                  style: const TextStyle(fontSize: 12, color: AppColors.inkMuted),
                                ),
                              ],
                            ),
                            const SizedBox(height: 3),
                            Text(
                              script.notificationBody,
                              style: const TextStyle(
                                fontSize: 15,
                                color: AppColors.ink,
                                height: 1.35,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 撮る問題の紙面(カメラが返す写真)
// ---------------------------------------------------------------------------

/// 問題集の1問を、机の上で撮った体の写真にする。
///
/// **教科書・問題集の実物は写さない**(他者の著作物。アプリ側でも問題の紙面は
/// 解析後に破棄している)。問題はここで組んだもので、板書の fixture と同じ式。
Future<File> _writeProblemPhoto(_Script s, Directory dir) async {
  const double w = 1500;
  const double h = 1125;
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);

  // 机
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, const Offset(w, h), <Color>[
        const Color(0xFF8A7563),
        const Color(0xFF5E4C3F),
      ]),
  );

  // 紙(少し傾ける)
  canvas.save();
  canvas.translate(w / 2, h / 2);
  canvas.rotate(-0.035);
  canvas.translate(-w / 2, -h / 2);
  const Rect paper = Rect.fromLTWH(120, 110, 1260, 905);
  canvas.drawRect(
    paper.shift(const Offset(10, 18)),
    Paint()
      ..color = const Color(0x66000000)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 22),
  );
  canvas.drawRect(paper, Paint()..color = const Color(0xFFFAF8F1));

  void text(
    String body,
    Offset at,
    double size, {
    FontWeight weight = FontWeight.w400,
    String? family,
    String? package,
  }) {
    final TextPainter painter = TextPainter(
      text: TextSpan(
        text: body,
        style: TextStyle(
          fontFamily: family ?? _font,
          package: package,
          fontSize: size,
          fontWeight: weight,
          color: const Color(0xFF26252B),
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout(maxWidth: paper.width - 160);
    painter.paint(canvas, at);
  }

  // 見出しの帯
  canvas.drawRect(
    Rect.fromLTWH(paper.left + 80, paper.top + 110, 150, 64),
    Paint()..color = const Color(0xFF26252B),
  );
  final TextPainter label = TextPainter(
    text: TextSpan(
      text: s.photoLabel,
      style: const TextStyle(
        fontFamily: _font,
        fontSize: 38,
        fontWeight: FontWeight.w700,
        color: Colors.white,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  label.paint(
    canvas,
    Offset(paper.left + 80 + (150 - label.width) / 2, paper.top + 110 + (64 - label.height) / 2),
  );
  text(s.photoInstruction, Offset(paper.left + 260, paper.top + 116), 44);
  text(
    s.photoEquation,
    Offset(paper.left + 300, paper.top + 300),
    92,
    family: 'KaTeX_Main',
    package: 'flutter_math_fork',
  );

  // 鉛筆の書きかけ(解いていない。式を写しかけて止まった跡)
  final Paint pencil = Paint()
    ..color = const Color(0x8C3A3A48)
    ..style = PaintingStyle.stroke
    ..strokeWidth = 5
    ..strokeCap = StrokeCap.round;
  final Path scribble = Path()
    ..moveTo(paper.left + 320, paper.top + 640)
    ..quadraticBezierTo(paper.left + 360, paper.top + 600, paper.left + 400, paper.top + 640)
    ..moveTo(paper.left + 450, paper.top + 615)
    ..lineTo(paper.left + 500, paper.top + 615)
    ..moveTo(paper.left + 560, paper.top + 590)
    ..quadraticBezierTo(paper.left + 575, paper.top + 700, paper.left + 600, paper.top + 590);
  canvas.drawPath(scribble, pencil);
  text('?', Offset(paper.left + 660, paper.top + 560), 96, weight: FontWeight.w700);
  canvas.restore();

  // 光のむら(写真らしさ)
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.radial(const Offset(w * 0.4, h * 0.3), w * 0.8, <Color>[
        const Color(0x22FFFFFF),
        const Color(0x33000000),
      ]),
  );

  final ui.Image image = await recorder.endRecording().toImage(w.toInt(), h.toInt());
  final ByteData? png = await image.toByteData(format: ui.ImageByteFormat.png);
  final File file = File('${dir.path}/problem.png');
  await file.writeAsBytes(png!.buffer.asUint8List(), flush: true);
  return file;
}
