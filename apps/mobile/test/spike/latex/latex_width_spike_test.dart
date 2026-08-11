// SPIKE(板書レイヤー W1・追加分): 実機幅での溢れ実測。使い捨て。
//
// team-leadの指摘: 前回のスパイク(latex_spike_test.dart)はCanvas幅800pxで撮っており、
// これはiPhoneの論理幅(393pt)より倍以上広い。「幅が足りず溢れる」は
// テスト側の不備ではなく実機で必ず当たる仕様、という指摘を受けての再実測。
//
// ここでやること:
//   1. iPhone 15 論理幅393ptから板書の余白を引いた実効幅(340pt。team-lead指定)を
//      赤い縦線で入れて、各式が線を超えるかを目視で判定する
//   2. tester.getSize() で実測ピクセル幅も取り、目視と数値の両方で判定する
//   3. 溢れが確認された式について、A(FittedBox縮小)/B(横スクロール)/C(分割) を比較する
//
// 既存の test/golden/ には混ぜない。harness.dart は変更しない(指示どおり)。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';

/// iPhone 15 論理幅(393pt)から板書の余白を引いた実効幅。team-leadの見積もり。
/// 板書コンテナの正式なpadding設計はまだ無いので、この数値はあくまで
/// 「これより狭くはならないはず」の上限側の見積もりとして扱う
/// (実際のコンテナにカードの内側paddingが乗れば、実効幅はもっと狭くなる)。
const double kEffectiveWidth = 340;

