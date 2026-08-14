import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/api_client.dart';
import '../../../l10n/strings.dart';
import '../../session/domain/session.dart';
import '../../settings/application/school_stage_controller.dart';

part 'capture_controller.g.dart';

/// Capture, optionally add a problem photo, analyze, confirm topic and problem
/// text, then start the conversation.
///
/// The day's single use is spent only on the last step. Up to [analyze] we just
/// create a session and count nothing; starting the conversation
/// ([confirmAndStart] / [startReview]) is where the server reserves the slot and
/// returns a token. Hence the two states:
///
///   - [CaptureState.analysis] … what the photo yielded (topic, problem text);
///     not counted
///   - [CaptureState.session]  … the started conversation (room key); getting
///     this back means the use is spent
///
/// Topic chips can be removed, leaving room to correct what photo analysis got
/// wrong.
///
/// The two photos are held separately because their lifetimes differ (see
/// `sessionPhotoParts` in `api.ts`): notes are the student's own work and are
/// stored in R2, while the problem page is someone else's and is discarded
/// after analysis. The part is the only thing distinguishing them, so keeping
/// them apart here is what makes the discard possible.
@immutable
class CaptureState {
  const CaptureState({
    this.photo,
    this.problemPhoto,
    this.analysis,
    this.session,
    this.reviewHoleId,
    this.excludedTopicIds = const <String>{},
    this.isSubmitting = false,
    this.error,
  });

  /// The notebook photo; required by the server for `kind: new`.
  final File? photo;

  /// Photo of the problem (a textbook or workbook page). Optional.
  ///
  /// One shot often captures both problem and notes, so requiring two would add
  /// friction and nothing else. Without it, the analyzer reads the problem text
  /// from the notebook photo.
  final File? problemPhoto;

  /// Result of reading the photo. Nothing has been spent up to this point.
  final SessionAnalysis? analysis;

  /// The started conversation, with its room key. Reaching this spends the use.
  final SessionStart? session;

  /// The target gap, when [analysis] belongs to a review session.
  ///
  /// Held so retrying the same gap does not recreate the session
  /// ([startReview]): recreating would spend another slot if the previous
  /// `/start` had in fact reached the server.
  final String? reviewHoleId;

  final Set<String> excludedTopicIds;
  final bool isSubmitting;
  final ApiException? error;

  /// The problem text that was read; null if unreadable.
  SessionProblem? get problem => analysis?.problem;

  List<DetectedTopic> get topics => analysis?.detectedTopics ?? const <DetectedTopic>[];

  List<String> get selectedTopicIds => topics
      .where((DetectedTopic it) => !excludedTopicIds.contains(it.topicId))
      .map((DetectedTopic it) => it.topicId)
      .toList(growable: false);

  bool isSelected(String topicId) => !excludedTopicIds.contains(topicId);

  /// No conversation starts with nothing selected — the allow list would be
  /// empty.
  bool get canStart => selectedTopicIds.isNotEmpty && !isSubmitting;

  /// Whether analysis can run. Either photo alone is enough.
  ///
  /// Notes are no longer required: while they were, a student stuck before
  /// writing anything had to put the problem page in the notes part, breaking
  /// the discard-after-analysis promise through our own UI constraint — the
  /// "known hole" `sessionPhotoParts` in `api.ts` called out. Notes are still
  /// better to have, so how the parts are presented is unchanged.
  bool get hasAnyPhoto => photo != null || problemPhoto != null;

