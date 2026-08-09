import 'dart:math' as math;

import 'package:ai_sensei/src/features/session/presentation/board/plot_expression.dart';
import 'package:flutter_test/flutter_test.dart';

/// `PlotExpression` は板書の関数グラフを直接左右する(誤った評価は
/// 誤ったグラフとして描画され、golden画像を見ても気づきにくい)。
/// 描画に混ぜる前に、数値そのものを検算しておく。
void main() {
  double eval(String fn, double x) => PlotExpression.parse(fn).evaluate(x);

  test('四則演算の優先順位', () {
    expect(eval('2 + 3 * 4', 0), 14);
    expect(eval('(2 + 3) * 4', 0), 20);
    expect(eval('10 - 2 - 3', 0), 5); // 左結合
    expect(eval('2 * 3 - 1', 0), 5);
  });

  test('累乗', () {
    expect(eval('x^2', 3), 9);
    expect(eval('2^3', 0), 8);
    expect(eval('-x^2', 3), -9); // 単項マイナスより ^ が強い(標準的な数学の慣習)
  });

  test('変数x', () {
    expect(eval('x^2 - 3*x + 2', 1), 0);
    expect(eval('x^2 - 3*x + 2', 2), 0);
    expect(eval('x^2 - 3*x + 2', 0), 2);
  });

  test('三角関数(ラジアン)', () {
    expect(eval('sin(x)', 0), closeTo(0, 1e-9));
    expect(eval('cos(x)', 0), closeTo(1, 1e-9));
    expect(eval('sin(x)', math.pi / 2), closeTo(1, 1e-9));
  });

  test('sqrt・abs', () {
    expect(eval('sqrt(x)', 4), 2);
    expect(eval('abs(x)', -5), 5);
    expect(eval('sqrt(x)', -1).isNaN, isTrue); // 定義域外はNaN(呼び出し側が弾く)
  });

  test('log・ln・exp', () {
    expect(eval('log(x)', 100), closeTo(2, 1e-9)); // 常用対数(底10)
    expect(eval('ln(x)', math.e), closeTo(1, 1e-9)); // 自然対数
    expect(eval('exp(x)', 0), 1);
  });

  test('pi定数', () {
    expect(eval('pi', 0), closeTo(math.pi, 1e-12));
    expect(eval('sin(pi)', 0), closeTo(0, 1e-9));
  });

  test('括弧とネスト', () {
    expect(eval('sin(x^2)', math.sqrt(math.pi / 2)), closeTo(1, 1e-6));
    expect(eval('sqrt(x^2 + 1)', 0), 1);
  });

  test('空白は無視する', () {
    expect(eval('  x ^ 2  +  1  ', 2), 5);
  });

  test('契約が許さない文字は例外(壊れた入力を壊れているまま通さない)', () {
    expect(() => PlotExpression.parse('x + tan2(x)'), throwsFormatException);
    expect(() => PlotExpression.parse('x +'), throwsFormatException);
    expect(() => PlotExpression.parse('e^x'), throwsFormatException); // 契約上 e は使えない
    expect(() => PlotExpression.parse('x & 1'), throwsFormatException);
  });
}
