import '../../../audio/prerendered_audio.dart';

/// 授業冒頭の一言の寿命だけを持つ。
///
/// LiveKit の接続や板書の検証は `SessionController` の責務だが、再生開始の途中に
/// 板書・発話が先着する競合まで同じクラスへ直書きすると、実機の Room 無しでは
/// 試せなくなる。ここは「いつ鳴らし、何が来たら止めるか」だけにして fake 再生器で
/// 固定する。
class LessonOpeningAudio {
  LessonOpeningAudio(this._audio);

  final PrerenderedAudio _audio;

  bool _waiting = false;
  String? _languageCode;
  int _generation = 0;
  int? _playbackId;

  /// 接続を始める前に待機状態へ入れる。
  ///
  /// `Room.connect()` の途中で先輩が先に喋ることがある。接続後に初めて待機状態を
  /// 作ると、その停止信号を取りこぼしてから cue を鳴らし、先輩の声へかぶせてしまう。
  void arm({required bool lessonMode, required String languageCode}) {
    _generation += 1;
    _waiting = lessonMode;
    _languageCode = lessonMode ? languageCode : null;
    _playbackId = null;
  }

  /// LiveKit 接続後・マイク公開前に鳴らし始める。
  ///
  /// 接続後なら agent の板書生成と同時に走り、マイク公開前なら iOS の ambient audio
  /// session を準備しても LiveKit が直後に会話用へ戻せる。順序を逆にすると、
  /// 消音スイッチを尊重するための設定が録音用 session を上書きしうる。
  Future<void> start() async {
    final String? languageCode = _languageCode;
    if (!_waiting || languageCode == null) return;

    final int generation = _generation;
    final int? playbackId = await _audio.play(
      PrerenderedAudioCue.lessonOpening,
      languageCode: languageCode,
    );

    // アセットを読み込んでいるあいだに、板書か先輩の声が先着した。
    // 読み込み完了後に再生を復活させない。
    if (!_waiting || generation != _generation) {
      await _audio.stop(playbackId);
      return;
    }
    _playbackId = playbackId;
  }

  /// `board_open`(見出しだけ)では止めず、最初の手順が届いたときだけ止める。
  Future<void> firstBoardStepArrived() => _finishWaiting();

  /// 板書より先に本物の先輩が喋り始めた場合も、同じ cue を止める。
  Future<void> senpaiStartedSpeaking() => _finishWaiting();

  /// 接続失敗・画面離脱でも、読み込み中を含めて再生を無効にする。
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
