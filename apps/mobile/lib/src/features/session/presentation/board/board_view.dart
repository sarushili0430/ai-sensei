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
/// 複数ある(授業・オンボーディングのリハーサル)から。呼び出し側に
/// 面を描かせると、**チョークの色だけ来て板が来ない画面**(白地に白い文字)が
/// 作れてしまう。
///
/// **左右の余白はここが持つ。** だから呼び出し側は板書に横の余白を付けない
/// (付けると二重になり、実効幅が `BoardStyle.horizontalPadding` の前提とずれる)。
///
/// **角丸は呼び出し側が付ける。** 板の高さは画面によって違い
/// (授業は残りの高さ全部、リハーサルは中身の高さ)、どこで角を丸めるかは
/// その高さを知っている側にしか決められない(`session_screen.dart` の `_BoardStage`)。
class BoardView extends StatelessWidget {
  const BoardView({required this.steps, this.title, super.key});

  /// 板の内側の余白(左右)。キャンバスの `padding: 20px 18px` の横。
  static const double padding = BoardStyle.innerPadding;

  final List<BoardStep> steps;

  /// 板の見出し(「解の個数の調べ方」)。**板の中に置く。**
  ///
  /// 画面のヘッダに出していたころは、板と見出しのあいだに問題の紙カードが挟まって
  /// 「何の板書か」が板から離れていた。キャンバスでは板のいちばん上の行で、
  /// チョークの控えめな色。無ければ何も出さない。
  final String? title;

  @override
  Widget build(BuildContext context) {
    final List<BoardStep> withBoard = steps.where((BoardStep s) => s.board != null).toList();
    final String? heading = title;

    if (withBoard.isEmpty && heading == null) {
      return const SizedBox.shrink();
    }

    return ColoredBox(
      color: BoardStyle.surface,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: padding,
          vertical: BoardStyle.innerPaddingVertical,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (heading != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: Text(
                  heading,
                  key: const Key('board-title'),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: BoardStyle.chalkMuted,
                        letterSpacing: BoardStyle.titleLetterSpacing,
                      ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
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
