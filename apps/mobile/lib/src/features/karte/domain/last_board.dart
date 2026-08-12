import 'package:flutter/foundation.dart';

import '../../session/domain/board.dart';

/// 授業が終わったあとも残る板書。カルテが読み返すのはこれ。
///
/// - 授業中の `BoardSnapshot` は会話画面(AutoDispose)と一緒に消える
/// - あちらは授業中にしか意味の無いもの(`gapReason`・`title`)を含む
/// - 読み返す側に要るのは「何が書いてあるか」と「それで全部か」の2つだけ
@immutable
class LastBoard {
  const LastBoard({this.steps = const <BoardStep>[], this.truncated = false});

  /// 積まれた手順。板書は前の行を消さない(計画書§3-2)。
  final List<BoardStep> steps;

  /// **この板書はとぎれている。**
  ///
  /// - 配送の欠落を検知すると受信側はそこで積むのをやめる
  /// - 列が途中で終わっていることは、列そのものからは区別がつかない
  /// - 黙ると「これで全部だ」と誤読させる。カルテは音声が無いぶん危ない
  final bool truncated;

  bool get isEmpty => steps.isEmpty;

  /// とぎれた印を出すべきか。板書が空なら出さない(壊れて見えるだけ)。
  bool get showsTruncation => truncated && steps.isNotEmpty;

  static const LastBoard empty = LastBoard();
}
