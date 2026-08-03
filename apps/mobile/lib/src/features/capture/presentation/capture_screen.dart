import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../api/api_client.dart';
import '../../../common_widgets/chunky_button.dart';
import '../../../l10n/strings.dart';
import '../../../routing/routes.dart';
import '../../../theme/tokens.dart';
import '../../session/domain/session.dart';
import '../application/capture_controller.dart';

/// 撮影 → 単元確認。
///
/// 検出した単元はチップで出し、**ユーザーが外せる**ようにする。
/// 写真解析が外したときに直せる余地を残すため(handoff §3-1)。
class CaptureScreen extends ConsumerStatefulWidget {
  const CaptureScreen({super.key});

  @override
  ConsumerState<CaptureScreen> createState() => _CaptureScreenState();
}

class _CaptureScreenState extends ConsumerState<CaptureScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _pickPhoto());
  }

  Future<void> _pickPhoto() async {
    final XFile? picked = await ImagePicker().pickImage(
      source: ImageSource.camera,
      imageQuality: 85,
    );
    if (picked == null) {
      if (mounted) context.go(AppRoute.home.path);
      return;
    }
    if (!mounted) return;
    final String locale = Localizations.localeOf(context).languageCode;
    final CaptureController controller = ref.read(captureControllerProvider.notifier);
    controller.setPhoto(File(picked.path));
    await controller.analyze(locale: locale);
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    final CaptureState state = ref.watch(captureControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(strings.captureConfirmTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: _body(state),
        ),
      ),
    );
  }

  Widget _body(CaptureState state) {
    final ApiException? error = state.error;
    if (error != null) {
      return _ErrorView(
        message: error.message,
        // 無料枠に当たったときは、再試行ボタンを出さない(押しても同じ結果なので)
        onRetry: error.isFreeLimitReached ? null : _pickPhoto,
      );
    }
    if (state.isSubmitting || state.session == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return _TopicConfirm(state: state);
  }
}

class _TopicConfirm extends ConsumerWidget {
  const _TopicConfirm({required this.state});

  final CaptureState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings strings = AppStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(strings.captureConfirmHint, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.md),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: state.topics
              .map(
                (DetectedTopic topic) => _TopicChip(
                  topic: topic,
                  selected: state.isSelected(topic.topicId),
                  onTap: () => ref
                      .read(captureControllerProvider.notifier)
                      .toggleTopic(topic.topicId),
                ),
              )
              .toList(growable: false),
        ),
        const Spacer(),
        ChunkyButton(
          label: strings.captureStart,
          onPressed: state.canStart
              ? () async {
                  // 外した単元を反映してから始める。ここを飛ばすと、サーバ側の
                  // セッションとトークンは解析時のままで、外した単元を
                  // 後輩が聞けてしまう。
                  final SessionStart? session = await ref
                      .read(captureControllerProvider.notifier)
                      .confirmAndStart(
                        locale: Localizations.localeOf(context).languageCode,
                      );
                  if (session != null && context.mounted) {
                    context.go(AppRoute.session.path);
                  }
                }
              : null,
        ),
      ],
    );
  }
}

class _TopicChip extends StatelessWidget {
  const _TopicChip({required this.topic, required this.selected, required this.onTap});

  final DetectedTopic topic;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
        decoration: BoxDecoration(
          color: selected ? AppColors.blue : AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.chip),
          border: Border.all(color: selected ? AppColors.blue : AppColors.border),
        ),
        child: Text(
          topic.topic,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: selected ? Colors.white : AppColors.inkMuted,
              ),
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final AppStrings strings = AppStrings.of(context);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        // サーバの文言をそのまま出す。煽らない文体で書かれている。
        Text(message, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: AppSpacing.lg),
        if (onRetry != null) ChunkyButton(label: strings.errorRetry, onPressed: onRetry),
        GhostButton(
          label: strings.karteDone,
          onPressed: () => context.go(AppRoute.home.path),
        ),
      ],
    );
  }
}
