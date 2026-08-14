import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart' as just_audio;

/// Short senpai lines played without any network call.
///
/// This enum is the source of truth for what plays and when. Scattering paths
/// across screens would hide a missing ja or en variant, or the same line
/// reused at a different moment. One cue per purpose, each holding both locales.
enum PrerenderedAudioCue {
  /// From the lesson's LiveKit connection until the first board step or
  /// senpai utterance.
  lessonOpening(
    jaTranscript: 'なるほど、じゃあ一緒に見てみようか。',
    enTranscript: "Okay, let's take a look at this together.",
    jaAsset: 'assets/audio/lesson_opening.ja.m4a',
    enAsset: 'assets/audio/lesson_opening.en.m4a',
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

  /// Only ja / en are supported. Unknown languages fall back to English to
  /// match `AppStrings.resolve`, which sends all but explicit Japanese to en.
  String assetFor(String languageCode) =>
      languageCode == 'ja' ? jaAsset : enAsset;
}

/// The boundary that actually plays an asset.
///
/// Screens know only this type, so widget tests never start `just_audio`'s
/// MethodChannel. Both the real implementation and the fake take the same cue
/// and locale, so tests cannot re-implement path building and drift.
abstract interface class PrerenderedAudioPlayer {
  /// Returns once playback starts; does not wait for the audio to finish.
  Future<void> play(PrerenderedAudioCue cue, {required String languageCode});

  Future<void> stop();

  Future<void> dispose();
}

/// Default for tests and previews.
///
/// `main.dart` swaps in [JustAudioPrerenderedAudioPlayer] for release. Silence
/// is the default so building a single widget in a test never starts platform
/// audio; forgetting the swap loses only decorative sound, never the captions
/// or controls.
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

/// Boundary that checks the OS mute state and prepares suitable output.
abstract interface class DecorativeAudioPolicy {
  /// True if sound is allowed; falls back to false when unknown or on failure.
  Future<bool> prepare();
}

/// Small native boundary for reading the iOS / Android mute setting.
///
/// iOS exposes no public API for the mute switch, so `AVAudioSession` is set to
/// `.ambient` and the OS mutes for us. Android only reads ringer mode and media
/// volume. Neither ever changes the volume. Implemented in AppDelegate /
/// MainActivity.
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
      // Treating a missing registration as "allowed" on iOS / Android would
      // bypass the mute switch. Only the desktop / web dev targets take the
      // default; the two shipping targets fail towards silence. Text is the
      // source of truth, so the safe choice loses nothing.
      final bool isMobile =
          !kIsWeb &&
          (defaultTargetPlatform == TargetPlatform.iOS ||
              defaultTargetPlatform == TargetPlatform.android);
      return !isMobile;
    } on PlatformException catch (error) {
      // Sound is decorative; never guess when the policy cannot be read.
      debugPrint('端末の消音設定を確認できなかったため、装飾音を鳴らしません: $error');
      return false;
    }
  }
}

/// Production player backed by `just_audio`.
class JustAudioPrerenderedAudioPlayer implements PrerenderedAudioPlayer {
  factory JustAudioPrerenderedAudioPlayer({
    just_audio.AudioPlayer? player,
    DecorativeAudioPolicy policy = const PlatformDecorativeAudioPolicy(),
  }) => JustAudioPrerenderedAudioPlayer._(
    player ??
        just_audio.AudioPlayer(
          // just_audio defaults to activating a music-player audio session,
          // which bypasses the iOS mute switch. The policy above already chose
          // ambient, so do not let it re-activate and override that.
          handleAudioSessionActivation: false,
        ),
    policy,
  );

  JustAudioPrerenderedAudioPlayer._(this._player, this._policy);

  final just_audio.AudioPlayer _player;
  final DecorativeAudioPolicy _policy;

  /// Generation counter, so a load finishing after a stop or a newer cue does
  /// not start playing.
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

    // `AudioPlayer.play()` only returns at the end of the audio. Awaiting here
    // would stop callers ordering "start playback, then open the LiveKit mic",
    // so we start it and absorb end-of-playback failures in this layer.
    unawaited(_finishQuietly(_player.play()));
  }

  Future<void> _finishQuietly(Future<void> playback) async {
    try {
      await playback;
    } on Object catch (error) {
      // A decode failure mid-playback never blocks the flow; the caption is
      // the source of truth.
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

/// The single place deciding whether sound plays.
///
/// Like `AppMotion.isReduced`, it stops each widget forming its own opinion.
/// For users the device's mute / silent mode is the setting; there is no second
/// switch in app settings, since two would create the unreadable "on in the app
/// but silent on the device" state — and the spoken content always remains in
/// the caption anyway.
///
/// It is a Provider so widget tests can force false, and so a future per-app OS
/// audio setting can be swapped in without touching screens.
final Provider<bool> decorativeAudioEnabledProvider = Provider<bool>(
  (Ref ref) => true,
);

/// Replaced with the real player from `main.dart` on device only; a guard so
/// tests never start it.
final Provider<PrerenderedAudioPlayer> prerenderedAudioPlayerProvider =
    Provider<PrerenderedAudioPlayer>(
      (Ref ref) => const SilentPrerenderedAudioPlayer(),
    );

/// Thin playback service keeping cue conflicts and failures out of screens.
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

  /// A new cue replaces the current one. The return value is a token that stops
  /// only that call.
  ///
  /// Screens never get a global `stop()`: if screen A disposes late while screen
  /// B has started another cue, A's stop must not silence B.
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
      // A missing asset, decode failure or native failure never breaks the UI.
      debugPrint('プリレンダ音声を再生できませんでした(画面は続けます): $error');
      return null;
    }

    // Another cue or a stop arrived mid-load; do not hand a stop token back.
    return _currentPlaybackId == playbackId ? playbackId : null;
  }

  /// Stops only when [playbackId] matches the sound currently playing.
  Future<void> stop(int? playbackId) async {
    if (playbackId == null || _currentPlaybackId != playbackId) return;
    _currentPlaybackId = null;
    try {
      await _player.stop();
    } on Object catch (error) {
      // A failed stop never delays navigation; the next play bumps the
      // generation anyway.
      debugPrint('プリレンダ音声を停止できませんでした(画面は続けます): $error');
    }
  }
}
