import 'package:ai_sensei/src/features/plan/application/plan_controller.dart';
import 'package:ai_sensei/src/features/plan/domain/study_plan.dart';
import 'package:ai_sensei/src/features/plan/presentation/plan_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

void main() {
  testWidgets('フォームを置かず、声で計画を作り始める', (WidgetTester tester) async {
    final List<String> startedLocales = <String>[];
    await pumpApp(
      tester,
      const PlanScreen(),
      overrides: <Object?>[
        planControllerProvider.overrideWith(
          () => _FakePlanController(
            const PlanState(phase: PlanPhase.ready),
            startedLocales: startedLocales,
          ),
        ),
      ],
    );

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(PlanScreen)),
    );
    expect(find.byType(EditableText), findsNothing, reason: '計画はフォーム入力に戻さない');

    await tester.tap(find.text(strings.planCreate));
    await tester.pump();

    expect(startedLocales, <String>['ja']);
  });

  testWidgets('日付・科目・分数と、口頭で組み直す入口を表示する', (WidgetTester tester) async {
    final List<String> startedLocales = <String>[];
    await pumpApp(
      tester,
      const PlanScreen(),
      overrides: <Object?>[
        planControllerProvider.overrideWith(
          () => _FakePlanController(
            const PlanState(phase: PlanPhase.ready, plan: _samplePlan),
            startedLocales: startedLocales,
          ),
        ),
      ],
    );

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(PlanScreen)),
    );
    expect(find.text('2学期の中間'), findsOneWidget);
    expect(find.text('数学II'), findsOneWidget);
    expect(find.textContaining('40分'), findsOneWidget);
    expect(find.text(strings.planRestDay), findsOneWidget);
    expect(
      find.text(strings.planRevisionNote('風邪ひいて3日できなかった')),
      findsOneWidget,
    );

    // Completed items are shown as facts, never turned into rates or scores.
    final Iterable<String> visibleText = tester
        .widgetList<Text>(find.byType(Text))
        .map((Text text) => text.data ?? '')
        .where((String text) => text.isNotEmpty);
    expect(visibleText.any((String text) => text.contains('%')), isFalse);
    expect(visibleText.any((String text) => text.contains('達成率')), isFalse);
    expect(visibleText.any((String text) => text.contains('点')), isFalse);

    await tester.tap(find.text(strings.planRebuild));
    await tester.pump();
    expect(startedLocales, <String>['ja']);
  });

  testWidgets('英語でも同じ音声導線を使う', (WidgetTester tester) async {
    final List<String> startedLocales = <String>[];
    await pumpApp(
      tester,
      const PlanScreen(),
      locale: const Locale('en'),
      overrides: <Object?>[
        planControllerProvider.overrideWith(
          () => _FakePlanController(
            const PlanState(phase: PlanPhase.ready),
            startedLocales: startedLocales,
          ),
        ),
      ],
    );

    final AppStrings strings = AppStrings.of(
      tester.element(find.byType(PlanScreen)),
    );
    await tester.tap(find.text(strings.planCreate));
    await tester.pump();

    expect(startedLocales, <String>['en']);
  });
}

class _FakePlanController extends PlanController {
  _FakePlanController(this._initial, {required this.startedLocales});

  final PlanState _initial;
  final List<String> startedLocales;

  @override
  PlanState build() => _initial;

  @override
  Future<void> load() async {}

  @override
  Future<void> start(String locale) async {
    startedLocales.add(locale);
  }
}

const StudyPlan _samplePlan = StudyPlan(
  id: 'pln_test',
  createdAt: '2026-08-24T12:05:31.000Z',
  source: PlanSource.senpai,
  intake: PlanIntake(
    examName: '2学期の中間',
    examDate: '2026-09-10',
    scope: PlanScope(topicIds: <String>['M2-SANKAKU-KAHO'], said: '数IIの三角関数'),
    materials: <String>['4STEP'],
  ),
  days: <PlanDay>[
    PlanDay(
      date: '2026-09-06',
      items: <PlanItem>[
        PlanItem(
          topicId: 'M2-SANKAKU-KAHO',
          what: '加法定理の例題を一周',
          material: 0,
          minutes: 40,
          status: PlanItemStatus.todo,
        ),
      ],
    ),
    PlanDay(date: '2026-09-07', items: <PlanItem>[]),
  ],
  revisions: <PlanRevision>[
    PlanRevision(
      at: '2026-09-05T20:14:02.000Z',
      reason: PlanRevisionReason.behind,
      said: '風邪ひいて3日できなかった',
    ),
  ],
);
