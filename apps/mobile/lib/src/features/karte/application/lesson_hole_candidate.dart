import '../domain/karte.dart';

/// 授業後に本人へ聞き直す、過去の open な穴を1件だけ選ぶ。
///
/// **`topic_id` が同じものを全部は出さない。** 1つの単元には別々のつまずきがあり、
/// 「判別式を使う理由」を話した授業のあとに「解の公式の符号」まで並べると、
/// 本人の自己申告ではなく、アプリが単元ごと一括で埋めさせる画面になる。
///
/// 選ぶ条件は次の順で狭める。
///
/// 1. 今回より前にできた open な穴で、今回の `topic_id` と一致する
/// 2. 今回のカルテの「言えたこと」と、穴の説明に具体語のアンカーが重なる
/// 3. 重なりが最も多い1件だけ。同数なら最近の穴を選ぶ
///
/// **これは理解の採点ではない。** AIも正答率も使わず、聞く候補を決めるだけの
/// 決定的な文字列照合で、穴を埋める操作は一切しない。言い換えでアンカーが
/// 取れないときは出さない。関係ない穴を催促するより、聞き漏らすほうを選ぶ。
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

/// 日本語は語間に空白が無いので3文字の並び、英語は意味のある単語をアンカーにする。
/// 「説明」「止まった」だけが重なって関係ありと誤認しないよう、英語の定型語は落とす。
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
