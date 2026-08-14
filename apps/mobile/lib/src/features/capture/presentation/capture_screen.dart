import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../session/domain/session.dart';
import '../application/capture_controller.dart';

/// Choose what to photograph, shoot it, review it, then confirm topic and
/// problem text.
///
/// Detected topics appear as chips the user can remove, leaving room to correct
/// what photo analysis got wrong.
///
/// ## Why the camera does not open automatically
///
/// Entering this screen used to open the notes camera immediately. That was zero
/// taps for a student with notes, but a student stuck with nothing written stood
/// at the shutter without ever seeing the problem slot. With only the workbook
/// to hand, shooting there put the page in the notes part — the very motive
/// `sessionPhotoParts` in `api.ts` calls the remaining hole (someone else's work
/// stored in R2, and senpai receiving the page contents instead of "no notes
/// photo").
///
/// There was an escape (cancel and both slots appear), but cancel reads as
/// "give up"; nobody picks it to say "I have no notes".
///
/// So the slots come first and the student chooses which to shoot. That is one
/// extra tap for anyone with notes, but the only place to say "I have no notes"
/// before the shutter. The screen already accepts one stop before analysis, so
/// the stop just moved a step earlier.
///
/// ## Why we stop before analysis
///
/// Shooting used to run straight into analysis; now a review step sits between.
///
///   1. The problem photo can only be added before analysis — adding it later
///      does not re-read the photos (`setProblemPhoto` in
///      `capture_controller.dart`). This is the only place the optional second
///      photo can live
///   2. The shot went to the vision LLM as taken, so blur went unnoticed
///
/// The day's use is not spent here. It is counted when the conversation starts
/// (`startSessionResponseSchema` in `api.ts`), so retaking after analysis costs
/// no lessons.
///
/// Either photo alone can start it. One shot often captures both problem and
/// notes, so requiring two would only add friction. The copy here is a hint that
/// including the problem keeps senpai on track, not an instruction.
class CaptureScreen extends ConsumerStatefulWidget {
  const CaptureScreen({super.key});

  @override
  ConsumerState<CaptureScreen> createState() => _CaptureScreenState();
}

/// image_picker error codes meaning permission was denied.
///
/// iOS throws rather than returning null when permission is missing. Assuming
/// the same "returns null" as a cancelled shot would skip this path entirely.
const Set<String> _kPermissionErrorCodes = <String>{
  'camera_access_denied',
  'photo_access_denied',
  'invalid_source',
};

class _CaptureScreenState extends ConsumerState<CaptureScreen> {
  /// Camera was denied. Show the way back rather than closing.
  bool _cameraDenied = false;

  /// Permission held but the camera would not open (a device-side reason);
  /// offer a retake path.
  bool _cameraFailed = false;

  /// The camera is open and there is nothing to show yet.
  ///
  /// Distinct from "nothing shot yet": someone who came back without shooting
  /// stays here with the slots visible, so photo presence alone cannot decide.
  ///
  /// Starts true. [reset] does not run until the next frame, so starting false
  /// would flash the previous photo for one frame (the controller is keepAlive).
  bool _picking = true;

