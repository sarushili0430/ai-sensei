import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';

import '../../../../telemetry/telemetry.dart';
import '../../../../theme/tokens.dart';
import 'board_style.dart';

/// LaTeXの数式(`BoardElement.latex`)を描く。
///
/// **実効幅に収まらない式がある(計画書§3-6b の実測)。** 文字数の上限だけでは
/// 表示幅を保証できないので、ここで実測して対処する:
///
///   1. 自然な幅(制約なしで測った幅)を1回だけ計測する
///   2. 自然な幅が使える幅に収まるなら、そのまま等倍で置く
///   3. 収まらないが、縮小率が [BoardStyle.latexMinScale](70%)以上で足りるなら
///      `FittedBox` で縮める
///   4. **70%を下回る式が来たら、これ以上は縮めない。** 70%で固定して
///      横スクロールに逃がす。
///
/// 4番目の判断について: 本来この式は agent 側で2手順に分割されてから
/// 届くべきもの(§3-6b案C)で、ここに来た時点で契約に近い違反が起きている。
/// **モバイル側でできることは「読めなくなるまで縮める」ことではなく
/// 「せめて全部読めるところまで到達できるようにする」ことだけ**だと判断した。
/// 実測(意図的に長い式・自然幅624pt)では、340pt箱への54%縮小は
/// 「ぎりぎり読める」、200pt箱への32%縮小は「厳しい」だった。70%を下回る
/// 状況は輪をかけて長い式なので、無条件に縮め続けるとほぼ確実に読めなくなる。
/// 横スクロールは板書としては望ましくない(実測比較で不採用と判定した案B)が、
/// **「読めないまま固定表示する」よりは「操作すれば全部読める」方が安全**という
/// 消去法の選択。**起きてはいけない状態なので、記録して本番でも気づけるようにする**
/// (`Degradation.latexScaleFloor`。計画書 §10-7。以前は `debugPrint` だけで、
/// agent 側の分割が効いていないことに永遠に気づけなかった)。
///
/// **横スクロールに逃がすだけでは、案Bを不採用にした理由がそのまま復活する。**
/// 実測比較で案Bを見送ったのは「静止画では続きがある手がかりが一切ない」ためで、
/// 縮小率で逃げ道を変えても、この問題自体は解決していない。右端に
/// [_ScrollWithEdgeFade] のフェードを重ね、**スクロールできることではなく
/// 「スクロールできると分かること」**を保証する。最後まで見えたらフェードは消す
/// (見えているのに手がかりが出続けるのも不自然なため)。
class LatexElementView extends StatefulWidget {
  const LatexElementView({required this.tex, super.key});

  final String tex;

  @override
  State<LatexElementView> createState() => _LatexElementViewState();
}

