import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_speech.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Board narration, in a form compatible with "do not read formulas aloud".
///
/// The board is drawn with `Math.tex` and `CustomPaint`, so VoiceOver reads not
/// one character of it. The board is the heart of the product, so missing it
/// means a blind student has no lesson at all.
///
/// What is checked is not perfect narration but that it makes sense:
///   - structure (fractions, roots, exponents, subscripts) becomes words
///   - symbols are not skipped
///   - Latin letters stay as they are (a screen reader reads them per its locale,
///     and spelling them out here would double them up)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  group('数式', () {
    test('指数が「の2乗」になる(記号のままだと読み飛ばされる)', () {
      expect(describeTex('x^2 - 3x + 2 = 0', ja), 'x の 2 乗 マイナス 3x プラス 2 イコール 0');
    });

    /// Japanese states the denominator first. Reading it in English order swaps
    /// numerator and denominator to the ear.
    test('分数は日本語だけ順序が逆になる', () {
      expect(describeTex(r'\frac{a}{b}', ja), 'b 分の a');
      expect(describeTex(r'\frac{a}{b}', en), 'a over b');
    });

    test('入れ子の分数も内側から畳める', () {
      expect(describeTex(r'\frac{\frac{a}{b}}{c}', ja), 'c 分の b 分の a');
    });

    test('根号', () {
      expect(describeTex(r'\sqrt{2}', ja), 'ルート 2');
      expect(describeTex(r'\sqrt[3]{8}', ja), '3 乗根 8');
      expect(describeTex(r'\sqrt{2}', en), 'square root of 2');
    });

    test('判別式(fixtureと同じ式)が意味の通る文になる', () {
      expect(
        describeTex(r'D = (-3)^2 - 4 \cdot 1 \cdot 2 = 9 - 8 = 1', ja),
        'D イコール かっこ マイナス 3 かっことじ の 2 乗 マイナス 4 かける 1 かける 2 イコール 9 マイナス 8 イコール 1',
      );
    });

    test('書体の指定は読み上げに出ない(教科書記法のP・C)', () {
      expect(describeTex(r'{}_{n}\mathrm{P}_{r}', ja), 'の 添字 n P の 添字 r');
    });

    test('ベクトル', () {
      expect(describeTex(r'\overrightarrow{AB}', ja), 'ベクトル AB');
    });

    /// Latin letters stay as they are; they are never spelled out.
    test('英字は書き換えない(スクリーンリーダーが読む)', () {
      expect(describeTex('y = ax + b', ja), contains('y'));
      expect(describeTex('y = ax + b', ja), isNot(contains('ワイ')));
    });

    test('未知のコマンドが残ってもゴミを読み上げない', () {
      // Non-whitelisted commands should never get here, but if they do they are
      // not narrated as raw backslash commands.
      expect(describeTex(r'\unknowncmd{x}', ja), isNot(contains(r'\')));
    });
  });

  group('図形は「何が描かれているか」で足りる', () {
    test('三角形は頂点と印を読む', () {
      const BoardElement element = BoardElement.triangle(
        vertices: <BoardPoint>[
          BoardPoint(x: 0, y: 0),
          BoardPoint(x: 4, y: 0),
          BoardPoint(x: 0, y: 3),
        ],
        labels: <String>['A', 'B', 'C'],
        marks: <AngleMark>[
          AngleMark(vertex: 0, kind: AngleMarkKind.rightAngle),
          AngleMark(vertex: 1, kind: AngleMarkKind.angle, label: 'θ'),
        ],
      );

      final String said = describeElement(element, ja);
      expect(said, contains('三角形 ABC'));
      expect(said, contains('頂点 A は直角'));
      expect(said, contains('頂点 B の角は θ'));
    });

    test('円は半径とラベルを読む', () {
      const BoardElement element = BoardElement.circle(
        center: BoardPoint(x: 0, y: 0),
        r: 5,
        labels: <String>['O', 'r = 5'],
      );

      // The radius is not narrated as "5.0"; integers stay integers.
      expect(describeElement(element, ja), contains('半径 5。'));
    });

    test('グラフは式と範囲と印を読む', () {
      const BoardElement element = BoardElement.plot(
        fn: 'x^2 - 3*x + 2',
        domain: BoardDomain(min: -1, max: 4),
        marks: <PlotMark>[
          PlotMark(at: BoardPoint(x: 1, y: 0), label: 'x = 1'),
          PlotMark(at: BoardPoint(x: 2, y: 0), label: 'x = 2'),
        ],
      );

      final String said = describeElement(element, ja);
      expect(said, contains('x の範囲は -1 から 4'));
      expect(said, contains('x = 1、x = 2'));
    });

    /// A prose line (a `text` element) reads as it is.
    test('text要素は素通し', () {
      expect(describeElement(const BoardElement.text(body: 'a = 1, b = -3'), ja), 'a = 1, b = -3');
    });
  });

  group('英語ロケール', () {
    test('図形の説明も英語になる', () {
      const BoardElement element = BoardElement.circle(
        center: BoardPoint(x: 0, y: 0),
        r: 5,
        labels: <String>['O'],
      );

      expect(describeElement(element, en), contains('A circle with radius 5'));
    });
  });
}
