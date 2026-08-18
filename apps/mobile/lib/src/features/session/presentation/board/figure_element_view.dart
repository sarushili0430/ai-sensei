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
/// **板書の幅にそろえる。**
///
/// 以前は [BoardStyle.graphicHeight] に高さを合わせ、横は比率のまま中央に置いていた。
/// SVGは 320×224 で、板書の実効幅(345pt)より**細い箱に収まってしまう** —
/// 式や注記は左端から幅いっぱいに並ぶので、図だけが一段内側に浮いて見える
/// (実機で「図と式で横幅が揃っていない」として上がった)。
///
/// 横を板書の幅に合わせ、縦は比率のまま伸ばす。SVGの縦横比は
/// `@ai-sensei/figure` が 10:7 前後に固定しているので、345pt 幅なら 240pt 前後で
/// 収まり、板書の1手順としては大きすぎない。**上限だけは持たせる** —
/// 縦長の図(数直線を縦に積んだものなど)が来たときに、1手順で画面を埋めないため。
class FigureElementView extends StatelessWidget {
  const FigureElementView({required this.svg, super.key});

  /// 図1つに渡す高さの上限。板書は積み上がるので、1手順が画面を占めると
  /// 前の行が押し出されて見えなくなる。
  static const double maxHeight = 260;

  final String svg;

  @override
  Widget build(BuildContext context) {
    // **幅は実測してから渡す。**`width: double.infinity` だと縦も箱いっぱいに
    // 広がってしまい(`BoxFit.contain` が上下に余白を作る)、図が板書の中で
    // 浮いて見える。具体的な幅を渡すと、縦はSVGの `viewBox` の比率から決まる。
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) => ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: maxHeight),
        child: SvgPicture.string(
          svg,
          width: constraints.maxWidth.isFinite ? constraints.maxWidth : null,
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
      ),
    );
  }
}
