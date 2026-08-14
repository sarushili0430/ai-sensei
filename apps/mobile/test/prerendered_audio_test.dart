import 'dart:async';

import 'package:ai_sensei/src/audio/prerendered_audio.dart';
import 'package:ai_sensei/src/features/session/application/lesson_opening_audio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('プリレンダ音声の列挙', () {
    test('すべての cue が日英の台本と同梱アセットを持つ', () {
      for (final PrerenderedAudioCue cue in PrerenderedAudioCue.values) {
        expect(cue.jaTranscript, isNotEmpty);
        expect(cue.enTranscript, isNotEmpty);
        expect(cue.assetFor('ja'), endsWith('.ja.m4a'));
        expect(cue.assetFor('en'), endsWith('.en.m4a'));
        expect(cue.assetFor('ja'), isNot(cue.assetFor('en')));
      }
    });

    test('未知の言語はUIと同じく英語へ倒す', () {
      expect(
        PrerenderedAudioCue.lessonOpening.assetFor('fr'),
        PrerenderedAudioCue.lessonOpening.enAsset,
      );
    });
  });

  group('再生サービス', () {
    test('音を切る設定では再生器まで到達しない', () async {
      final _RecordingPlayer player = _RecordingPlayer();
      final PrerenderedAudio audio = PrerenderedAudio(
        player: player,
        isEnabled: () => false,
      );

      expect(
        await audio.play(
          PrerenderedAudioCue.lessonOpening,
          languageCode: 'ja',
        ),
        isNull,
      );
      expect(player.plays, isEmpty);
    });

    test('アセットの再生に失敗しても呼び出し側へ投げない', () async {
      final _RecordingPlayer player = _RecordingPlayer(failPlay: true);
      final PrerenderedAudio audio = PrerenderedAudio(
        player: player,
        isEnabled: () => true,
      );

      expect(
        await audio.play(
          PrerenderedAudioCue.lessonOpening,
          languageCode: 'ja',
        ),
        isNull,
      );
      expect(player.plays, <_Play>[
        const _Play(PrerenderedAudioCue.lessonOpening, 'ja'),
      ]);
    });

    test('古い画面の停止札では、新しい画面の音を止めない', () async {
      final _RecordingPlayer player = _RecordingPlayer();
      final PrerenderedAudio audio = PrerenderedAudio(
        player: player,
        isEnabled: () => true,
      );
      final int? old = await audio.play(
        PrerenderedAudioCue.lessonOpening,
        languageCode: 'ja',
      );
      final int? current = await audio.play(
        PrerenderedAudioCue.lessonOpening,
        languageCode: 'en',
      );

      await audio.stop(old);
      expect(player.stopCount, 0);
      await audio.stop(current);
      expect(player.stopCount, 1);
    });
  });

  group('授業冒頭(計画書§3-2)', () {
    test('復習では鳴らさず、新しい授業だけ接続後に鳴らす', () async {
      final _RecordingPlayer player = _RecordingPlayer();
      final LessonOpeningAudio opening = LessonOpeningAudio(_audio(player));

      opening.arm(lessonMode: false, languageCode: 'ja');
      await opening.start();
      expect(player.plays, isEmpty);

      opening.arm(lessonMode: true, languageCode: 'en');
      await opening.start();
      expect(player.plays, <_Play>[
        const _Play(PrerenderedAudioCue.lessonOpening, 'en'),
      ]);
    });

    test('見出しだけでは止めず、最初の板書手順で止める', () async {
      final _RecordingPlayer player = _RecordingPlayer();
      final LessonOpeningAudio opening = LessonOpeningAudio(_audio(player));
      opening.arm(lessonMode: true, languageCode: 'ja');
      await opening.start();

      // `board_open` is only a heading; firstBoardStepArrived is not called yet.
      expect(player.stopCount, 0);
      await opening.firstBoardStepArrived();
      expect(player.stopCount, 1);
    });

    test('板書より先に先輩が喋り始めたら止める', () async {
      final _RecordingPlayer player = _RecordingPlayer();
      final LessonOpeningAudio opening = LessonOpeningAudio(_audio(player));
      opening.arm(lessonMode: true, languageCode: 'ja');
      await opening.start();

      await opening.senpaiStartedSpeaking();
      expect(player.stopCount, 1);
    });

    test('読み込み中に先輩が喋っても、完了後に音を復活させない', () async {
      final Completer<void> gate = Completer<void>();
      final _RecordingPlayer player = _RecordingPlayer(playGate: gate);
      final LessonOpeningAudio opening = LessonOpeningAudio(_audio(player));
      opening.arm(lessonMode: true, languageCode: 'ja');

      final Future<void> starting = opening.start();
      await Future<void>.delayed(Duration.zero);
      expect(player.plays, hasLength(1));
      await opening.senpaiStartedSpeaking();
      gate.complete();
      await starting;

      // The stop token returned once loading finished is used to stop again.
      expect(player.stopCount, 1);
    });
  });
}

PrerenderedAudio _audio(_RecordingPlayer player) =>
    PrerenderedAudio(player: player, isEnabled: () => true);

class _RecordingPlayer implements PrerenderedAudioPlayer {
  _RecordingPlayer({this.failPlay = false, this.playGate});

  final bool failPlay;
  final Completer<void>? playGate;
  final List<_Play> plays = <_Play>[];
  int stopCount = 0;

  @override
  Future<void> play(
    PrerenderedAudioCue cue, {
    required String languageCode,
  }) async {
    plays.add(_Play(cue, languageCode));
    if (failPlay) throw StateError('fixture: asset missing');
    await playGate?.future;
  }

  @override
  Future<void> stop() async {
    stopCount += 1;
  }

  @override
  Future<void> dispose() async {}
}

class _Play {
  const _Play(this.cue, this.languageCode);

  final PrerenderedAudioCue cue;
  final String languageCode;

  @override
  bool operator ==(Object other) =>
      other is _Play && other.cue == cue && other.languageCode == languageCode;

  @override
  int get hashCode => Object.hash(cue, languageCode);

  @override
  String toString() => '${cue.name}:$languageCode';
}
