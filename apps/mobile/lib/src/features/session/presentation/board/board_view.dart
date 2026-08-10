import 'package:flutter/material.dart';

import '../../../../common_widgets/board_reveal.dart';
import '../../../../theme/tokens.dart';
import '../../domain/board.dart';
import 'board_element_view.dart';

/// 板書そのもの。`BoardStep` の列を、**1行ずつ積んで消さない**形で表示する
/// (計画書§3-2「フロントは受信順に1行ずつ積む(前の行は消さない・残り続ける)」)。
///
/// [BoardChannelReceiver.currentSteps] がそのまま [steps] に入る想定
/// (このウィジェット自体はLiveKitやReceiverを知らない。データを渡されて
/// 描くだけの層に留めてある)。
///
/// `board == null` の手順(相づち・確認。音声だけの手順)は、
/// 板書には何も残さない(§3-1「音声は問いかけと接続だけ」の裏返し)。
class BoardView extends StatelessWidget {
  const BoardView({required this.steps, super.key});

  final List<BoardStep> steps;

  @override
  Widget build(BuildContext context) {
    final List<BoardStep> withBoard = steps.where((BoardStep s) => s.board != null).toList();

    if (withBoard.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (final BoardStep step in withBoard)
          Padding(
            // indexをkeyにする: 同じ手順が再ビルドで新しいウィジェットに
            // 作り直されないようにする(作り直されると、書く動きが毎回最初から
            // 再生されて「前の行は消さない」の実感が崩れる)。
            key: ValueKey<int>(step.index),
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
            child: BoardReveal(child: BoardElementView(element: step.board!)),
          ),
      ],
    );
  }
}
