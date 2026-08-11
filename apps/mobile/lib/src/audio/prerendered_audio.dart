import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart' as just_audio;

/// 通信せずに鳴らす、先輩の短い一言。
///
/// **何を、いつ鳴らすかの正はこの列挙。** パスを画面側へ散らすと、日英の片方だけを
/// 足し忘れたり、同じ一言を別のタイミングで使い回したりしてもレビューで追えない。
/// ここでは用途ごとに別 cue とし、各 cue が必ず ja / en の2本を持つ形にする。
enum PrerenderedAudioCue {
  /// 授業用の LiveKit 接続が済んだ直後から、最初の板書手順または先輩の発話まで。
  lessonOpening(
    jaTranscript: 'なるほど、じゃあ一緒に見てみようか。',
    enTranscript: "Okay, let's take a look at this together.",
    jaAsset: 'assets/audio/lesson_opening.ja.m4a',
    enAsset: 'assets/audio/lesson_opening.en.m4a',
  ),

  /// 自習室に入って10分が経ち、`SenpaiNudge.going` へ切り替わった瞬間。
  studyRoomGoing(
    jaTranscript: '順調?',
    enTranscript: "How's it going?",
    jaAsset: 'assets/audio/study_room_going.ja.m4a',
    enAsset: 'assets/audio/study_room_going.en.m4a',
  ),

  /// 自習室に入って25分が経ち、休憩を提案する瞬間。
  studyRoomBreak(
    jaTranscript: 'そろそろ休憩する?',
    enTranscript: 'Want to take a break?',
    jaAsset: 'assets/audio/study_room_break.ja.m4a',
    enAsset: 'assets/audio/study_room_break.en.m4a',
  ),

  /// 自習室に入って50分が経ち、いったん席を立つよう勧める瞬間。
  studyRoomLong(
    jaTranscript: 'けっこう集中してるね。ひと息ついてきな。',
    enTranscript: "You've been at this a while. Go stretch.",
    jaAsset: 'assets/audio/study_room_long.ja.m4a',
    enAsset: 'assets/audio/study_room_long.en.m4a',
  );

  const PrerenderedAudioCue({
    required this.jaTranscript,
    required this.enTranscript,
    required this.jaAsset,
    required this.enAsset,
  });

  final String jaTranscript;
  final String enTranscript;
  final String jaAsset;
  final String enAsset;

  /// アプリが対応するロケールは ja / en だけ。未知の言語を日本語へ倒すと、
  /// `AppStrings.resolve` の「日本語を明示した端末以外は英語」と食い違うので英語へ倒す。
  String assetFor(String languageCode) =>
      languageCode == 'ja' ? jaAsset : enAsset;
}

/// アセットを実際に鳴らす境界。
///
/// widget test が `just_audio` の MethodChannel を起動しないよう、画面はこの型だけを
/// 知る。本番実装もテスト用 fake も、同じ「cue とロケール」を受け取るので、テストが
/// ファイルパスの組み立てを再実装して本番とずれることがない。
abstract interface class PrerenderedAudioPlayer {
  /// 再生を開始したら返る。音声の終端までは待たない。
  Future<void> play(PrerenderedAudioCue cue, {required String languageCode});

  Future<void> stop();

  Future<void> dispose();
}

/// テスト・プレビューの既定値。
///
/// 本番は `main.dart` で [JustAudioPrerenderedAudioPlayer] に差し替える。既定を無音に
/// しているのは、Widget を1個組むだけのテストがプラットフォーム音声を起動しないため。
/// 差し替えを忘れても失われるのは装飾音だけで、吹き出しと操作は残る。
class SilentPrerenderedAudioPlayer implements PrerenderedAudioPlayer {
  const SilentPrerenderedAudioPlayer();

  @override
  Future<void> play(
    PrerenderedAudioCue cue, {
    required String languageCode,
  }) async {}

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

/// OS の消音状態を確認し、装飾音に適した出力へ整える境界。
abstract interface class DecorativeAudioPolicy {
  /// 鳴らしてよければ true。判断できない・準備に失敗した場合は false へ倒す。
  Future<bool> prepare();
}

/// iOS / Android の消音設定を読むための、小さなネイティブ境界。
///
/// iOS は消音スイッチを公開 API で直接読めないため、`AVAudioSession` を
/// `.ambient` にして OS 自身に消音してもらう。Android は ringer mode とメディア音量を
/// 読むだけで、**どちらもこちらから音量を変更しない**。実装は AppDelegate / MainActivity。
class PlatformDecorativeAudioPolicy implements DecorativeAudioPolicy {
  const PlatformDecorativeAudioPolicy();

  static const MethodChannel _channel = MethodChannel(
    'jp.co.aiSensei/decorative_audio',
  );

  @override
  Future<bool> prepare() async {
    try {
      return await _channel.invokeMethod<bool>('prepare') ?? false;
    } on MissingPluginException {
      // iOS / Android で登録漏れを「鳴らしてよい」と解釈すると、消音スイッチを
      // 迂回する事故になる。開発用の desktop / web だけ既定へ任せ、本番2ターゲットは
      // 音を失う側へ倒す。文字が正本なので、安全側へ倒しても導線は失われない。
      final bool isMobile =
          !kIsWeb &&
          (defaultTargetPlatform == TargetPlatform.iOS ||
              defaultTargetPlatform == TargetPlatform.android);
      return !isMobile;
    } on PlatformException catch (error) {
      // 音は装飾なので、ポリシーを確認できないときに推測で鳴らさない。
      debugPrint('端末の消音設定を確認できなかったため、装飾音を鳴らしません: $error');
      return false;
    }
  }
}

/// `just_audio` を使う本番の再生器。
class JustAudioPrerenderedAudioPlayer implements PrerenderedAudioPlayer {
  factory JustAudioPrerenderedAudioPlayer({
    just_audio.AudioPlayer? player,
    DecorativeAudioPolicy policy = const PlatformDecorativeAudioPolicy(),
  }) => JustAudioPrerenderedAudioPlayer._(
    player ??
        just_audio.AudioPlayer(
          // just_audio の既定は「音楽プレイヤー」用の audio session を有効にし、
          // iOS の消音スイッチを迂回する。上の policy が ambient を選ぶので、
          // ここでは再度 activate して上書きさせない。
          handleAudioSessionActivation: false,
        ),
    policy,
  );

