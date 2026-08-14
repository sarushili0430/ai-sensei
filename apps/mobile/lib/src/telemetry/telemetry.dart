import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// Crash and degradation monitoring.
///
/// All three layers were previously open: no `Sentry.` call in the Dart code,
/// an empty `SENTRY_DSN`, and `codemagic.yaml` never passing it through
/// `--dart-define`. A dependency that is present but inert is worse than none —
/// dSYMs were archived "for Sentry symbolication" with nowhere to send them.
///
/// ## Crashes and degradations stay on separate shelves
///
/// What we want to see is degradation: not crashed, but a promise broken. It
/// previously reached only `debugPrint`, so production had zero visibility:
///
///   - board truncated ([Degradation.boardGap]) — the only way to spot the
///     agent failing to send
///   - LaTeX below the minimum scale, scrolling horizontally
///     ([Degradation.latexScaleFloor]) — the agent is not splitting formulas
///   - board width below the measured 340pt premise
///     ([Degradation.boardTooNarrow])
///
/// Hence `captureMessage(level: warning)`, not `captureException`: mixing these
/// into the crash shelf buries real crashes.
///
/// ## Never sent — the users are minors
///
/// No notebook or problem photos, student speech, transcripts, karte bodies or
/// problem text. Problem text is someone else's work we decided not to store
/// even in R2, so leaking it to monitoring would void that decision. Only `tex`
/// goes out, truncated to [texPrefixLength] chars.
///
/// Stripping is two-stage: [scrubEvent] and the [SentryOptions] settings.
abstract final class SentryConfig {
  /// No default: a value here would send test and CI events to production.
  ///
  /// How it is passed:
  ///   - local … `dart_defines/local.json` (see `local.example.json`)
  ///   - CI    … `--dart-define=SENTRY_DSN=...` in `codemagic.yaml`
  ///             (variable group `mobile-dart-defines`)
  static const String dsn = String.fromEnvironment('SENTRY_DSN');

  /// Builds without a DSN (local, tests, a forgotten value) do nothing at all:
  /// init is skipped entirely, so monitoring never changes app behaviour.
  static bool get isConfigured => dsn.isNotEmpty;
}

/// Not crashed, but a promise broken.
enum Degradation {
  /// Board truncated (missing envelope, out-of-order seq, unparseable JSON).
  boardGap('board_gap'),

  /// LaTeX fell below `BoardStyle.latexMinScale` into horizontal scrolling.
  /// This should never happen; it means the agent did not split the formula.
  latexScaleFloor('latex_scale_floor'),

  /// The width available to the board fell below the measured 340pt premise.
  /// Scale decisions use that width, so a narrower one pushes formulas that
  /// should fit into horizontal scrolling.
  boardTooNarrow('board_too_narrow'),

  /// "I can't explain it" was tapped but never reached senpai.
  ///
  /// The promise that passing is not shameful only holds because a pass is
  /// recorded. Undelivered, it becomes no gap at all — just "I couldn't say it
  /// and nothing happened" — and the screen carries on as if fine, so neither
  /// the student nor we can see it.
  passNotSent('pass_not_sent');

  const Degradation(this.id);

  /// The Sentry title. Kept in English, for search and grouping.
  final String id;
}

/// How much `tex` may be sent: enough to tell formulas apart, never the whole.
const int texPrefixLength = 40;

/// Throttling so the same thing is not reported over and over.
///
/// A single lesson streams dozens of steps. Reporting each would flood one
/// session, blur "happened once" against "happening constantly", and eat the
/// free event quota. One report per board is enough to identify which board.
class DegradationThrottle {
  DegradationThrottle({this.limit = 64});

  /// Cap on remembered keys.
  ///
  /// Remembering without bound would make this the one thing that grows during
  /// long use. On reaching the cap everything is forgotten, so each key sends
  /// once more. Over-reporting beats going silent for long-running users, so it
  /// errs towards forgetting.
  final int limit;

  final Set<String> _seen = <String>{};

  bool allow(String key) {
    if (_seen.contains(key)) return false;
    if (_seen.length >= limit) _seen.clear();
    _seen.add(key);
    return true;
  }

  void reset() => _seen.clear();
}

