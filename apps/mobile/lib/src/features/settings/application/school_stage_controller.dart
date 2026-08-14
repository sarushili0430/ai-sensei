import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../api/device_id.dart';

part 'school_stage_controller.g.dart';

/// School stage, sent at session creation to halve the search space when
/// matching a photo to a topic.
///
/// Without it, a junior-high photo also lists senior-high math topics. The
/// server defaults to senior high, so older clients keep working.
///
/// Device-local only: rather than add a server DB column, a reinstall means
/// picking again (ADR 0007). We hold the stage, not the school year, because
/// we decided not to filter topics by year — junior-high English is assigned
/// differently by each textbook.
enum SchoolStage {
  juniorHigh('junior_high'),
  highSchool('high_school');

  const SchoolStage(this.wireValue);

  /// Same values as `schoolStages` in `packages/contract`.
  final String wireValue;

  static SchoolStage fromWire(String? value) => SchoolStage.values.firstWhere(
        (SchoolStage stage) => stage.wireValue == value,
        // Unknown or unset means senior high, matching the contract default.
        orElse: () => SchoolStage.highSchool,
      );
}

const String _schoolStageKey = 'ai_sensei.school_stage';

@Riverpod(keepAlive: true)
class SchoolStageController extends _$SchoolStageController {
  @override
  SchoolStage build() {
    final SharedPreferences prefs = ref.watch(preferencesProvider);
    return SchoolStage.fromWire(prefs.getString(_schoolStageKey));
  }

  Future<void> select(SchoolStage stage) async {
    if (state == stage) return;
    state = stage;
    await ref.read(preferencesProvider).setString(_schoolStageKey, stage.wireValue);
  }
}