  /// The slot the camera last opened for, so a retry returns to the same one.
  ///
  /// Since the camera no longer opens automatically, the slot is the student's
  /// own choice; snapping back to notes on every failure would send a student
  /// without notes right back to the slot they cannot fill.
  bool _lastPickWasProblem = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Do not carry the previous shoot over. The controller is keepAlive, so
      // without resetting here the old problem photo leaks into the next lesson.
      ref.read(captureControllerProvider.notifier).reset();
      // Do not open the camera here (see the class comment); show the slots.
      if (mounted) setState(() => _picking = false);
    });
  }

  /// The notes photo. Not required — the server wants either one for `kind: new`.
  Future<void> _pickPhoto() => _pick(forProblem: false);

  /// The problem photo. It can start a session on its own.
  Future<void> _pickProblemPhoto() => _pick(forProblem: true);

  Future<void> _pick({required bool forProblem}) async {
    setState(() {
      _cameraDenied = false;
      _cameraFailed = false;
      _picking = true;
      _lastPickWasProblem = forProblem;
    });

    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(
        source: ImageSource.camera,
        imageQuality: 85,
      );
    } on PlatformException catch (error, stack) {
      // Called from initState's postFrameCallback, so without catching here it
      // becomes an unhandled exception and takes the capture screen down.
      debugPrint('カメラを開けませんでした(${error.code}): ${error.message}\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        if (_kPermissionErrorCodes.contains(error.code)) {
          _cameraDenied = true;
        } else {
          _cameraFailed = true;
        }
      });
      return;
    } on Object catch (error, stack) {
      // Unexpected plugin failures (a bad file read, say). Allow a retake
      // rather than crashing.
      debugPrint('写真を取得できませんでした: $error\n$stack');
      if (!mounted) return;
      setState(() {
        _picking = false;
        _cameraFailed = true;
      });
      return;
    }

    // Came back without shooting. Without permission, show the way to settings —
    // reopening the camera would give the same result, so that case is handled
    // separately. Not per slot: both were opened by choice, so there is no
    // reason to report a missing permission on only one.
    //
    // Otherwise stay on this screen. We used to drop to home, which removed the
    // chance to choose again: someone who started at notes and backed out could
    // never reach the problem slot. Anyone truly leaving can use back (we
    // arrived by push).
    if (picked == null) {
      if (!mounted) return;
      final PermissionStatus status = await _cameraStatus();
      if (!mounted) return;
      setState(() {
        _picking = false;
        _cameraDenied =
            status.isDenied || status.isPermanentlyDenied || status.isRestricted;
      });
      return;
    }

    if (!mounted) return;
    final CaptureController controller = ref.read(captureControllerProvider.notifier);
    if (forProblem) {
      controller.setProblemPhoto(File(picked.path));
    } else {
      // No analysis here (see the class comment).
      controller.setPhoto(File(picked.path));
    }
    setState(() => _picking = false);
  }

  Future<void> _analyze() async {
    final String locale = Localizations.localeOf(context).languageCode;
    await ref.read(captureControllerProvider.notifier).analyze(locale: locale);
  }

  /// Applies deselected topics, then starts the conversation. This is where the
  /// day's use is spent.
  ///
  /// A retry after failure comes back here too (see the error branch in [_body]).
  Future<void> _start() async {
    final String locale = Localizations.localeOf(context).languageCode;
    final SessionStart? session = await ref
        .read(captureControllerProvider.notifier)
        .confirmAndStart(locale: locale);
    if (session != null && mounted) context.go(AppRoute.session.path);
  }

  /// Even the permission query can fail; crashing here would take down someone
  /// who merely cancelled the shot.
  Future<PermissionStatus> _cameraStatus() async {
    try {
      return await Permission.camera.status;
    } on Object catch (error) {
      debugPrint('カメラの許可を確認できませんでした: $error');
      return PermissionStatus.granted; // Do not assume permission; go home.
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final CaptureState state = ref.watch(captureControllerProvider);

    // The heading matches what is being confirmed right now. Asking "is this the
    // right topic?" while they are looking at a photo reads as a topic question
    // before anything has been analyzed.
    //
    // With nothing shot it is not "got it" either: what is being chosen is what
    // to photograph, and that includes answering "I have no notes".
    final String title;
    if (state.analysis != null || state.isSubmitting) {
      title = strings.captureConfirmTitle;
    } else if (state.hasAnyPhoto) {
      title = strings.captureReviewTitle;
    } else {
      title = strings.captureChooseTitle;
    }

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: _body(state),
        ),
      ),
    );
  }

  Widget _body(CaptureState state) {
    final AppStrings strings = AppStrings.of(context);

    if (_cameraDenied) {
      return _ErrorView(
        message: strings.captureCameraDenied,
        retryLabel: strings.captureOpenSettings,
        onRetry: openAppSettings,
      );
    }

    if (_cameraFailed) {
      return _ErrorView(
        message: strings.captureCameraFailed,
        // Return to the slot that failed. Pinning to notes would send a student
        // without notes back to the slot they cannot fill.
        onRetry: () => _pick(forProblem: _lastPickWasProblem),
      );
    }

    final ApiException? error = state.error;
    if (error != null) {
      final bool lessonLimitReached =
          error.isFreeLimitReached || error.isFairUseLimitReached;
      return _ErrorView(
        // Neither tier sees a number; senpai closes out today's study.
        message: lessonLimitReached ? strings.lessonEnoughForToday : error.message,
        // A daily limit does not change on retry, so neither tier retries.
        //
        // Past analysis, retry the conversation start rather than the shot.
        // Pinning this to `_pick` makes [CaptureController.setPhoto] protect the
        // analyzed state and discard the photo, so the camera reopens forever
        // and the error never clears. Worse, a failed start may already hold a
        // server-side slot, and retaking would throw that use away. `/start` is
        // not double-counted for the same ID, so retrying is correct (if the
        // session is gone, `analysis` is dropped too and we fall back to a
        // retake).
        onRetry: lessonLimitReached
            ? null
            : state.analysis != null
                ? _start
                // Retake into the slot last opened, which may not be notes.
                : () => _pick(forProblem: _lastPickWasProblem),
      );
    }
    // Nothing to show while the camera is open. Not decided by photo presence —
    // the slots are shown even with nothing shot.
    if (state.isSubmitting || _picking) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.analysis == null) {
      return _PhotoReview(
        state: state,
        onRetake: _pickPhoto,
        onAddProblem: _pickProblemPhoto,
        onStart: _analyze,
      );
    }
    return _TopicConfirm(state: state, onStart: _start);
  }
}

