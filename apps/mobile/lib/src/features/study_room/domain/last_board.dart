import 'package:flutter/foundation.dart';

import '../../session/domain/board.dart';

/// 授業が終わったあとも残る板書。自習室が眺めるのはこれ。
///
/// 授業中の板書は `BoardSnapshot`(`features/session/application/board_inbox.dart`)だが、
/// あれは会話画面(AutoDispose)と一緒に消える。**授業の寿命を超えて残るのはこれだけ。**
///
/// `BoardSnapshot` をそのまま持ち回らないのは、あちらが授業中にしか意味のない
/// ものを含むため(`gapReason` は契約違反の技術的な説明文で、画面に出す文言ではない。
/// `title` は授業画面の見出し)。自習室に要るのは「何が書いてあるか」と
/// 「**それで全部か**」の2つだけなので、そこまで絞って渡す。
@immutable
class LastBoard {
  const LastBoard({this.steps = const <BoardStep>[], this.truncated = false});

  /// 積まれた手順。板書は前の行を消さない(計画書§3-2)。
  final List<BoardStep> steps;

  /// **この板書はとぎれている。**
  ///
  /// 配送の欠落(`seq`/`index` の飛び・読めない封筒)を検知すると、受信側は
  /// そこから先を積むのをやめる(`BoardInbox` の「とぎれた印を出して止める」)。
  /// つまり手順の列は途中で終わっているのに、**列そのものからは区別がつかない**。
  ///
  /// 自習室でこれを黙っていると、計画書§3-6b が案B(横スクロール)を却下した理由
  /// —「これで全部だ」と誤読させる — をそのまま再現する。しかも自習室のほうが危ない:
  /// 授業中は先輩が喋っているので何か起きたと分かるが、自習室には音声が無く、
  /// ユーザーは板書だけを「解き方の記録」として読むため。
  final bool truncated;

  bool get isEmpty => steps.isEmpty;

  /// とぎれた印を出すべきか。手順が1つも無いときは出さない
  /// (見せる板書が無いのに「ここから先は残っていません」だけが出るのは、
  ///  何も起きていないのに壊れて見える)。
  bool get showsTruncation => truncated && steps.isNotEmpty;

  static const LastBoard empty = LastBoard();
}
