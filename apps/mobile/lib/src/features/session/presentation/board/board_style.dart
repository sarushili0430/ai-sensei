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
}
