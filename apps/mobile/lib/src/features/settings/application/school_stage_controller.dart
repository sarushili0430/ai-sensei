import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../api/device_id.dart';

part 'school_stage_controller.g.dart';

/// 学校段階。**写真から単元を探す範囲を半分に切るために、セッション作成時に送る。**
///
/// これを送らないと、中学生の写真にも数学I〜Cが候補として並ぶ。
/// サーバ側の既定は「高校生」で、送らない古いアプリはこれまでどおり動く。
///
/// **端末にしか持たない。** サーバのDBに列を足さない代わりに、再インストールで
/// 選び直しになる(ADR 0007)。学年そのものではなく段階だけを持つのは、
/// 学年で単元を絞らないと決めたため — 中学英語の学年配当は教科書ごとに違う。
enum SchoolStage {
  juniorHigh('junior_high'),
  highSchool('high_school');

  const SchoolStage(this.wireValue);

  /// `packages/contract` の `schoolStages` と同じ値。
  final String wireValue;

  static SchoolStage fromWire(String? value) => SchoolStage.values.firstWhere(
        (SchoolStage stage) => stage.wireValue == value,
        // 未知の値・未設定は高校生。契約側の既定と揃えてある。
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
