import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'board_style.dart';

/// 作図を描く。**中身はサーバが解いて描いたSVG**で、ここは表示するだけ。
///
/// 図の語彙(三角形・増減表・遷移図・箱ひげ図…)が増えても**このファイルは変わらない**。
/// 語彙はサーバ側(`@ai-sensei/figure`)にあり、端末に届くのは常にSVG1枚だから
/// (`docs/wireframe_board_v2.html` D-19/D-21。プリミティブごとにpainterを増やす
/// 作りだと、語彙1つにつき5ファイル触ることになっていた)。
///
/// **幅いっぱいに広げない。** SVGは文字も一緒に拡大縮小されるので、
/// 横に伸ばすと図が大きくなるぶんには読めるが、**縦が伸びて板書の1手順として
/// 収まらなくなる**。他のプリミティブ([BoardStyle.graphicHeight])と同じ高さに
/// 揃えて、横は元の縦横比のままにする。
class FigureElementView extends StatelessWidget {
  const FigureElementView({required this.svg, super.key});

  final String svg;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: BoardStyle.graphicHeight,
      child: SvgPicture.string(
        svg,
        // 縦を [BoardStyle.graphicHeight] に合わせ、横は比率のまま中央に置く。
        fit: BoxFit.contain,
        alignment: Alignment.center,
        // **読み上げは呼び出し側が1つだけ付ける。**ここで付けると、
        // `BoardElementView` の [Semantics] と二重に読まれる。
        excludeFromSemantics: true,
        // 壊れたSVGが届いたときに、赤い例外画面ではなく**空の板書行**にする。
        // 授業の途中で画面が落ちるより、その1行が抜けるほうが軽い
        // (`board.ts` の「壊れたら止まる。ただし今あるものは消さない」と同じ判断)。
        placeholderBuilder: (BuildContext context) => const SizedBox.shrink(),
      ),
    );
  }
}