  CaptureState copyWith({
    File? photo,
    File? problemPhoto,
    SessionAnalysis? analysis,
    SessionStart? session,
    String? reviewHoleId,
    Set<String>? excludedTopicIds,
    bool? isSubmitting,
    ApiException? error,
    bool clearError = false,
  }) {
    return CaptureState(
      photo: photo ?? this.photo,
      problemPhoto: problemPhoto ?? this.problemPhoto,
      analysis: analysis ?? this.analysis,
      session: session ?? this.session,
      reviewHoleId: reviewHoleId ?? this.reviewHoleId,
      excludedTopicIds: excludedTopicIds ?? this.excludedTopicIds,
      isSubmitting: isSubmitting ?? this.isSubmitting,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

@Riverpod(keepAlive: true)
class CaptureController extends _$CaptureController {
  @override
  CaptureState build() => const CaptureState();

  /// Sets the notebook photo without clearing the problem photo.
  ///
  /// This used to rebuild the whole state, which silently dropped the second
  /// photo when someone shot the problem first and then retook the notes.
  /// Starting blank is [reset]'s job on entering the screen, not this one's.
  void setPhoto(File photo) {
    if (state.analysis != null) return;
    state = state.copyWith(photo: photo, clearError: true);
  }

  /// Adds the optional problem photo. Only ever called before analysis.
  ///
  /// Adding one afterwards would not be re-read, since analysis has already run;
  /// re-reading means starting over from capture.
  void setProblemPhoto(File photo) {
    if (state.analysis != null) return;
    state = state.copyWith(problemPhoto: photo, clearError: true);
  }

  void toggleTopic(String topicId) {
    final Set<String> excluded = <String>{...state.excludedTopicIds};
    if (!excluded.remove(topicId)) excluded.add(topicId);
    state = state.copyWith(excludedTopicIds: excluded);
  }

  /// Sends the photo to detect topics. No conversation starts, so nothing is
  /// spent.
  ///
  /// Either photo alone suffices ([CaptureState.hasAnyPhoto]). The problem photo
  /// works on its own so a student stuck before writing anything is not told to
  /// photograph notes too.
  Future<void> analyze({String locale = 'ja'}) async {
    if (!state.hasAnyPhoto) return;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      final SessionAnalysis analysis = await ref.read(apiClientProvider).createSession(
            photo: state.photo,
            problemPhoto: state.problemPhoto,
            locale: locale,
            // Halves the topic search space. Review starts from a gap and
            // reads no photo, so it is not passed there.
            schoolStage: ref.read(schoolStageControllerProvider).wireValue,
          );
      state = state.copyWith(
        analysis: analysis,
        isSubmitting: false,
        // Low-confidence candidates start deselected rather than imposed.
        excludedTopicIds: analysis.detectedTopics
            .where((DetectedTopic it) => !it.isConfident)
            .map((DetectedTopic it) => it.topicId)
            .toSet(),
      );
    } on ApiException catch (error) {
      _fail(error);
    } catch (_) {
      // No signal, timeouts, HTML from a proxy. Without catching these,
      // isSubmitting stays set, the spinner hangs and the retake path vanishes.
      _fail(_networkError(locale));
    }
  }

  /// Applies the topic confirmation, then starts the conversation.
  ///
  /// Deselecting a chip alone leaves the server's session on the topics from
  /// analysis, so senpai would teach a topic that was removed. Any change is
  /// pushed first.
  ///
  /// The session must not be recreated here: that would re-run the same photo
  /// through the vision LLM and double-count against the analysis limit.
  ///
  /// This last step is where the day's use is spent, so a limit returns
  /// `free_limit_reached` here and the message can be shown without leaving
  /// capture.
  Future<SessionStart?> confirmAndStart({String locale = 'ja'}) async {
    final SessionAnalysis? current = state.analysis;
    if (current == null) return null;

    state = state.copyWith(isSubmitting: true, clearError: true);
    try {
      if (state.excludedTopicIds.isNotEmpty) {
        final SessionAnalysis narrowed = await ref.read(apiClientProvider).updateSessionTopics(
              sessionId: current.sessionId,
              topicIds: state.selectedTopicIds,
              locale: locale,
            );
        state = state.copyWith(analysis: narrowed, excludedTopicIds: <String>{});
      }

      final SessionStart session = await ref.read(apiClientProvider).startSession(
            sessionId: current.sessionId,
            locale: locale,
          );
      state = state.copyWith(session: session, isSubmitting: false);
      return session;
    } on ApiException catch (error) {
      _fail(error);
      return null;
    } catch (_) {
      _fail(_networkError(locale));
      return null;
    }
  }

  /// Review, driven by push. No photo; it names the gap to fill.
  ///
  /// There is no topic confirmation screen, so create and start are called back
  /// to back. The use is counted at the same point as a new lesson: on start.
  ///
  /// Retrying the same gap never recreates the session. If creation succeeded
  /// and only `/start` failed on a dropped connection, recreating would spend a
  /// second slot when the first start had reached the server; restarting with
  /// the same ID is not double-counted.
  Future<SessionStart?> startReview(String holeId, {String locale = 'ja'}) async {
    final SessionAnalysis? pending =
        state.reviewHoleId == holeId && state.session == null ? state.analysis : null;
    state = CaptureState(isSubmitting: true, analysis: pending, reviewHoleId: holeId);

    try {
      final SessionAnalysis analysis = pending ??
          await ref.read(apiClientProvider).createSession(
                kind: 'review',
                holeId: holeId,
                locale: locale,
              );
      // Stored before starting, so a failure here still lets the next tap
      // restart the same session.
      state = state.copyWith(analysis: analysis);

      final SessionStart session = await ref.read(apiClientProvider).startSession(
            sessionId: analysis.sessionId,
            locale: locale,
          );
      state = state.copyWith(session: session, isSubmitting: false);
      return session;
    } on ApiException catch (error) {
      _fail(error);
      return null;
    } catch (_) {
      _fail(_networkError(locale));
      return null;
    }
  }

  /// Hands a failure to the screen.
  ///
  /// If the session is gone, the held analysis goes with it. A retry past the
  /// time limit gets a 404 (`canReissueToken` in `entitlement.ts`), so keeping
  /// the same ID would just repeat that 404. Dropping it lets the next tap start
  /// over from capture, or from creation for a review.
  void _fail(ApiException error) {
    state = error.isSessionNotFound
        ? CaptureState(photo: state.photo, problemPhoto: state.problemPhoto, error: error)
        : state.copyWith(isSubmitting: false, error: error);
  }

  /// No signal, timeouts, HTML from a proxy. There is no server message, so the
  /// device composes one.
  ApiException _networkError(String locale) => ApiException(
        code: 'internal_error',
        message: AppStrings.forLanguage(locale).errorNetwork,
      );

  void reset() => state = const CaptureState();
}

