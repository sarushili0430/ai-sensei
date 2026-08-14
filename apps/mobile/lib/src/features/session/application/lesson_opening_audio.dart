import '../../../audio/prerendered_audio.dart';

/// Owns only the lifetime of the lesson's opening line.
///
/// LiveKit connection and board validation belong to `SessionController`, but
/// writing the race where a board step or utterance beats playback into that
/// class too would make it untestable without a real Room. This holds just when
/// to play and what stops it, pinned by a fake player.
class LessonOpeningAudio {
  LessonOpeningAudio(this._audio);

  final PrerenderedAudio _audio;

  bool _waiting = false;
  String? _languageCode;
  int _generation = 0;
  int? _playbackId;

  /// Enters the waiting state before connecting.
  ///
  /// Senpai can start speaking during `Room.connect()`. Creating the waiting
  /// state only after connecting would miss that stop signal and then play the
  /// cue over senpai's voice.
  void arm({required bool lessonMode, required String languageCode}) {
    _generation += 1;
    _waiting = lessonMode;
    _languageCode = lessonMode ? languageCode : null;
    _playbackId = null;
  }

  /// Starts playback after connecting to LiveKit and before publishing the mic.
  ///
  /// After connecting, it runs alongside the agent generating the board; before
  /// publishing, preparing iOS's ambient audio session still lets LiveKit switch
  /// back to the conversation session straight after. Reversed, the setting that
  /// respects the mute switch could overwrite the recording session.
  Future<void> start() async {
    final String? languageCode = _languageCode;
    if (!_waiting || languageCode == null) return;

    final int generation = _generation;
    final int? playbackId = await _audio.play(
      PrerenderedAudioCue.lessonOpening,
      languageCode: languageCode,
    );

    // A board step or senpai's voice arrived while the asset was loading; do
    // not revive playback once loading finishes.
    if (!_waiting || generation != _generation) {
      await _audio.stop(playbackId);
      return;
    }
    _playbackId = playbackId;
  }

  /// `board_open` (heading only) does not stop it; the first step does.
  Future<void> firstBoardStepArrived() => _finishWaiting();

  /// The real senpai speaking before the board also stops the same cue.
  Future<void> senpaiStartedSpeaking() => _finishWaiting();

  /// A failed connection or leaving the screen also disables playback,
  /// including while loading.
  Future<void> stop() => _finishWaiting();

  Future<void> _finishWaiting() async {
    if (!_waiting && _playbackId == null) return;
    _waiting = false;
    _languageCode = null;
    _generation += 1;
    final int? playbackId = _playbackId;
    _playbackId = null;
    await _audio.stop(playbackId);
  }
}
