/// 板書レイヤー専用の追加値。
///
/// **既存の `AppColors` / `AppDurations` は変更・追加しない**(team-leadの指示)。
/// ここにあるのは、既存のテキストテーマのスケール(`app_theme.dart` の
/// `displaySmall`/`titleLarge`/`bodyLarge`...)には無い、板書固有の値だけ。
/// 色と時間はどちらも既存トークン(`AppColors.ink` / `AppDurations.draw`)を
/// そのまま使い、ここでは新しく定義しない。
abstract final class BoardStyle {
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

  /// 板書の左右の余白の合計。どの画面も `AppSpacing.lg` × 2 で揃えてある。
  static const double horizontalPadding = 48;

  /// この端末で板書が使えるはずの幅。
  ///
  /// **[measuredWidthAssumption] をそのまま閾値にすると、狭い端末では
  /// 当たり前に下回る。** 340pt は iPhone 15(393pt)基準の値で、
  /// iPhone SE(375pt)なら 375 − 48 = **327pt** にしかならない。
  /// 端末が狭いという事実を縮退として送ると、**SEの利用者ぶんが全部飛んで**、
  /// 本当に見たい「こちらの版組が幅を食った」(自習室のカードで311ptまで
  /// 落ちていた件)が件数に埋もれる。
  ///
  /// なので比べる相手は「この端末で取れるはずの幅」にする。
  /// 下回るのは**版組が食ったときだけ**になる。
  static double expectedWidth(double screenWidth) {
    final double available = screenWidth - horizontalPadding;
    return available < measuredWidthAssumption ? available : measuredWidthAssumption;
  }
}
