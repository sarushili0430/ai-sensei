import 'package:flutter/material.dart';

/// デザイントークン(handoff §7 ビジュアル方針)。
///
/// Duolingoの「文法」は借りるが「語彙」は借りない。
/// ストリーク・厚みのあるボタン・キャラの感情リアクションは採用し、
/// XP/リーグ/正誤スコア/緑フクロウ的なトレードドレスは採用しない。
abstract final class AppColors {
  /// 主役・行動・先輩。
  static const Color blue = Color(0xFF0EA5E9);

  /// 言えたこと(蛍光マーカー・黄)。
  static const Color said = Color(0xFFFFD93B);

  /// 穴(蛍光マーカー・ピンク)。失点ではなく「これから埋まる場所」。
  static const Color hole = Color(0xFFFF7AA8);

  /// 連続日数・祝福。
  static const Color streak = Color(0xFFFF9F1C);

  /// 本文。真っ黒にしない。
  static const Color ink = Color(0xFF33323D);
  static const Color inkMuted = Color(0xFF7A7887);

  static const Color surface = Color(0xFFFFFFFF);
  static const Color background = Color(0xFFFBFAF7);
  static const Color border = Color(0xFFE6E3DC);

  /// 祝福画面の地。連続日数の色をほんのり敷いた、暖かい地。
  ///
  /// **画面の地は必ず不透明にする。** `streak.withValues(alpha: 0.08)` を
  /// そのまま `Scaffold` に渡すと、地が92%透ける。遷移中は下のルートが
  /// 透けて見えるので正しく見えるが、遷移が終わって下のルートがツリーから
  /// 外れた瞬間、透けた先には**何も無くなる**(端末の地の色 = 黒)。
  /// 本文は [ink](ほぼ黒)なので黒に沈み、画面全体が真っ黒で固まったように見える。
  /// 敷きたいのは色であって透明度ではないので、先に混ぜて不透明の色にする。
  static final Color celebration = Color.alphaBlend(
    streak.withValues(alpha: 0.08),
    background,
  );
}

abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
}

abstract final class AppRadius {
  static const double button = 16;
  static const double card = 20;
  static const double chip = 999;
}

/// 厚みのあるボタンの「沈み込み」量。触感の主役。
abstract final class AppElevation {
  static const double chunkyDepth = 4;
}

abstract final class AppDurations {
  static const Duration tap = Duration(milliseconds: 90);
  static const Duration reaction = Duration(milliseconds: 220);
  static const Duration celebrate = Duration(milliseconds: 600);

  /// 画面に入ってくるとき(要素1つぶん)。
  static const Duration enter = Duration(milliseconds: 320);

  /// 段差。次の要素が現れるまでの待ち。
  /// 全部が同時に現れると、読む順序が消える。
  static const Duration stagger = Duration(milliseconds: 70);

  /// 蛍光マーカーを引く速さ。ペン先が走る時間そのもの。
  static const Duration draw = Duration(milliseconds: 420);

  /// 先輩の呼吸。まばたきもこの周期から作る。
  static const Duration breath = Duration(milliseconds: 3400);

  /// 1文字ぶんのタイプ速度(先輩のせりふ)。
  static const Duration typeChar = Duration(milliseconds: 45);

  /// 「長押しして説明する」を、説明したことにする長さ。
  ///
  /// これは装飾ではなく**操作の時間**なので、
  /// アニメーションを減らす設定でも短くしない。
  static const Duration hold = Duration(milliseconds: 1300);
}

/// 動きの気持ち。
///
/// にぎやかな画面(会話・祝福・オンボーディング)だけが [pop] を使える。
/// カルテと復習は内省する画面なので、行き過ぎて戻る動きを持ち込まない
/// (handoff §7「騒がしい/静かの分離」)。
abstract final class AppCurves {
  static const Curve enter = Curves.easeOutCubic;
  static const Curve exit = Curves.easeInCubic;
  static const Curve pop = Curves.easeOutBack;
  static const Curve breathe = Curves.easeInOut;
}
