import '../domain/karte.dart';

/// Picks exactly one past open gap to ask about after a lesson.
///
/// It does not offer every gap sharing a `topic_id`: one topic holds separate
/// stumbles, and following a lesson about "why use the discriminant" with "the
/// sign in the quadratic formula" turns self-reporting into the app clearing a
/// topic wholesale.
///
/// Candidates are narrowed in order:
///
/// 1. open gaps created before this lesson whose `topic_id` matches
/// 2. concrete-word anchors shared between this karte's "said well" and the
///    gap's description
/// 3. the single gap with the most overlap; ties go to the more recent one
///
/// This is not grading comprehension. It uses no AI and no accuracy — just a
/// deterministic string match to choose what to ask, and it never fills a gap.
/// When paraphrasing leaves no anchor it offers nothing: missing a question
/// beats nagging about an unrelated gap.
ReviewQueueItem? selectLessonHoleCandidate({
  required Karte karte,
  required ReviewQueue queue,
}) {
  if (karte.saidWell.isEmpty || queue.items.isEmpty) return null;

  final Set<String> currentHoleIds = karte.holes
      .map((Hole hole) => hole.id)
      .toSet();
  final Set<String> lessonTopics = karte.topicIds.toSet();
  final Set<String> saidAnchors = karte.saidWell
      .expand(_conceptAnchors)
      .toSet();
  if (saidAnchors.isEmpty) return null;

  final List<({ReviewQueueItem item, int sharedAnchors})> candidates =
      <({ReviewQueueItem item, int sharedAnchors})>[];

  for (final ReviewQueueItem item in queue.items) {
    final Hole hole = item.hole;
    if (hole.status != HoleStatus.open ||
        currentHoleIds.contains(hole.id) ||
        !hole.createdAt.isBefore(karte.createdAt) ||
        !lessonTopics.contains(hole.topicId)) {
      continue;
    }

    final int sharedAnchors = _conceptAnchors(
      hole.description,
    ).intersection(saidAnchors).length;
    if (sharedAnchors > 0) {
      candidates.add((item: item, sharedAnchors: sharedAnchors));
    }
  }

  candidates.sort((a, b) {
    final int byAnchor = b.sharedAnchors.compareTo(a.sharedAnchors);
    if (byAnchor != 0) return byAnchor;
    final int byRecency = b.item.hole.createdAt.compareTo(
      a.item.hole.createdAt,
    );
    if (byRecency != 0) return byRecency;
    return a.item.hole.id.compareTo(b.item.hole.id);
  });
  return candidates.firstOrNull?.item;
}

/// Japanese has no word spacing, so anchors are 3-character runs; English uses
/// meaningful words. Boilerplate English words are dropped so overlap on
/// "explain" or "stopped" alone is not mistaken for relevance.
Set<String> _conceptAnchors(String text) {
  final String lower = text.toLowerCase();
  final Set<String> anchors = <String>{};

  for (final RegExpMatch match in RegExp(r'[a-z0-9]+').allMatches(lower)) {
    final String word = match.group(0)!;
    if (word.length >= 4 && !_englishBoilerplate.contains(word)) {
      anchors.add(word);
    }
  }

  final List<int> japanese = lower.runes
      .where(_isJapaneseLetter)
      .toList(growable: false);
  for (int index = 0; index + 3 <= japanese.length; index += 1) {
    anchors.add(String.fromCharCodes(japanese.sublist(index, index + 3)));
  }
  return anchors;
}

bool _isJapaneseLetter(int rune) =>
    (rune >= 0x3040 && rune <= 0x30ff) ||
    (rune >= 0x3400 && rune <= 0x4dbf) ||
    (rune >= 0x4e00 && rune <= 0x9fff);

const Set<String> _englishBoilerplate = <String>{
  'about',
  'because',
  'could',
  'explain',
  'explained',
  'explanation',
  'stopped',
  'that',
  'this',
  'used',
  'using',
  'what',
  'when',
  'where',
  'with',
  'would',
};
