// SPIKE(板書レイヤー W1): flutter_math_fork の実測用。使い捨て。
//
// 目的は「テストが通るか」ではなく「PNGを人間の目で見て崩れていないか」。
// なので golden比較(matchesGoldenFile の一致判定)は使わず、
// --update-goldens で常に上書き保存させて Read ツールで確認する運用にする。
// 既存の test/golden/ の運用(CIのLinuxを正とする一致判定)とは別物なので混ぜない。
//
// 採否判断がついたら、このディレクトリごと削除してよい。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/harness.dart';

/// [loadAppFonts] は `packages/xxx/Family` のプレフィックスを剥がして
/// 素の family 名で登録する(このアプリ自身のZenMaruGothic用の割り切り)。
///
/// flutter_math_fork はKaTeXフォントを自分のコード内で
/// `'packages/flutter_math_fork/KaTeX_Main'` という**プレフィックス込みの
/// family名**で参照している(make_symbol.dart:140)。プレフィックスを
/// 剥がして登録すると widget が要求する family と一致せず、
/// フォントが見つからないまま(= 文字化け/黒塗り四角)で描画される。
/// このスパイクでは剥がさずにそのまま登録する。
Future<void> _loadPackageFonts() async {
  final String manifest = await rootBundle.loadString('FontManifest.json');
  for (final dynamic entry in jsonDecode(manifest) as List<dynamic>) {
    final Map<String, dynamic> family = entry as Map<String, dynamic>;
    final String name = family['family'] as String;
    final FontLoader loader = FontLoader(name);
    for (final dynamic font in family['fonts'] as List<dynamic>) {
      loader.addFont(rootBundle.load((font as Map<String, dynamic>)['asset'] as String));
    }
    await loader.load();
  }
}

void main() {
  setUpAll(_loadPackageFonts);

  /// 1つの式を「ラベル + 数式」の行として描く。
  /// エラー時は KaTeX ではなく赤文字で理由を出す(崩れを見逃さないため)。
  Widget row(String label, String tex, {double fontSize = 24}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          SizedBox(
            width: 160,
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 13,
                color: Colors.black54,
                fontFamily: 'ZenMaruGothic',
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Math.tex(
              tex,
              mathStyle: MathStyle.display,
              textStyle: TextStyle(fontSize: fontSize, color: Colors.black),
              onErrorFallback: (FlutterMathException e) => Text(
                'ERROR: ${e.message}',
                style: const TextStyle(color: Colors.red, fontSize: 12),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> capture(
    WidgetTester tester,
    String goldenName,
    List<Widget> rows, {
    Size size = const Size(800, 1400),
  }) async {
    await tester.binding.setSurfaceSize(size);
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() async {
      await tester.binding.setSurfaceSize(null);
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          backgroundColor: Colors.white,
          body: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: rows),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('goldens/$goldenName.png'),
    );
  }

  testWidgets('group1: 分数・根号・指数・添字・二次方程式・不等式', (WidgetTester tester) async {
    await capture(tester, 'group1_basics', <Widget>[
      row('分数', r'\frac{1}{2}'),
      row('繁分数', r'1+\cfrac{1}{1+\cfrac{1}{x}}'),
      row('平方根', r'\sqrt{2}'),
      row('累乗根', r'\sqrt[3]{8}'),
      row('有理数指数', r'x^{\frac{2}{3}}'),
      row('負の指数', r'x^{-2}'),
      row('添字', r'a_{n}'),
      row('解の公式', r'x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}'),
      row('判別式', r'D = b^2 - 4ac'),
      row('絶対値', r'|x - 3| < 5'),
      row('連立不等式', r'-2 \leq x < 5'),
    ]);
  });

  testWidgets('group2: 三角関数・対数', (WidgetTester tester) async {
    await capture(
      tester,
      'group2_trig_log',
      <Widget>[
        row('三角比', r'\sin\theta,\ \cos\theta,\ \tan\theta'),
        row(
          '加法定理',
          r'\sin(\alpha+\beta) = \sin\alpha\cos\beta + \cos\alpha\sin\beta',
          fontSize: 20,
        ),
        row('弧度法', r'\theta = \frac{\pi}{3}'),
        row('対数', r'\log_{2}8 = 3'),
        row('底の変換', r'\log_{a}b = \frac{\log_{c}b}{\log_{c}a}'),
      ],
      size: const Size(1000, 1000),
    );
  });

  testWidgets('group3: 数列・順列組合せ', (WidgetTester tester) async {
    await capture(tester, 'group3_sequences_combinatorics', <Widget>[
      row('漸化式添字', r'a_{n+1} = a_n + d'),
      row('シグマ', r'\sum_{k=1}^{n} k = \frac{n(n+1)}{2}'),
      row('階差数列', r'b_n = a_{n+1}-a_n'),
      row('漸化式', r'a_{n+1} = 2a_n + 1'),
      row('順列(教科書記法)', r'{}_{n}\mathrm{P}_{r} = \frac{n!}{(n-r)!}'),
      row('組合せ(教科書記法)', r'{}_{n}\mathrm{C}_{r} = \frac{n!}{r!(n-r)!}'),
      row('二項定理', r'(x+y)^n = \sum_{k=0}^{n} {}_{n}\mathrm{C}_{k}\, x^{n-k} y^{k}'),
      // 教科書記法が崩れた場合の代替候補として比較用に併記する。
      row('順列(代替: 前置)', r'{}^{n}P_{r}'),
      row('組合せ(代替: binom)', r'\binom{n}{r}'),
    ]);
  });

  testWidgets('group4: ベクトル・微積分', (WidgetTester tester) async {
    await capture(tester, 'group4_vectors_calculus', <Widget>[
      row('ベクトル', r'\vec{a}'),
      row('有向線分AB', r'\overrightarrow{\mathrm{AB}}'),
      row('内積', r'\vec{a}\cdot\vec{b} = |\vec{a}||\vec{b}|\cos\theta'),
      row('極限', r'\lim_{x \to 0} \frac{\sin x}{x} = 1'),
      row('微分', r'\frac{dy}{dx}'),
      row('定積分', r'\int_{a}^{b} f(x)\,dx'),
    ]);
  });

  testWidgets('group5: 行列・場合分け・複素数', (WidgetTester tester) async {
    await capture(tester, 'group5_matrix_cases_complex', <Widget>[
      row(
        '行列',
        r'\begin{pmatrix} a & b \\ c & d \end{pmatrix}',
        fontSize: 24,
      ),
      row(
        '場合分け',
        r'f(x) = \begin{cases} x^2 & (x \geq 0) \\ -x^2 & (x < 0) \end{cases}',
        fontSize: 22,
      ),
      row('複素数', r'z = a + bi'),
      row('極形式', r'z = r(\cos\theta + i\sin\theta)'),
    ]);
  });

  // レンダリング速度の感触用: 1画面に20個積んだときの pump コストを見る。
  // 秒数だけを記録する(厳密な性能測定ではなく、体感の目安)。
  testWidgets('group6: 20個積んだときの体感速度', (WidgetTester tester) async {
    final Stopwatch sw = Stopwatch()..start();
    await capture(
      tester,
      'group6_stack_20',
      List<Widget>.generate(
        20,
        (int i) => row('手順 ${i + 1}', r'x^2 + ' '$i' r'x - ' '${i + 1}' r' = 0', fontSize: 20),
      ),
      size: const Size(800, 2400),
    );
    sw.stop();
    // ignore: avoid_print
    print('SPIKE: 20個積んだ pump+capture の所要時間 = ${sw.elapsedMilliseconds}ms');
  });
}
