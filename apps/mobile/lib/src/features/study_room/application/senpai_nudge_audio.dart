import '../../../audio/prerendered_audio.dart';
import '../domain/senpai_nudge.dart';

/// 自習室の吹き出しの切り替わりを、プリレンダ音声 cue へ変える。
///
/// `SenpaiNudge.forElapsed` は時間の純関数のまま残し、こちらが「前と違うか」を持つ。
/// そうしないと1秒ごとの再描画のたびに同じ音を鳴らすか、画面の State に cue ごとの
/// if 文が散る。初期の [SenpaiNudge.start] は入室直後から見えている文章で、
/// 「たまの声かけ」ではないため音を鳴らさない。
class SenpaiNudgeAudio {
  SenpaiNudgeAudio(this._audio);

  final PrerenderedAudio _audio;

  SenpaiNudge _current = SenpaiNudge.start;
  int _generation = 0;
  int? _playbackId;

  SenpaiNudge get current => _current;

  /// 同じ nudge なら何もしない。切り替わった瞬間だけ対応 cue を1回鳴らす。
  Future<void> moveTo(
    SenpaiNudge next, {
    required String languageCode,
    bool audible = true,
  }) async {
    if (next == _current) return;
    _current = next;

    final PrerenderedAudioCue? cue = switch (next) {
      SenpaiNudge.start => null,
      SenpaiNudge.going => PrerenderedAudioCue.studyRoomGoing,
      SenpaiNudge.takeABreak => PrerenderedAudioCue.studyRoomBreak,
      SenpaiNudge.longHaul => PrerenderedAudioCue.studyRoomLong,
    };

    // 別画面が上に載っているあいだも時刻だけは進めるが、背後から声は出さない。
    if (!audible || cue == null) {
      await stop();
      return;
    }

    final int generation = ++_generation;
    final int? playbackId = await _audio.play(cue, languageCode: languageCode);
    if (generation != _generation) {
      // アセットの読み込み中に画面を離れた。戻り値を待たず dispose されても、
      // 読み込み完了後に背後で声を復活させない。
      await _audio.stop(playbackId);
      return;
    }
    _playbackId = playbackId;
  }

  Future<void> stop() async {
    _generation += 1;
    final int? playbackId = _playbackId;
    _playbackId = null;
    await _audio.stop(playbackId);
  }
}