/// Both the screen for choosing what to shoot and the review of what was shot.
/// It stops exactly once, right before analysis (the vision LLM).
///
/// The two slots are not a visual choice. Notes are stored in R2 and the problem
/// page is discarded after analysis, and the part is the only thing
/// distinguishing them, so showing the slots is what makes the discard possible.
/// That is why this appears before the first photo (see [CaptureScreen]).
///
/// Either photo alone starts a session; only both empty blocks it. While notes
/// were required, a student stuck before writing anything had to put the page in
/// the notes slot, breaking the discard promise through our own UI.
///
/// The notes slot is still not presented as "optional": having notes is better
/// (it gives senpai a starting point), so the heading is unchanged. Nor is their
/// absence called out — for a student without notes that is an uncorrectable
/// complaint.
///
/// ## Hints vary by which slots are filled
///
/// Two people need words here, and they need opposite ones:
///
///   - nothing shot yet … say "notes are not required" first. Silence here
///     pushes a stuck student to put the page in the notes slot, seeing no other
///     way forward
///   - notes only … suggest the problem photo keeps senpai on track
///
/// Showing both at once leaves half of it irrelevant to each. Both appear before
/// shooting, so the rule against turning this into a warning holds (a separate
/// axis from `problemSources` in `api.ts`, which is about post-analysis warnings
/// making the second photo effectively mandatory).
class _PhotoReview extends StatelessWidget {
  const _PhotoReview({
    required this.state,
    required this.onRetake,
    required this.onAddProblem,
    required this.onStart,
  });

  final CaptureState state;
  final VoidCallback onRetake;
  final VoidCallback onAddProblem;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    // Show only the words the empty slots call for (see the class comment).
    final String? hint;
    if (!state.hasAnyPhoto) {
      hint = strings.captureEitherIsFine;
    } else if (state.problemPhoto == null) {
      hint = strings.captureProblemHint;
    } else {
      hint = null;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Expanded(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: _PhotoSlot(
                  label: strings.capturePhotoNotes,
                  photo: state.photo,
                  emptyLabel: strings.captureTakeNotes,
                  onTap: onRetake,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: _PhotoSlot(
                  label: strings.capturePhotoProblem,
                  photo: state.problemPhoto,
                  emptyLabel: strings.captureAddProblem,
                  onTap: onAddProblem,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        // A nudge, not a requirement: the button below works without it.
        if (hint != null) ...<Widget>[
          Text(
            hint,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.xs),
        ],
        Text(
          strings.captureProblemDiscarded,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.md),
        // Disabled only when both are empty, and the reason is not written out:
        // two empty slots are visible and either can be shot on the spot, and
        // the hint above already says one is enough.
        ChunkyButton(
          label: strings.captureStart,
          onPressed: state.hasAnyPhoto ? onStart : null,
        ),
      ],
    );
  }
}

/// One photo slot: shoot when empty, retake when filled.
class _PhotoSlot extends StatelessWidget {
  const _PhotoSlot({
    required this.label,
    required this.photo,
    required this.emptyLabel,
    required this.onTap,
  });

  final String label;
  final File? photo;

  /// Action label before anything is shot; becomes "retake" afterwards.
  final String emptyLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final File? file = photo;
    final String actionLabel = file == null ? emptyLabel : AppStrings.of(context).captureRetake;