class _LatexElementViewState extends State<LatexElementView> {
  final GlobalKey _measureKey = GlobalKey();
  double? _naturalWidth;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
  }

  void _measure() {
    final RenderBox? box = _measureKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final double width = box.size.width;
    if (!mounted || width == _naturalWidth) return;
    setState(() => _naturalWidth = width);
  }

  /// 幅が痩せたことを1度だけ記録する。
  ///
  /// `LayoutBuilder` は再ビルドのたびに走るので、**ここで自前の番人を持たないと
  /// 1画面ぶんで何度も呼ばれる**([Telemetry] 側の間引きは種類×鍵の単位なので、
  /// 鍵が同じなら結局落ちるが、無駄な呼び出しは手前で止める)。
  bool _reportedNarrow = false;

  void _reportIfTooNarrow(BuildContext context, double available) {
    // 比べる相手は「この端末で取れるはずの幅」。340pt をそのまま閾値にすると、
    // iPhone SE(実効327pt)では**当たり前に下回って毎回飛ぶ**。
    final double expected = BoardStyle.expectedWidth(MediaQuery.sizeOf(context).width);
    if (_reportedNarrow || available >= expected) return;
    _reportedNarrow = true;
    Telemetry.report(
      DegradationEvent.boardTooNarrow(availableWidth: available, assumedWidth: expected),
    );
  }

  Widget _math({Key? key, double fontSize = BoardStyle.latexFontSize}) => Math.tex(
    widget.tex,
    key: key,
    mathStyle: MathStyle.display,
    textStyle: TextStyle(fontSize: fontSize, color: BoardStyle.chalk),
    onErrorFallback: (FlutterMathException error) => Text(
      '数式を表示できません',
      style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppColors.hole),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double available = constraints.maxWidth;
        final double? natural = _naturalWidth;

        // 板書に使える幅を、**この端末で取れるはずの幅**と比べる。
        //
        // **縮小率の下限(70%)は幅を基準に決めた値**なので、幅が痩せると
        // 「収まると確認した式」まで横スクロールに落ちる。実際、授業の外で板書を
        // 出したとき、カードに入れた時点で 311pt まで落ちていた(カルテの
        // `_BoardSection` のコメント)。見た目では気づけないので、幅そのものを見張る。
        _reportIfTooNarrow(context, available);

        // 計測用。画面には出さず(不透明度0)、`OverflowBox` で制約を外して
        // 「自然な幅なら何ptか」を測るためだけに存在する。
        final Widget measurer = Positioned.fill(
          child: IgnorePointer(
            child: ExcludeSemantics(
              child: Opacity(
                opacity: 0,
                child: OverflowBox(
                  minWidth: 0,
                  maxWidth: double.infinity,
                  alignment: Alignment.centerLeft,
                  child: _math(key: _measureKey),
                ),
              ),
            ),
          ),
        );

        if (natural == null) {
          // 計測が終わるまでは高さだけ確保して待つ(積み上がる位置がガタつかないように)。
          return SizedBox(
            height: BoardStyle.latexFontSize * 1.6,
            child: Stack(children: <Widget>[measurer]),
          );
        }

        if (natural <= available) {
          return Stack(children: <Widget>[_math(), measurer]);
        }

        final double scale = available / natural;
        if (scale >= BoardStyle.latexMinScale) {
          return SizedBox(
            width: available,
            child: Stack(
              children: <Widget>[
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: _math(),
                ),
                measurer,
              ],
            ),
          );
        }

        // 70%を下回る。理由はクラスコメント参照。
        //
        // **これは agent 側の分割が効いていないことのシグナル**(計画書 §3-6b の
        // 宿題そのもの)。以前は `debugPrint` にしか出ておらず、本番では
        // 「分割が機能していないことに永遠に気づけない」状態だった(§10-7)。
        //
        // 間引きは式ごと(この層は `board_id` を知らない)。同じ式が
        // 何度描き直されても1件で、別の式なら別件として飛ぶ。
        // `tex` を切るのは `DegradationEvent` の内側。全文を渡してよい。
        Telemetry.report(
          DegradationEvent.latexScaleFloor(
            tex: widget.tex,
            scale: scale,
            minScale: BoardStyle.latexMinScale,
            availableWidth: available,
            naturalWidth: natural,
          ),
        );
        // Transform.scaleではなく、フォントサイズそのものを70%にして描き直す。
        // Transformは描画だけを縮小してレイアウト上の幅は元のままなので、
        // 横スクロールの範囲に縮小分の空白が残ってしまう。フォントサイズを
        // 直接変えれば、スクロール範囲も縮小後の見た目どおりの幅になる。
        return SizedBox(
          width: available,
          child: Stack(
            children: <Widget>[
              _ScrollWithEdgeFade(
                child: _math(fontSize: BoardStyle.latexFontSize * BoardStyle.latexMinScale),
              ),
              measurer,
            ],
          ),
        );
      },
    );
  }
}

/// 横スクロールに、右端の「まだ続きがある」フェードを重ねたもの。
///
/// 判定基準は「スクロールできること」ではなく**「スクロールできると分かること」**。
/// 最後まで見えたらフェードは消える(まだ続きがあるという嘘を出さないため)。
class _ScrollWithEdgeFade extends StatefulWidget {
  const _ScrollWithEdgeFade({required this.child});

  final Widget child;

  @override
  State<_ScrollWithEdgeFade> createState() => _ScrollWithEdgeFadeState();
}

class _ScrollWithEdgeFadeState extends State<_ScrollWithEdgeFade> {
  final ScrollController _controller = ScrollController();

  // 計測前は「続きがあるかもしれない」を既定にする。無い場合よりも
  // 過剰に手がかりを出すほうが、案Bの問題(気づかせない)よりまだ安全なため。
  bool _hasMore = true;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_updateHasMore);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateHasMore());
  }

  void _updateHasMore() {
    if (!_controller.hasClients) return;
    final bool hasMore = _controller.position.maxScrollExtent - _controller.position.pixels > 1;
    if (hasMore == _hasMore || !mounted) return;
    setState(() => _hasMore = hasMore);
  }

  @override
  void dispose() {
    _controller.removeListener(_updateHasMore);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        SingleChildScrollView(
          controller: _controller,
          scrollDirection: Axis.horizontal,
          child: widget.child,
        ),
        if (_hasMore)
          const Positioned(
            top: 0,
            bottom: 0,
            right: 0,
            child: IgnorePointer(child: _EdgeFade()),
          ),
      ],
    );
  }
}

/// 右端のフェード本体。
///
/// **色は既存トークンの範囲内**(`AppColors.background`。透明から不透明へ)。
/// この幅の帯だけ数式の最後の数文字が薄れて見えるが、「切れている」ことを
/// 積極的に示す方が「これで全部だ」という誤読より安全と判断した。
///
/// 板書がこのアプリの `AppColors.background`(Scaffoldの地)に直接乗る前提の色。
/// 将来カードの上に板書を置く設計に変えるなら、ここも `AppColors.surface` 等に
/// 合わせて直す必要がある(既知の前提としてここに書いておく)。
class _EdgeFade extends StatelessWidget {
  const _EdgeFade();

  static const double _width = 28;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: _width,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            // 色そのものは AppColors.background から作る(新しい色を定義しない)。
            // alpha:0 は「その色の透明版」であって別の色ではない。
            colors: <Color>[BoardStyle.surface.withValues(alpha: 0), BoardStyle.surface],
          ),
        ),
      ),
    );
  }
}
