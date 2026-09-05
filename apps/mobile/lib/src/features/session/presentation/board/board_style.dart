import 'package:flutter/material.dart';

/// 板書レイヤー専用の追加値。
///
/// **`AppColors` は変更・追加しない。**アプリ全体の地と本文の色はそのままで、
/// ここに置くのは**板の上でしか使わない色**だけ(下記)。時間は既存トークン
/// (`AppDurations.draw`)をそのまま使う。
///
/// ─────────────────────────────────────────────────────────────────────────
/// 【板は黒板】`docs/wireframe_board_v2.html` の決定2
/// ─────────────────────────────────────────────────────────────────────────
///
/// もともと板書は地(`AppColors.background`)に文字が直接乗っているだけで、
/// **どこからどこまでが板書なのか境目が無かった**。問題文・式・図が同じ紙の上に
/// 平らに並ぶので、主役が板書だと見た目から分からない。
///
/// 素材を2つに分ける: **問題 = 紙(白いカード)/ 板書 = 黒板**。
/// ラベルを読まなくても役割が分かるのは、文字ではなく素材が違うから。
///
/// **板は角の丸いカードとして置く**(`docs/core_loop_screens.html` / ADR 0009)。
/// 以前は「板は面であってカードではない」として画面の左右いっぱいに敷いていたが、
/// 画面遷移キャンバスは半径 `AppRadius.card` の角丸で、左右に地(`background`)を
/// 残している。**紙のカードと黒板が同じ形で並ぶ**ことで、素材の違い(白い紙 /
/// 黒い板)だけが役割の差として残る — 片方だけ全幅だと、形の差が素材の差を上書きする。
/// 代償は実効幅で、下の [horizontalPadding] にそのまま書いてある。
///
/// **色は作図(`@ai-sensei/figure` の `render.js`)が既に使っている値と同じにする。**
/// 図のSVGは背景 `#2f3a35`・線 `#edeae0` で描かれてくるので、板をこの色にすると
/// **図が板に溶けて、1枚の黒板として繋がる**(別の色にすると、図だけ切手のように浮く)。
/// 緑にするか紺にするかはワイヤー v2 の時点で「実機で決める」保留のままなので、
/// ここを触るときは図の側(`render.js` / `docs/figeval/render.mjs`)と**必ず一緒に**変えること。
abstract final class BoardStyle {
  /// 板の地。作図SVGの背景と同じ値。
  static const Color surface = Color(0xFF2F3A35);

  /// 板の上の文字(チョーク)。作図SVGの線と同じ値。
  static const Color chalk = Color(0xFFEDEAE0);

  /// 板の上の控えめな文字(訳・注記・目盛)。チョークを落としたもの。
  static const Color chalkMuted = Color(0xFF9FA8A2);

  /// 板の上で「いま見てほしいところ」。作図SVGの `as: "key"` と同じ黄色。
  ///
  /// **板の上では青やピンクは沈む**(ワイヤー v2 の決定3)。強調は色ではなく
  /// 下線・囲みでやるのが黒板の作法だが、線だけでは足りない場所
  /// (グラフの曲線・角の印)にはこのチョークの黄を使う。
  static const Color chalkKey = Color(0xFFF2D675);

  /// LaTeXの基準フォントサイズ。
  ///
  /// **新しく決めた数字ではない。** 板書の実効幅スパイク(計画書§3-6b・
  /// team-leadへの実測報告)で最初から最後まで使い続けた値をそのまま引き継いでいる。
  /// 「340pt上での溢れ判定」「FittedBoxの縮小限界(54%/32%/24%)」の実測値は
  /// すべてこのフォントサイズを基準にしているので、ここだけ別の値にすると
  /// 実測結果が板書の実装に対応しなくなる。
  static const double latexFontSize = 24;