  JustAudioPrerenderedAudioPlayer._(this._player, this._policy);

  final just_audio.AudioPlayer _player;
  final DecorativeAudioPolicy _policy;

  /// `setAsset` の途中で stop / 次の cue が来ても、古い読み込み完了後に鳴らさないための世代。
  int _operation = 0;

  @override
  Future<void> play(
    PrerenderedAudioCue cue, {
    required String languageCode,
  }) async {
    final int operation = ++_operation;
    if (!await _policy.prepare() || operation != _operation) return;

    await _player.setAsset(cue.assetFor(languageCode));
    if (operation != _operation) return;

    // `AudioPlayer.play()` は終端まで返らない。ここで await すると、呼び出し側が
    // 「再生を始めてから LiveKit のマイクを開く」順序を作れないので、開始だけ行い、
    // 終端側の失敗はこの層で回収する。
    unawaited(_finishQuietly(_player.play()));
  }

  Future<void> _finishQuietly(Future<void> playback) async {
    try {
      await playback;
    } on Object catch (error) {
      // 再生中のデコード失敗も導線を止めない。吹き出しが情報の正本。
      debugPrint('プリレンダ音声の再生中に失敗しました(画面は続けます): $error');
    }
  }

  @override
  Future<void> stop() async {
    _operation += 1;
    await _player.stop();
  }

  @override
  Future<void> dispose() async {
    _operation += 1;
    await _player.dispose();
  }
}

/// アプリ内の「音を鳴らす / 鳴らさない」の1か所。
///
/// `AppMotion.isReduced` と同じく、各 Widget が独自判断を持たないための設定。
/// ユーザー向けには端末の消音・マナーモードをそのまま設定として使い、アプリ設定画面に
/// 二重のスイッチは置かない。二重にすると「アプリではオンだが端末では無音」という
/// 読めない状態が増える一方、声の内容は常に吹き出しにも残るためである。
/// Provider にしてあるのは、widget test では明示的に false にでき、将来 OS に
/// アプリ単位の音声設定が増えても画面を触らず差し替えられるようにするため。
final Provider<bool> decorativeAudioEnabledProvider = Provider<bool>(
  (Ref ref) => true,
);

/// 実機だけ `main.dart` から本物へ差し替える。テストで本物を起動しない防波堤。
final Provider<PrerenderedAudioPlayer> prerenderedAudioPlayerProvider =
    Provider<PrerenderedAudioPlayer>(
      (Ref ref) => const SilentPrerenderedAudioPlayer(),
    );

/// cue の競合・失敗を画面から追い出す薄い再生サービス。
final Provider<PrerenderedAudio> prerenderedAudioProvider =
    Provider<PrerenderedAudio>(
      (Ref ref) => PrerenderedAudio(
        player: ref.watch(prerenderedAudioPlayerProvider),
        isEnabled: () => ref.read(decorativeAudioEnabledProvider),
      ),
    );

class PrerenderedAudio {
  factory PrerenderedAudio({
    required PrerenderedAudioPlayer player,
    required bool Function() isEnabled,
  }) => PrerenderedAudio._(player, isEnabled);

  PrerenderedAudio._(this._player, this._isEnabled);

  final PrerenderedAudioPlayer _player;
  final bool Function() _isEnabled;

  int _nextPlaybackId = 0;
  int? _currentPlaybackId;

  /// 新しい cue は古い cue を置き換える。戻り値は、その呼び出しだけを止めるための札。
  ///
  /// 画面Aの dispose が遅れて来たあと画面Bが別の cue を鳴らし始めても、Aの停止で
  /// Bまで止めないため、グローバルな `stop()` を画面へ直接渡さない。
  Future<int?> play(
    PrerenderedAudioCue cue, {
    required String languageCode,
  }) async {
    if (!_isEnabled()) return null;

    final int playbackId = ++_nextPlaybackId;
    _currentPlaybackId = playbackId;
    try {
      await _player.play(cue, languageCode: languageCode);
    } on Object catch (error) {
      if (_currentPlaybackId == playbackId) _currentPlaybackId = null;
      // アセット欠落・デコード失敗・ネイティブ実装の失敗のどれでも画面を壊さない。
      debugPrint('プリレンダ音声を再生できませんでした(画面は続けます): $error');
      return null;
    }

    // 読み込み中に別の cue または停止が来た。古い画面へ停止札を返さない。
    return _currentPlaybackId == playbackId ? playbackId : null;
  }

  /// [playbackId] がいまの音に一致するときだけ止める。
  Future<void> stop(int? playbackId) async {
    if (playbackId == null || _currentPlaybackId != playbackId) return;
    _currentPlaybackId = null;
    try {
      await _player.stop();
    } on Object catch (error) {
      // 停止に失敗しても画面遷移を待たせない。再生器の次の play が世代を進める。
      debugPrint('プリレンダ音声を停止できませんでした(画面は続けます): $error');
    }
  }
}
