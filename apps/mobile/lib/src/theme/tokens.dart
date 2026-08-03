import 'package:flutter/material.dart';

/// デザイントークン(handoff §7 ビジュアル方針)。
///
/// Duolingoの「文法」は借りるが「語彙」は借りない。
/// ストリーク・厚みのあるボタン・キャラの感情リアクションは採用し、
/// XP/リーグ/正誤スコア/緑フクロウ的なトレードドレスは採用しない。
abstract final class AppColors {
  /// 主役・行動・後輩。
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
}
