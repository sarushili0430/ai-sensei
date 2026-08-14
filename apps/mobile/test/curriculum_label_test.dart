import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Catches the duplicated course-code mapping on whichever side was forgotten.
///
/// The topic_id prefix lives in three places:
///
///   1. `trackByCourseCode` in `packages/curriculum/src/schema.ts` (source of
///      truth)
///   2. the `topicIdSchema` regex in `packages/contract/src/karte.ts`
///   3. here, in `planSubject()` in `strings.dart`
///
/// 2 cannot be untangled while contract is a dependency-free layer (documented
/// in its README). 3 is needed because the plan screen has only the `topic_id`.
///
/// Forgetting one makes `planSubject` fall back to the default "math". The
/// screen does not break — English topics are just labelled maths — so without
/// this test nobody notices.
///
/// Reading the curriculum JSON directly matches `contract_fixture_test.dart`.
void main() {
  final Directory dataDir = Directory('../../packages/curriculum/data');

  List<File> curriculumFiles() =>
      dataDir.listSync().whereType<File>().where((File f) => f.path.endsWith('.json')).toList()
        ..sort((File a, File b) => a.path.compareTo(b.path));

  test('カリキュラムのデータが読める(パスの前提が崩れていない)', () {
    expect(dataDir.existsSync(), isTrue, reason: '${dataDir.path} が見つかりません');
    expect(curriculumFiles(), isNotEmpty);
  });

  test('すべての課程コードで、計画画面の科目名が既定に落ちない', () {
    // The default belongs to no curriculum; a code landing here was forgotten.
    const AppStrings ja = AppStrings(Locale('ja'));
    const AppStrings en = AppStrings(Locale('en'));
    final String jaFallback = ja.planSubject('XX-UNKNOWN');
    final String enFallback = en.planSubject('XX-UNKNOWN');

    final List<String> missing = <String>[];
    for (final File file in curriculumFiles()) {
      final Map<String, dynamic> data =
          jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      for (final dynamic course in data['courses'] as List<dynamic>) {
        final String code = (course as Map<String, dynamic>)['code'] as String;
        if (ja.planSubject('$code-DUMMY') == jaFallback ||
            en.planSubject('$code-DUMMY') == enFallback) {
          missing.add('$code (${course['name']})');
        }
      }
    }

    expect(
      missing,
      isEmpty,
      reason: 'strings.dart の planSubject() に分岐がありません: ${missing.join(", ")}',
    );
  });

  // Junior high uses the school year, senior high the subject. The curriculum is
  // divided that way, so the asymmetry is intended (ADR 0007).
  test('中学の単元は学年、高校の単元は科目名で出る', () {
    const AppStrings ja = AppStrings(Locale('ja'));
    expect(ja.planSubject('J1-KAZUSHIKI-SEIFU'), '中1 数学');
    expect(ja.planSubject('J3-ZUKEI-SANHEIHO'), '中3 数学');
    expect(ja.planSubject('M2-ZUKEI-ENCHOKU'), '数学II');
    expect(ja.planSubject('A2-COORD-CIRCLE'), 'Algebra 2');
  });
}