/// The last gate before sending, stripping any content that slipped in.
///
/// It is needed because the SDK adds things we never attached:
///
///   - `enablePrintBreadcrumbs` defaults to true, turning `debugPrint` output
///     into breadcrumbs. Ours carries full `tex` and karte fetch failures, so
///     the default would leak content. It is disabled in the options too; this
///     drops them all again.
///   - `request` carries the API URL. No body, but monitoring does not need it.
///
/// Returning no [SentryEvent] would stop the send entirely, so only the
/// contents are cleared.
SentryEvent? scrubEvent(SentryEvent event, Hint hint) {
  // `copyWith` is deprecated in favour of direct assignment, and clearing
  // `request` needs a null assignment anyway.
  event.breadcrumbs = const <Breadcrumb>[];
  event.request = null;
  return event;
}

/// Trims `tex` to a sendable form; called inside
/// [DegradationEvent.latexScaleFloor].
String truncateTex(String tex) =>
    tex.length <= texPrefixLength ? tex : '${tex.substring(0, texPrefixLength)}…';

/// Maximum length allowed for any string in a payload.
///
/// A ceiling ensuring no single field can hold a whole utterance or karte.
/// Strings reaching here should only be IDs, type names and diagnostics, so 200
/// is plenty — and if free text ever slips in, this caps what escapes.
const int maxFieldLength = 200;

/// The contents of one degradation report.
///
/// The constructor is private and only the named factories can build one.
/// [Telemetry.report] therefore takes no raw Map, keeping the judgement of what
/// may go into a payload inside this file. Adding a fifth kind means adding a
/// factory here, where the rules (see [SentryConfig]) are in view.
///
/// ## Only three kinds of string are allowed
///
///   1. IDs (`session_id`, `board_id`)
///   2. type and enum names (`error`'s `runtimeType`, `phase`)
///   3. diagnostics we assembled ourselves (contract violations — numbers and
///      IDs only)
///
/// `tex` is the single exception: it is a formula, so it may be sent, but still
/// truncated to [texPrefixLength]. Truncation happens in here, so a caller
/// passing the whole string leaks nothing.
///
/// There is no factory taking student speech, transcripts, karte bodies or
/// problem text. Do not add one — problem text is what we decided not to store
/// even in R2.
@immutable
class DegradationEvent {
  const DegradationEvent._(this.kind, {required this.dedupeKey, required this.data});

  final Degradation kind;

  /// The unit of "same event"; board-related ones use `board_id`, one per board.
  final String dedupeKey;

  final Map<String, Object?> data;

  /// The board was truncated.
  ///
  /// [reason] comes from `BoardContractViolation` and mentions only seq and
  /// index — no student speech, no problem text — but is still capped at
  /// [maxFieldLength].
  factory DegradationEvent.boardGap({
    required String sessionId,
    required String? boardId,
    required String reason,
    required int stepsSoFar,
  }) {
    return DegradationEvent._(
      Degradation.boardGap,
      // If it broke too early to have a board ID, fall back to the session.
      dedupeKey: boardId ?? sessionId,
      data: _sanitize(<String, Object?>{
        'session_id': sessionId,
        'board_id': boardId,
        'reason': reason,
        'steps_so_far': stepsSoFar,
      }),
    );
  }

  /// LaTeX fell below the minimum scale into horizontal scrolling.
  ///
  /// [tex] may be passed in full; it is truncated here.
  factory DegradationEvent.latexScaleFloor({
    required String tex,
    required double scale,
    required double minScale,
    required double availableWidth,
    required double naturalWidth,
  }) {
    final String prefix = truncateTex(tex);
    return DegradationEvent._(
      Degradation.latexScaleFloor,
      // This layer does not know `board_id`, so it dedupes per formula: one
      // report however often the same formula is redrawn, and separate ones for
      // different formulas.
      dedupeKey: prefix,
      data: _sanitize(<String, Object?>{
        'tex': prefix,
        'scale': double.parse(scale.toStringAsFixed(3)),
        'min_scale': minScale,
        'available_width': availableWidth.round(),
        'natural_width': naturalWidth.round(),
      }),
    );
  }

  /// The board's effective width fell below the measured premise. Numbers only.
  factory DegradationEvent.boardTooNarrow({
    required double availableWidth,
    required double assumedWidth,
  }) {
    return DegradationEvent._(
      Degradation.boardTooNarrow,
      dedupeKey: availableWidth.round().toString(),
      data: _sanitize(<String, Object?>{
        'available_width': availableWidth.round(),
        'assumed_width': assumedWidth,
      }),
    );
  }