    return Semantics(
      button: true,
      label: '$label・$actionLabel',
      child: GestureDetector(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(label, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.xs),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(AppRadius.card),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    border: Border.all(color: AppColors.border),
                    borderRadius: BorderRadius.circular(AppRadius.card),
                  ),
                  child: file == null
                      ? const Center(
                          child: Icon(
                            Icons.add_a_photo_outlined,
                            color: AppColors.inkMuted,
                          ),
                        )
                      // Recognising the shot is enough, so fit it all in.
                      : Image.file(file, fit: BoxFit.cover),
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              actionLabel,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.blue),
            ),
          ],
        ),
      ),
    );
  }
}

class _TopicConfirm extends ConsumerWidget {
  const _TopicConfirm({required this.state, required this.onStart});

  final CaptureState state;

  /// Starts the conversation; a retry after failure returns to the same action.
  final Future<void> Function() onStart;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    final SessionProblem? problem = state.problem;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // Only the reading area scrolls; the start button stays above the fold.
        //
        // Problem text can reach the contract's 600-character limit
        // (`problemTextMaxLength`). Pushing the button down with `Spacer` sent it
        // off screen as soon as the text got long (measured: 557px overflow at
        // 375x667). The limit is part of the spec, not an edge case, so we cannot
        // assume it fits.
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                // Shown only when the text was read; otherwise carry on
                // silently. "Could not read the problem" would make the optional
                // second photo effectively mandatory, since the warning only
                // clears by retaking. The hint before shooting already covers it.
                if (problem != null) ...<Widget>[
                  _ProblemReadback(problem: problem),
                  const SizedBox(height: AppSpacing.lg),
                ],
                Text(strings.captureConfirmHint, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: AppSpacing.md),
                Wrap(
                  spacing: AppSpacing.sm,
                  runSpacing: AppSpacing.sm,
                  children: state.topics
                      .map(
                        (DetectedTopic topic) => _TopicChip(
                          topic: topic,
                          selected: state.isSelected(topic.topicId),
                          onTap: () => ref
                              .read(captureControllerProvider.notifier)
                              .toggleTopic(topic.topicId),
                        ),
                      )
                      .toList(growable: false),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        // Deselected topics are pushed before starting. Skipping that leaves the
        // server's session as analyzed, and senpai teaches a removed topic (see
        // [CaptureController]).
        ChunkyButton(
          label: strings.captureStart,
          onPressed: state.canStart ? onStart : null,
        ),
      ],
    );
  }
}

/// A read-back of the problem text: the misreading checkpoint before a lesson.
///
/// Noticing "that's a different problem" after 15 minutes of teaching is worth
/// nothing like noticing it before starting — the more the app is built on the
/// AI understanding the problem, the more fatal a misreading becomes.
///
/// It does not ask whether it is correct. This is a read-back, not a request for
/// a verdict; if it is wrong, the student says so at the start of the
/// conversation, which is the insurance itself. (Lessons are counted when the
/// conversation begins, so going back to retake costs nothing.)
class _ProblemReadback extends StatelessWidget {
  const _ProblemReadback({required this.problem});

  final SessionProblem problem;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadius.card),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(strings.captureProblemTitle, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: AppSpacing.xs),
          // Even at the contract's 600-character limit, it all shows here.
          // Collapsing it would defeat the point of a read-back.
          Text(problem.text, style: Theme.of(context).textTheme.bodyLarge),
        ],
      ),
    );
  }
}

class _TopicChip extends StatelessWidget {
  const _TopicChip({required this.topic, required this.selected, required this.onTap});

  final DetectedTopic topic;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        // A single chip can exceed the screen width: with a grade label
        // prefixed, longer topic names do not fit 375px. Cap the width and wrap
        // rather than truncating, which would hide which topic it is.
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width - AppSpacing.xl * 2),
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(
          color: selected ? AppColors.blue : AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.chip),
          border: Border.all(color: selected ? AppColors.blue : AppColors.border),
        ),
        // Whether the prefix is a grade or a subject is fixed by the curriculum,
        // and the server supplies it in `label` (ADR 0007).
        child: Text(
          '${topic.label} ${topic.topic}',
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: selected ? Colors.white : AppColors.inkMuted,
              ),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, this.onRetry, this.retryLabel});

  final String message;
  final VoidCallback? onRetry;
  final String? retryLabel;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        // Show the server's wording as is; it is written not to nag.
        Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: AppSpacing.lg),
        if (onRetry != null)
          ChunkyButton(label: retryLabel ?? strings.errorRetry, onPressed: onRetry),
        GhostButton(label: strings.karteDone, onPressed: context.closeOrGoHome),
      ],
    );
  }
}
