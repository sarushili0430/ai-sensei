import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../../telemetry/telemetry.dart';
import '../domain/board.dart';

/// 画面に出せる形にした板書。
///
/// [BoardChannelReceiver] が持っているのは「契約が守られているか」で、
/// こちらは「いま何が黒板に書いてあるか」。分けてあるのは、契約違反が起きた
/// あとも**書いてあるものは消さない**(計画書§3-2)ため — 検査の状態と
/// 表示の状態を同じ入れ物にすると、違反のたびに板書ごと落とすことになる。
@immutable
class BoardSnapshot {
  const BoardSnapshot({this.title, this.steps = const <BoardStep>[], this.gapReason});

  /// 板書の見出し(`board_open` の `title`)。「この板書は何の問題か」。
  final String? title;

  /// これまでに積まれた手順。**前の行は消えない**(消えるのは `board_open` のときだけ)。
  final List<BoardStep> steps;

  /// 板書がとぎれた理由。null なら健全。
  ///
  /// **これは画面に出す文言ではない**(契約違反の技術的な説明)。画面には
  /// ロケールに沿った一行を出す。ここに残しているのは、開発中に手元のログと
  /// 突き合わせるためと、縮退の記録(`Degradation.boardGap`)に載せる材料のため。
  final String? gapReason;

  /// 授業モードに入っているか。**画面のレイアウトが切り替わる条件**。
  ///
  /// `title` だけで判定しないのは、`board_open` が落ちて手順から届いた場合でも
  /// 板書を出すため(その状態は [gapReason] が別に伝える)。
  bool get hasBoard => title != null || steps.isNotEmpty;

  /// とぎれたまま止まっているか。
  bool get hasGap => gapReason != null;

  static const BoardSnapshot empty = BoardSnapshot();
}

/// data channel から届いた封筒を、画面に出せる板書([BoardSnapshot])に変える。
///
/// LiveKitを知らない層にしてある(受け取るのは文字列と封筒だけ)。理由は
/// **欠落したときの振る舞いが、この層でいちばん決まるから** — 実機の接続を
/// 用意しないと試せない場所に置くと、いちばん試したい壊れ方が試せなくなる。
///
/// ## 欠落したときにどうするか(黙って握りつぶさない)
///
/// `seq` / `index` が飛んだ、`session_id` が違う、JSONが読めない —
/// どれも「板書が虫食いのまま画面に出る」一歩手前の状態
/// (`domain/board.dart` の [BoardContractViolation] のコメント)。決めた振る舞いは3つ:
///
///   1. **すでに積んだ行は消さない。**欠落は「そこから先が読めない」であって、
///      それまで書かれたものが嘘になるわけではない。消すほうが損失が大きい。
///   2. **そこから先はその板書に積まない。**積むと、抜けた場所が分からないまま
///      虫食いの板書ができあがる。生徒は「抜けている」ことに気づけないので、
///      間違ったまま覚える。**とぎれた印を出して止めるほうが安全。**
///   3. **次の `board_open` で復帰する。**別の問題に移るなら板書はどのみち
///      作り直されるので、そこを復帰点にする。1問ぶん壊れて終わりにして、
///      セッション全体を道連れにしない。
///
/// 復帰しても `seq` は数え直すだけ([BoardChannelReceiver] の `expectedSeq`)なので、
/// **復帰後に起きた欠落もひきつづき検知できる**。
class BoardInbox {
  BoardInbox({required this.sessionId})
    : _receiver = BoardChannelReceiver(sessionId: sessionId);

  /// この接続のセッション。宛先違いの封筒を落とすために要る。
  final String sessionId;

  BoardChannelReceiver _receiver;
  String? _title;
  String? _gapReason;

  /// いまの板書。
  BoardSnapshot get snapshot =>
      BoardSnapshot(title: _title, steps: _receiver.currentSteps, gapReason: _gapReason);

  /// ストリームから読み切った封筒1通(JSON文字列)を処理する。
  ///
  /// 戻り値は **板書が変わったか**。変わっていないなら画面を塗り直す必要がない
  /// (とぎれたあとに届き続ける封筒は、ここで静かに捨てられる)。
  bool acceptPayload(String payload) {
    final BoardChannelMessage message;
    try {
      message = BoardChannelMessage.fromJson(
        jsonDecode(payload) as Map<String, dynamic>,
      );
    } catch (error) {
      // 読めない封筒は**中身が分からない = 何が抜けたかも分からない**。
      // 欠落と同じ扱いにする(黙って捨てると虫食いになる)。
      return _breakBoard('封筒を読めませんでした: $error');
    }
    return accept(message);
  }

  /// 封筒1通を処理する。
  bool accept(BoardChannelMessage message) {
    if (_gapReason != null) {
      // とぎれた板書には積まない。復帰点は「別の問題に移るとき」だけ。
      if (message is! BoardOpenMessage) return false;
      _receiver = BoardChannelReceiver.resumingAt(sessionId: sessionId, seq: message.seq);
      _gapReason = null;
      _title = null;
    }

    try {
      _receiver.accept(message);
    } on BoardContractViolation catch (violation) {
      return _breakBoard(violation.message);
    }

    // 受理できたときだけ見出しを差し替える。検査を通る前に書き換えると、
    // 宛先違いの封筒で見出しだけがすり替わる。
    if (message is BoardOpenMessage) _title = message.title;
    return true;
  }

  /// 板書をとぎれた状態にする。戻り値は [accept] の「変わったか」に合わせてある。
  bool _breakBoard(String reason) {
    _gapReason = reason;

    // **握りつぶさない。** ここは agent の送信漏れに気づく唯一の手段で、
    // 以前は `debugPrint` にしか出ていなかった = 本番では観測手段がゼロだった
    // (計画書 §10-7)。画面にはロケールに沿った一行が出る(この文は出さない)。
    //
    // 間引きは板書1枚ごと。`board_open` すら読めずに壊れた場合は板書IDが無いので、
    // セッション単位に落とす(その場合は1セッションに1件だけ飛ぶ)。
    Telemetry.report(
      DegradationEvent.boardGap(
        sessionId: sessionId,
        boardId: _receiver.openBoardId,
        // 契約違反の理由。**生徒の発話も問題文も含まない**
        // (`BoardContractViolation` が組み立てる、seq と index の話だけ)。
        reason: reason,
        stepsSoFar: _receiver.currentSteps.length,
      ),
    );
    return true;
  }
}