  /// "I can't explain it" could not be sent.
  ///
  /// It takes no pass wording — there is no parameter for it. [error] takes only
  /// the type: an exception's `toString()` can carry endpoint URLs or token
  /// fragments, so pass `runtimeType`.
  factory DegradationEvent.passNotSent({
    required String? sessionId,
    required String phase,
    required Type error,
  }) {
    return DegradationEvent._(
      Degradation.passNotSent,
      // One per session. Getting stuck repeatedly in one conversation is
      // normal, and reporting each time would bury the real signal that the
      // send path is broken.
      dedupeKey: sessionId ?? 'unknown',
      data: _sanitize(<String, Object?>{
        'session_id': sessionId,
        'phase': phase,
        'error': error.toString(),
      }),
    );
  }

  /// Caps strings by length. A last safety valve that normally trims nothing.
  static Map<String, Object?> _sanitize(Map<String, Object?> data) {
    return data.map((String key, Object? value) {
      if (value is! String || value.length <= maxFieldLength) {
        return MapEntry<String, Object?>(key, value);
      }
      return MapEntry<String, Object?>(key, '${value.substring(0, maxFieldLength)}…');
    });
  }
}

abstract final class Telemetry {
  static final DegradationThrottle _throttle = DegradationThrottle();

  /// For tests: clears the throttle's memory.
  @visibleForTesting
  static void resetThrottle() => _throttle.reset();

  /// Starts the app with monitoring attached.
  ///
  /// Without a DSN it skips init entirely and starts normally, so monitoring
  /// never changes behaviour — local and CI always take this path.
  static Future<void> runWithMonitoring(FutureOr<void> Function() appRunner) async {
    if (!SentryConfig.isConfigured) {
      await appRunner();
      return;
    }

    await SentryFlutter.init(
      (SentryFlutterOptions options) {
        options.dsn = SentryConfig.dsn;

        // --- Settings that keep content out (the users are minors) ---

        // Sends the screen as is, which would include notebook and problem
        // photos. False by default, but stated explicitly — a changed default
        // would go unnoticed.
        options.attachScreenshot = false;

        // The widget tree, which can carry text content. Experimental in the
        // SDK, but turning it off explicitly beats trusting the default, and a
        // future removal fails the build so we notice.
        // ignore: experimental_member_use
        options.attachViewHierarchy = false;

        // Anything identifying device or user; we run on the anonymous ID only.
        options.sendDefaultPii = false;

        // Defaults to true, turning `debugPrint` straight into breadcrumbs —
        // and ours carries full `tex` and failure reasons.
        options.enablePrintBreadcrumbs = false;

        // Also stop native breadcrumbs (tapped element labels and the like).
        options.enableAutoNativeBreadcrumbs = false;

        // The last gate; anything past the above is dropped here.
        options.beforeSend = scrubEvent;

        // Never accumulate breadcrumbs at all — nothing stored, nothing leaked.
        options.beforeBreadcrumb = (Breadcrumb? breadcrumb, Hint hint) => null;

        // No performance tracing; only degradations and crashes.
        options.tracesSampleRate = 0;
      },
      appRunner: () async => appRunner(),
    );
  }

  /// Records one degradation.
  ///
  /// Not `captureException`: nothing crashed, and stacking these on the crash
  /// shelf buries real crashes.
  ///
  /// It takes no raw Map. Spreading the judgement of what may be sent across
  /// callers would mean redoing it for every new kind, and one mistake leaks.
  /// The [DegradationEvent] factories are the only entry point.
  static void report(DegradationEvent event) {
    // Keep local visibility unchanged, with or without monitoring.
    debugPrint('[${event.kind.id}] ${event.data}');

    if (!SentryConfig.isConfigured) return;
    if (!_throttle.allow('${event.kind.id}/${event.dedupeKey}')) return;

    unawaited(
      Sentry.captureMessage(
        event.kind.id,
        level: SentryLevel.warning,
        withScope: (Scope scope) async {
          // As a tag, so Sentry can filter by kind.
          await scope.setTag('degradation', event.kind.id);
          await scope.setContexts(event.kind.id, event.data);
        },
      ),
    );
  }
}
