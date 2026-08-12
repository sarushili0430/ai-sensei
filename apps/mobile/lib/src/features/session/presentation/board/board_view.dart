import 'package:flutter/material.dart';

import '../../../../common_widgets/board_reveal.dart';
import '../../../../theme/tokens.dart';
import '../../domain/board.dart';
import 'board_element_view.dart';
import 'board_style.dart';

/// 板書そのもの。`BoardStep` の列を、**1行ずつ積んで消さない**形で表示する
/// (計画書§3-2「フロントは受信順に1行ずつ積む(前の行は消さない・残り続ける)」)。
///
/// [BoardChannelReceiver.currentSteps] がそのまま [steps] に入る想定
/// (このウィジェット自体はLiveKitやReceiverを知らない。データを渡されて
/// 描くだけの層に留めてある)。
///
/// `board == null` の手順(相づち・確認。音声だけの手順)は、
/// 板書には何も残さない(§3-1「音声は問いかけと接続だけ」の裏返し)。
/// **板そのものを持つのはここ**(`board_style.dart` の「板は黒板」)。
///
/// 面を呼び出し側ではなくこのウィジェットに置いてあるのは、板書を出す画面が
/// 3つある(授業・カルテ・オンボーディングのリハーサル)から。呼び出し側に
/// 面を描かせると、**チョークの色だけ来て板が来ない画面**(白地に白い文字)が
/// 作れてしまう。
///
/// **左右の余白はここが持つ。** だから呼び出し側は板書に横の余白を付けない
/// (付けると二重になり、実効幅が340ptを割って式が横スクロールに落ちる)。
class BoardView extends StatelessWidget {
  const BoardView({required this.steps, super.key});

  /// 板の内側の余白。**呼び出し側の余白と同じ値**にしてあるので、
  /// 画面いっぱいに敷いても実効幅は今までと1ptも変わらない。
  static const double padding = AppSpacing.lg;

  final List<BoardStep> steps;

  @override
  Widget build(BuildContext context) {
    final List<BoardStep> withBoard = steps.where((BoardStep s) => s.board != null).toList();

    if (withBoard.isEmpty) {
      return const SizedBox.shrink();
    }

    return ColoredBox(
      color: BoardStyle.surface,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: padding, vertical: AppSpacing.md),
        child: Column(
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
        ),
      ),
    );
  }
}
