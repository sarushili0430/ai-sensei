import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../common_widgets/centered_scroll.dart';
import '../../../common_widgets/entrance.dart';
import '../../../common_widgets/senpai_face.dart';
import '../../../common_widgets/typing_text.dart';
import '../../../l10n/strings.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../settings/application/school_stage_controller.dart';
import 'onboarding_motion.dart';

/// 選択肢を引くための目印(テスト・golden から)。
Key onboardingStageKey(SchoolStage stage) => Key('onboarding_stage_${stage.wireValue}');

/// 学年の枚 — **唯一「聞く」枚**。
///
/// Mobbin の学習アプリ(Brilliant / Uxcel / Skillshare)は、価値を語るより先に
/// **1問だけ本人のことを聞く**。答えたぶんだけ自分向けの道具に見えるからで、
/// ここもその形を借りている。ただし借りるのは形だけで、**答えが何かを変える
/// 質問しか置かない**。
///
/// 段階(中学生 / 高校生)は、写真から単元を探す範囲をそのまま半分にする
/// (`school_stage_controller.dart`)。ここを聞かないと、中学生の写真にも
/// 数学I〜Cが候補として並ぶ。既定は高校生なので、**聞かなければ中学生が損をする。**
///
/// **英語では出さない。**海外課程は Algebra 1 〜 Statistics の一続きで段階を
/// 持たず、`tracksForStage` が `locale == "en"` をどちらの段階でも同じ1本に
/// 落とす。答えが何も変えない質問は、聞いてもらえた感ではなく**聞かれ損**になる
/// (出し分けは枚を組み立てる `onboarding_screen.dart` の側)。
///
/// 選んだ値は親([OnboardingScreen])が持つ。**まだ選んでいない**のと
/// 「既定が入っている」を分けて持つためで、`schoolStageControllerProvider` を
/// そのまま見て印を描くと、触ってもいない選択肢にチェックが付いた状態で
/// 画面が出る。聞いておいて答えを先回りするのは、聞かないより悪い。
class OnboardingStagePage extends ConsumerStatefulWidget {
  const OnboardingStagePage({required this.chosen, required this.onSelected, super.key});

  /// まだ選んでいなければ null。
  final SchoolStage? chosen;

  final ValueChanged<SchoolStage> onSelected;

  @override
  ConsumerState<OnboardingStagePage> createState() => _OnboardingStagePageState();
}

class _OnboardingStagePageState extends ConsumerState<OnboardingStagePage> {
  /// 問いを打ち終わるまで、選択肢は出さない。まだ聞かれていないので。
  bool _asked = false;

  void _select(SchoolStage stage) {
    HapticFeedback.selectionClick();
    // 端末に書くのはここ。書き込みを待たせない(設定画面と同じ扱い)。
    ref.read(schoolStageControllerProvider.notifier).select(stage);
    widget.onSelected(stage);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);

    return CenteredScroll(
      children: <Widget>[
        const SizedBox(height: AppSpacing.md),
        FadeSlideIn(
          child: Text(
            strings.onboardingStageTitle,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        FadeSlideIn.staggered(
          index: 1,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              const SenpaiFace(mood: SenpaiMood.neutral, size: 76),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: SenpaiBubble(
                  child: TypingText(
                    strings.onboardingStageQuestion,
                    style: Theme.of(context).textTheme.bodyLarge,
                    onDone: () {
                      if (mounted && !_asked) setState(() => _asked = true);
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        // 打ち終わってから選択肢を出す。急に伸びないよう高さを繋ぐ。
        _resize(child: _asked ? _options(strings) : const SizedBox(width: double.infinity)),
      ],
    );
  }

  Widget _options(AppStrings strings) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _StageOption(
          stage: SchoolStage.juniorHigh,
          label: strings.settingsSchoolStageJuniorHigh,
          note: strings.onboardingStageJuniorHighNote,
          selected: widget.chosen == SchoolStage.juniorHigh,
          onTap: () => _select(SchoolStage.juniorHigh),
        ),
        const SizedBox(height: AppSpacing.sm),
        _StageOption(
          stage: SchoolStage.highSchool,
          label: strings.settingsSchoolStageHighSchool,
          note: strings.onboardingStageHighSchoolNote,
          selected: widget.chosen == SchoolStage.highSchool,
          onTap: () => _select(SchoolStage.highSchool),
        ),
        const SizedBox(height: AppSpacing.md),
        // **選び直せることを、選ばせる前に言う。**
        Text(
          strings.onboardingStageChangeLater,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }

  /// [AnimatedSize] は長さ0を渡せない(レイアウト中に自分をやり直して落ちる)ので、
  /// 動かさない設定のときは包まずにそのまま返す。
  Widget _resize({required Widget child}) {
    if (AppMotion.isReduced(context)) return child;

    return AnimatedSize(
      duration: AppDurations.reaction,
      curve: AppCurves.enter,
      alignment: Alignment.topCenter,
      child: child,
    );
  }
}

/// 選択肢1つ。**スイッチではなくカード**にしてあるのは、
/// オン/オフではなくどちらかを選ぶものだから(設定画面と同じ理由)。
class _StageOption extends StatelessWidget {
  const _StageOption({
    required this.stage,
    required this.label,
    required this.note,
    required this.selected,
    required this.onTap,
  });

  final SchoolStage stage;
  final String label;
  final String note;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      hint: note,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          key: onboardingStageKey(stage),
          duration: AppMotion.decorative(context, AppDurations.reaction),
          curve: AppCurves.enter,
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: selected ? AppColors.blue.withValues(alpha: 0.08) : AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadius.card),
            border: Border.all(
              color: selected ? AppColors.blue : AppColors.border,
              width: selected ? 2 : 1,
            ),
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(label, style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: AppSpacing.xs),
                    Text(note, style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
              ),
              // 選んだ側にだけ印。**入れ替わりを動きで見せる**ので、
              // どちらを押したかが指を離したあとにも分かる。
              AnimatedScale(
                scale: selected ? 1 : 0,
                duration: AppMotion.decorative(context, AppDurations.reaction),
                curve: AppCurves.pop,
                child: const Icon(Icons.check_circle, color: AppColors.blue),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
