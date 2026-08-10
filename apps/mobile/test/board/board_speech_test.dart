import 'package:ai_sensei/src/features/session/domain/board.dart';
import 'package:ai_sensei/src/features/session/presentation/board/board_speech.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// 板書の読み上げ(計画書 §3-1 と両立する形)。
///
/// 板書は `Math.tex` と `CustomPaint` で描かれていて、そのままでは
/// **VoiceOver から1文字も読まれない**。板書はプロダクトの中心なので、
/// そこが欠けると目が見えない生徒には**授業が存在しないのと同じ**になる。
///
/// ここで見ているのは「完璧な読み上げ」ではなく、**意味が通ること**:
///   - 構造(分数・根号・指数・添字)が言葉になっていること
///   - 記号が読み飛ばされないこと
///   - **英字はそのまま残る**こと(スクリーンリーダーがロケールなりに読むので、
///     こちらで「エックス」と書くと二重に読まれる)
void main() {
  const AppStrings ja = AppStrings(Locale('ja'));
  const AppStrings en = AppStrings(Locale('en'));

  group('数式', () {
    test('指数が「の2乗」になる(記号のままだと読み飛ばされる)', () {
      expect(describeTex('x^2 - 3x + 2 = 0', ja), 'x の 2 乗 マイナス 3x プラス 2 イコール 0');
    });

    /// **日本語は「B分のA」で順序が逆になる。** 英語と同じ順に読むと
    /// 分母と分子が入れ替わって聞こえる。
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

    /// **英字はそのまま残す。** 「エックス」と書き換えない。
    test('英字は書き換えない(スクリーンリーダーが読む)', () {
      expect(describeTex('y = ax + b', ja), contains('y'));
      expect(describeTex('y = ax + b', ja), isNot(contains('ワイ')));
    });

    test('未知のコマンドが残ってもゴミを読み上げない', () {
      // ホワイトリスト外は本来ここまで来ないが、来ても `\hoge` とは読ませない。
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

      // 半径が「5.0」と読まれない(整数はそのまま)。
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

    /// 日本語の一行(`text` 要素)は、そのまま読める。
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
