import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// **課程コードの二重管理を、忘れた側で捕まえる。**
///
/// topic_id の接頭辞は3か所にある:
///
///   1. `packages/curriculum/src/schema.ts` の `trackByCourseCode`(正)
///   2. `packages/contract/src/karte.ts` の `topicIdSchema` の正規表現
///   3. ここ、`strings.dart` の `planSubject()`
///
/// 2 は contract が依存を持たない層である以上ほどけない(README に明記)。
/// 3 は計画画面が `topic_id` しか持たないため必要になる。
///
/// 忘れると `planSubject` が既定の「数学」に落ちる。**画面は壊れず、
/// 英語の単元に「数学」と出るだけ**なので、テストが無いと誰も気づけない。
///
/// カリキュラムのJSONを直接読むのは `contract_fixture_test.dart` と同じ方式。
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
    // 既定はどの課程にも属さない値。ここに落ちているコードが「足し忘れ」。
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

  // 中学は学年、高校は科目。学習指導要領の区切りがそうなっているため、
  // ラベルが非対称になるのは意図どおり(ADR 0006)。
  test('中学の単元は学年、高校の単元は科目名で出る', () {
    const AppStrings ja = AppStrings(Locale('ja'));
    expect(ja.planSubject('J1-KAZUSHIKI-SEIFU'), '中1 数学');
    expect(ja.planSubject('J3-ZUKEI-SANHEIHO'), '中3 数学');
    expect(ja.planSubject('M2-ZUKEI-ENCHOKU'), '数学II');
    expect(ja.planSubject('A2-COORD-CIRCLE'), 'Algebra 2');
  });
}