/// [latex_spike_test.dart] の `loadAppFonts()` と同じ理由で、
/// `packages/xxx/` プレフィックスを剥がさずに登録する。
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

  /// ラベル + 数式 + 実効幅の目印(赤い縦線)。
  /// Row/Expandedを使わない(前回それがRenderFlexのoverflow assertionを誘発した)。
  /// Math widgetは制約なしで自然な幅に育たせ、その上に赤い線を重ねて
  /// 「線を超えたら実機で溢れる」を可視化する。
  Widget measureRow(String label, String tex, Key mathKey, {double fontSize = 24}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: const TextStyle(fontSize: 12, color: Colors.black54, fontFamily: 'ZenMaruGothic'),
          ),
          const SizedBox(height: 2),
          Stack(
            children: <Widget>[
              Math.tex(
                tex,
                key: mathKey,
                mathStyle: MathStyle.display,
                textStyle: TextStyle(fontSize: fontSize, color: Colors.black),
                onErrorFallback: (FlutterMathException e) =>
                    Text('ERROR: ${e.message}', style: const TextStyle(color: Colors.red, fontSize: 12)),
              ),
              // 実効幅の目印。これより右は実機の板書エリアからはみ出す。
              Positioned(
                left: kEffectiveWidth,
                top: 0,
                bottom: 0,
                child: Container(width: 2, color: Colors.red.withValues(alpha: 0.7)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> capture(
    WidgetTester tester,
    String goldenName,
    List<Widget> rows, {
    Size size = const Size(1000, 1200),
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
          body: Padding(
            padding: const EdgeInsets.all(16),
            child: SingleChildScrollView(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: rows),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/$goldenName.png'));
  }

  // 式一覧: 既存の代表式 + team-lead指定の「長くなりがちな式」。
  // key で個別に幅を測る。
  const Map<String, String> expressions = <String, String>{
    '解の公式': r'x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}',
    '底の変換': r'\log_{a}b = \frac{\log_{c}b}{\log_{c}a}',
    '二項定理': r'(x+y)^n = \sum_{k=0}^{n} {}_{n}\mathrm{C}_{k}\, x^{n-k} y^{k}',
    '加法定理': r'\sin(\alpha+\beta) = \sin\alpha\cos\beta + \cos\alpha\sin\beta',
    '3次因数分解': r'x^3 - 6x^2 + 11x - 6 = (x-1)(x-2)(x-3)',
    '展開途中式': r'(x+2)(x-3)(x+1) = x^3 - 7x - 6',
    '連立方程式1行': r'x + y = 5,\quad x - y = 1',
    '定積分の計算途中': r'\int_0^1 (3x^2 + 2x)\,dx = \Bigl[x^3 + x^2\Bigr]_0^1 = 2',
    'よって(therefore)': r'\therefore x = 2',
    'なぜなら(because)': r'y = 3 \quad (\because x = 2)',
    'よって(text代替)': r'\text{よって}\ x = 2',
  };

  final Map<String, Key> keys = <String, Key>{
    for (final String label in expressions.keys) label: ValueKey<String>(label),
  };

  testWidgets('実効幅340pt上での溢れ判定(全式)', (WidgetTester tester) async {
    await capture(
      tester,
      'width_check_all',
      <Widget>[
        for (final MapEntry<String, String> e in expressions.entries)
          measureRow(e.key, e.value, keys[e.key]!),
      ],
      size: const Size(1000, 1400),
    );

    // ignore: avoid_print
    print('=== 実測幅(pt)。実効幅 $kEffectiveWidth pt との比較 ===');
    for (final String label in expressions.keys) {
      final Size size = tester.getSize(find.byKey(keys[label]!));
      final bool overflow = size.width > kEffectiveWidth;
      // ignore: avoid_print
      print(
        '${overflow ? "溢れる" : "収まる"}\t${size.width.toStringAsFixed(1)}pt\t$label',
      );
    }
  });

  // --- 溢れが予想される式について、A/B/Cを比較する ---
  // 対象は上の実測結果から選ぶ(「3次因数分解」「二項定理」「定積分の計算途中」を仮に想定)。

  Widget optionLabel(String text) => Padding(
    padding: const EdgeInsets.only(top: 16, bottom: 4),
    child: Text(
      text,
      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, fontFamily: 'ZenMaruGothic'),
    ),
  );

  Widget boardEdgeMarker() => Container(
    height: 2,
    width: kEffectiveWidth,
    color: Colors.red.withValues(alpha: 0.4),
  );

  testWidgets('A: FittedBoxで自動縮小', (WidgetTester tester) async {
    // 実測(§実効幅340pt上での溢れ判定)で実際に溢れた式だけを対象にする。
    // 二項定理(269.9pt)は収まっていたので対象から外した。
    final Map<String, String> targets = <String, String>{
      '加法定理': expressions['加法定理']!,
      '3次因数分解': expressions['3次因数分解']!,
      '展開途中式': expressions['展開途中式']!,
      '定積分の計算途中': expressions['定積分の計算途中']!,
    };

    await capture(
      tester,
      'option_a_fittedbox',
      <Widget>[
        for (final MapEntry<String, String> e in targets.entries) ...<Widget>[
          optionLabel('${e.key}(実効幅 $kEffectiveWidth pt に収めた場合)'),
          boardEdgeMarker(),
          SizedBox(
            width: kEffectiveWidth,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Math.tex(
                e.value,
                mathStyle: MathStyle.display,
                textStyle: const TextStyle(fontSize: 24, color: Colors.black),
              ),
            ),
          ),
        ],
      ],
      size: const Size(500, 1100),
    );
  });

  testWidgets('B: 横スクロール(見た目上、はみ出た部分は隠れる)', (WidgetTester tester) async {
    final Map<String, String> targets = <String, String>{
      '3次因数分解': expressions['3次因数分解']!,
      '加法定理': expressions['加法定理']!,
    };

    await capture(
      tester,
      'option_b_scroll',
      <Widget>[
        for (final MapEntry<String, String> e in targets.entries) ...<Widget>[
          optionLabel('${e.key}(実効幅 $kEffectiveWidth pt のビューポート。スクロールする前の見え方)'),
          boardEdgeMarker(),
          ClipRect(
            child: SizedBox(
              width: kEffectiveWidth,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Math.tex(
                  e.value,
                  mathStyle: MathStyle.display,
                  textStyle: const TextStyle(fontSize: 24, color: Colors.black),
                ),
              ),
            ),
          ),
        ],
      ],
      size: const Size(500, 700),
    );
  });

  // team-leadの依頼: 「どこまで縮めたら読めなくなるか」の限界を実測する。
  // 今回の実測(§実効幅340pt上での溢れ判定)で出てきた溢れ幅はどれも
  // 340/自然幅 = 0.76〜0.97 の範囲で、縮小率としては軽い。もっと極端に
  // 長い式(4次式の展開)を用意し、340ptに詰めたときと、さらに厳しい
  // 200pt・150ptの箱に詰めたときを並べて、どこで読めなくなるかを見る。
  testWidgets('A-2: FittedBoxの縮小限界(意図的に長い式)', (WidgetTester tester) async {
    const String longExpr =
        r'(x+1)(x+2)(x+3)(x+4) = x^4 + 10x^3 + 35x^2 + 50x + 24';
    const Key naturalKey = ValueKey<String>('long-natural');

    await tester.binding.setSurfaceSize(const Size(1200, 900));
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() async {
      await tester.binding.setSurfaceSize(null);
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    Widget boxed(double width) => Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            '幅 ${width.toStringAsFixed(0)}pt に収めた場合',
            style: const TextStyle(fontSize: 12, color: Colors.black54, fontFamily: 'ZenMaruGothic'),
          ),
          Container(height: 2, width: width, color: Colors.red.withValues(alpha: 0.4)),
          SizedBox(
            width: width,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Math.tex(
                longExpr,
                mathStyle: MathStyle.display,
                textStyle: const TextStyle(fontSize: 24, color: Colors.black),
              ),
            ),
          ),
        ],
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          backgroundColor: Colors.white,
          body: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Text(
                  '素の自然幅(制約なし)',
                  style: TextStyle(fontSize: 12, color: Colors.black54, fontFamily: 'ZenMaruGothic'),
                ),
                Math.tex(
                  longExpr,
                  key: naturalKey,
                  mathStyle: MathStyle.display,
                  textStyle: const TextStyle(fontSize: 24, color: Colors.black),
                ),
                const SizedBox(height: 20),
                boxed(kEffectiveWidth),
                boxed(200),
                boxed(150),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final double naturalWidth = tester.getSize(find.byKey(naturalKey)).width;
    // ignore: avoid_print
    print('=== 意図的に長い式(4次式の展開)===');
    // ignore: avoid_print
    print('自然幅 = ${naturalWidth.toStringAsFixed(1)}pt');
    for (final double w in <double>[kEffectiveWidth, 200, 150]) {
      final double scale = w / naturalWidth;
      final double effectiveFontSize = 24 * scale;
      // ignore: avoid_print
      print(
        '幅${w.toStringAsFixed(0)}ptに収めた場合: scale=${(scale * 100).toStringAsFixed(0)}% '
        '実効フォントサイズ≈${effectiveFontSize.toStringAsFixed(1)}pt',
      );
    }

    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/option_a2_fittedbox_limit.png'));
  });

  testWidgets('C: 手順を分割して2行にする', (WidgetTester tester) async {
    await capture(
      tester,
      'option_c_split',
      <Widget>[
        optionLabel('3次因数分解を2手順に分割(実効幅 $kEffectiveWidth pt)'),
        boardEdgeMarker(),
        Math.tex(
          r'x^3 - 6x^2 + 11x - 6',
          mathStyle: MathStyle.display,
          textStyle: const TextStyle(fontSize: 24, color: Colors.black),
        ),
        const SizedBox(height: 4),
        Math.tex(
          r'{} = (x-1)(x-2)(x-3)',
          mathStyle: MathStyle.display,
          textStyle: const TextStyle(fontSize: 24, color: Colors.black),
        ),
        optionLabel('加法定理を2手順に分割(実効幅 $kEffectiveWidth pt)'),
        boardEdgeMarker(),
        Math.tex(
          r'\sin(\alpha+\beta)',
          mathStyle: MathStyle.display,
          textStyle: const TextStyle(fontSize: 24, color: Colors.black),
        ),
        const SizedBox(height: 4),
        Math.tex(
          r'{} = \sin\alpha\cos\beta + \cos\alpha\sin\beta',
          mathStyle: MathStyle.display,
          textStyle: const TextStyle(fontSize: 24, color: Colors.black),
        ),
      ],
      size: const Size(500, 900),
    );
  });
}