  /// FittedBoxで縮小してよい下限(縮小率)。計画書§3-6bの決定。
  ///
  /// 実測(意図的に長い式・自然幅624pt)では、340pt箱に縮小した54%は
  /// 「ぎりぎり読める」、200pt箱の32%は「厳しい」だった。70%を下限にしておけば、
  /// 実測で溢れが確認された式(縮小率76〜97%)は全部この範囲に収まる。
  ///
  /// これを下回る式は、本来はagent側が2手順に分割して送るべきもの(§3-6bの案C)が
  /// 分割されないまま届いた状態で、**契約違反に近い**。[LatexElementView] は
  /// これ以上縮めず、70%で固定して横スクロールに逃がす(安全弁。理由は同ファイル参照)。
  static const double latexMinScale = 0.70;

  /// 図形プリミティブ(plot / triangle / circle)を描く `CustomPaint` の高さ。
  /// 板書の1手順として単独の行に収まる大きさ。
  static const double graphicHeight = 180;

  /// 英語の例文の文字サイズ。
  ///
  /// 数式(24)より小さいのは、**1文がそのぶん長い**から。120字の英文を24ptで
  /// 出すと実効幅340ptで4行以上になり、板書の1手順が画面を埋める。
  /// 本文(bodyLarge)より少し大きい程度にして、注記との差だけを付ける。
  static const double sentenceFontSize = 18;

  /// `focus` に引く下線の太さ。**文字の一部を指す線**なので、
  /// 罫線より太く、囲みより細い。
  static const double focusUnderlineThickness = 2;

  /// 実測の前提にした板書の実効幅(pt)。iPhone 15 の393ptから余白を引いた値。
  ///
  /// **[latexMinScale] はこの幅を基準に決めた値**なので、実際の幅がこれを下回ると
  /// 「縮小して収まる」と確認した式まで横スクロールに落ちる。
  /// 見た目では気づけないので、下回ったら記録する
  /// (`Degradation.boardTooNarrow`。計画書 §10-7)。
  static const double measuredWidthAssumption = 340;

  /// 板書の左右の余白の合計。
  ///
  /// **カードになったぶん増えた。**内訳は「画面の余白 `AppSpacing.lg`(24)+
  /// 板の内側 [innerPadding](18)」の左右2つぶんで 84pt。
  /// 全幅だったころは板の内側24ptだけの 48pt だった。
  ///
  /// iPhone 15(393pt)での実効幅は **309pt** で、[measuredWidthAssumption] の
  /// 340pt を下回る。これは**版組が食った事故ではなく、いまの設計値**なので、
  /// [expectedWidth] は端末幅から実際に取れる幅を返す(そうしないと
  /// `Degradation.boardTooNarrow` が全端末で毎回鳴り、本当の狭さが埋もれる)。
  static const double horizontalPadding = 48 + innerPadding * 2;

  /// 板の内側の余白(左右)。キャンバスの `padding: 20px 18px` の横。
  static const double innerPadding = 18;

  /// 板の内側の余白(上下)。同じくキャンバスの縦。
  static const double innerPaddingVertical = 20;

  /// 板の見出し(「解の個数の調べ方」)の字送り。キャンバスの `.08em` を 12pt で。
  static const double titleLetterSpacing = 0.96;

  /// この端末で板書が使えるはずの幅。
  ///
  /// **[measuredWidthAssumption] をそのまま閾値にすると、狭い端末では
  /// 当たり前に下回る。** 340pt は iPhone 15(393pt)基準の値で、
  /// iPhone SE(375pt)なら 375 − 48 = **327pt** にしかならない。
  /// 端末が狭いという事実を縮退として送ると、**SEの利用者ぶんが全部飛んで**、
  /// 本当に見たい「こちらの版組が幅を食った」(授業の外で板書をカードに入れて
  /// 311ptまで落ちていた件)が件数に埋もれる。
  ///
  /// なので比べる相手は「この端末で取れるはずの幅」にする。
  /// 下回るのは**版組が食ったときだけ**になる。
  static double expectedWidth(double screenWidth) {
    final double available = screenWidth - horizontalPadding;
    return available < measuredWidthAssumption ? available : measuredWidthAssumption;
  }
}
