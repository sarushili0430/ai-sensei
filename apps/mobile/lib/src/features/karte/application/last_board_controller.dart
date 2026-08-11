import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../session/domain/board.dart';
import '../domain/last_board.dart';

part 'last_board_controller.g.dart';

/// 直前の授業で先輩が書いた板書。
///
/// - 授業側は AutoDispose なので、寿命を超えて残る場所はここだけ
/// - 置き場所が karte なのは「作った側」ではなく**使う側**に置く方針から
/// - 板書の寿命は1つの問題ぶん。次の `board_open` で自然に空になる
/// - 書き込みは `SessionController._applyBoard` の1か所だけ
/// - `board_close` ではなく**変わるたび**に書く。締めは途中終了では来ない
@Riverpod(keepAlive: true)
class LastBoardController extends _$LastBoardController {
  @override
  LastBoard build() => LastBoard.empty;

  /// 板書を丸ごと置き換える。**積み足しではない**(受信側が既に積んでいる)。
  ///
  /// [truncated] は `BoardSnapshot.hasGap`。渡さないと、とぎれた板書が
  /// 健全な板書として残る([LastBoard.truncated])。
  void set(List<BoardStep> steps, {bool truncated = false}) => state = LastBoard(
        steps: List<BoardStep>.unmodifiable(steps),
        truncated: truncated,
      );

  /// 板書を消す。次の問題に移ったが、まだ1手順も届いていないときのため。
  void clear() => state = LastBoard.empty;
}
