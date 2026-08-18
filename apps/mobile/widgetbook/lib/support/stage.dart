import 'package:ai_sensei/src/features/session/presentation/board/board_style.dart';
import 'package:ai_sensei/src/theme/tokens.dart';
import 'package:flutter/material.dart';

/// 部品を、画面に置かれるときと同じ幅・同じ余白で置く。
///
/// **[Center] を通すのは、位置を決めるためだけではない。**
/// アドオンの `Align` は子にゆるい制約(最小0)を渡すので、素で置くと
/// 「幅いっぱいに広がる部品」が中身の幅まで縮む。厚みのあるボタンが
/// 実機では画面幅なのにカタログでは文字幅、という**アプリに存在しない
/// 見え方**になる。[Center] は与えられた最大まで自分を広げるので、
/// その中の `double.infinity` が端末の幅として解決される。
Widget stage(Widget child) {
  return Padding(
    padding: const EdgeInsets.all(AppSpacing.lg),
    child: Center(child: child),
  );
}

/// 板書の部品を**板の上に**置く。
///
/// チョークの色は白地では読めない。地の上で見ると、
/// **アプリに存在しない見え方**を見ながら直すことになる
/// (`test/golden/board_elements_golden_test.dart` が同じ理由で
/// `BoardStyle.surface` を敷いている)。
///
/// **横は必ず画面幅まで広げる。** 板書の実効幅は式の縮小率に直結していて
/// (`BoardStyle.measuredWidthAssumption` = 340)、板が中身の幅まで縮むと
/// 縮小もフォールバックの横スクロールも再現しない。縦は中身なり
/// (板が画面を埋めるのはアプリでも起きない)。
///
/// 左右の余白は本来 `BoardView` が持っているので、要素単体を見るときだけ
/// ここが肩代わりする。
Widget onBoard(Widget child) {
  return Center(
    child: SizedBox(
      width: double.infinity,
      child: ColoredBox(
        color: BoardStyle.surface,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.lg,
            vertical: AppSpacing.md,
          ),
          child: child,
        ),
      ),
    ),
  );
}
