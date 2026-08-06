import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../common_widgets/chunky_button.dart';
import '../../../common_widgets/kohai_face.dart';
import '../../../common_widgets/speaking_wave.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';
import '../../capture/application/capture_controller.dart';
import '../application/session_controller.dart';
import '../domain/session.dart';

/// 会話画面(ワイヤーフレームの03/04を1枚に統合)。
///
/// **にぎやかな画面**にする(handoff §7)。ただし試験官UIにはしない。
/// 主役は後輩の表情で、テキストは字幕として控えめに置く。
class SessionScreen extends ConsumerStatefulWidget {
  const SessionScreen({super.key});

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final SessionStart? session = ref.read(captureControllerProvider).session;
      if (session == null) {
        context.go(AppRoute.home.path);
        return;
      }
      ref.read(sessionControllerProvider.notifier).connect(session);
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final SessionState state = ref.watch(sessionControllerProvider);

    ref.listen<SessionState>(sessionControllerProvider, (SessionState? previous, SessionState next) {
      if (next.phase == SessionPhase.finished) {
        context.go(AppRoute.celebration.path);
      }
    });

    final String subtitle = state.phase == SessionPhase.summarizing
        ? strings.sessionThinking
        : state.lastKohaiText ?? strings.sessionListening;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            children: <Widget>[
              Align(
                alignment: Alignment.centerRight,
                child: Text(
                  strings.remaining(state.remainingSeconds),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              const Spacer(),
              KohaiFace(
                mood: switch (state.phase) {
                  SessionPhase.connecting => KohaiMood.neutral,
                  SessionPhase.listening => KohaiMood.listening,
                  SessionPhase.kohaiSpeaking => KohaiMood.neutral,
                  SessionPhase.summarizing => KohaiMood.neutral,
                  SessionPhase.finished => KohaiMood.delighted,
                  SessionPhase.failed => KohaiMood.puzzled,
                },
                size: 160,
              ),
              const SizedBox(height: AppSpacing.md),
              // 聞いていることを、字幕より先に出す。
              // 話している最中は文字を読んでいないので、目の端で分かる必要がある。
              SpeakingWave(active: state.phase == SessionPhase.listening),
              const SizedBox(height: AppSpacing.md),
              // 字幕。声を聞き取れない場所でも会話の流れを追えるようにする。
              // 差し替わるときに入れ替わりが見えるよう、文ごとに切り替える。
              AnimatedSwitcher(
                duration: AppMotion.decorative(context, AppDurations.reaction),
                child: Text(
                  subtitle,
                  key: ValueKey<String>(subtitle),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
              ),
              const Spacer(),
              // パスは恥ではない。穴の記録として価値がある(handoff §7)。
              GhostButton(
                label: strings.sessionPass,
                onPressed: () => ref.read(sessionControllerProvider.notifier).onUserTurn(),
              ),
              ChunkyButton(
                label: strings.sessionEnd,
                color: AppColors.border,
                foregroundColor: AppColors.ink,
                onPressed: () => ref.read(sessionControllerProvider.notifier).finish(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
