import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../session/domain/board.dart';
import '../domain/last_board.dart';

part 'last_board_controller.g.dart';

/// 直前の授業で先輩が書いた板書。
///
/// 自習室の主役は**さっきの板書が残っていること**(計画書§4-2)。板書そのものは
/// 授業(`SessionController`)が受け取るが、あちらは `@riverpod`(AutoDispose)で、
/// 会話画面を離れた瞬間に `BoardSnapshot` ごと破棄される。
/// **授業の寿命を超えて板書が残る場所は、このプロバイダだけ。**
///
/// 置き場所が session ではなく study_room なのは、既存の [LatestKarteController] /
/// [SessionOutcomeController] が(会話の産物なのに)`features/karte/` にあるのと同じ理由 —
/// 授業の寿命を超えるものは「作った側」ではなく「使う側」の feature に置く。
/// おかげで session 側は1行書き込むだけで済み、自習室を知らずにいられる。
///
/// 板書の寿命は**1つの問題**(会話1回ではない・`4e2acbc`)。次の `board_open` が
/// 来ると受信側の手順が空になり、そのまま空の列が流れてくるので、ここも自然に空になる。
///
/// 書き込むのは `SessionController._applyBoard` の1か所だけで、
/// **`board_close` のときだけではなく板書が変わるたび**に呼ばれる
/// (締めは問題が終わったときにしか来ないので、途中で会話を終えた板書が届かなくなるため)。
/// 読むのは自習室だけ。授業が1回も無ければ空のままで、
/// 自習室はそのときだけ「板書はまだありません」を出す。
@Riverpod(keepAlive: true)
class LastBoardController extends _$LastBoardController {
  @override
  LastBoard build() => LastBoard.empty;

  /// 板書を丸ごと置き換える。**積み足しではない** — 受信側
  /// (`BoardChannelReceiver.currentSteps`)が既に積み上がった列を持っているので、
  /// こちらは最新の列をそのまま受け取る。
  ///
  /// [truncated] には受信側の「とぎれているか」(`BoardSnapshot.hasGap`)を渡す。
  /// 既定を `false` にしてあるのは、渡さない呼び出しでも壊れないようにするため
  /// (ただし渡さないと、とぎれた板書が健全な板書として自習室に残る。理由は
  /// [LastBoard.truncated])。
  void set(List<BoardStep> steps, {bool truncated = false}) => state = LastBoard(
        steps: List<BoardStep>.unmodifiable(steps),
        truncated: truncated,
      );

  /// 板書を消す。次の問題に移ったが、まだ1手順も届いていないときのため。
  void clear() => state = LastBoard.empty;
}
