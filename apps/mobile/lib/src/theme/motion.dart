import 'package:flutter/material.dart';

/// 「動かすか、動かさないか」の判断を1か所にまとめる。
///
/// iOSの「視差効果を減らす」/ Androidの「アニメーションを削除」を入れている人には、
/// 装飾の動きを一切出さない。目まいや乗り物酔いを起こす人がいる設定なので、
/// 弱める(短くする)のではなく**出さない**。
///
/// 出さないときは、途中で止めるのではなく **終わった状態**を描く。
/// 入場アニメーションを 0 で止めると本文が薄いまま消えてしまい、
/// 動かない人にとってはアプリが壊れているのと同じになる。
///
/// golden test もこの経路を通る(`test/support/harness.dart` が
/// `disableAnimations` を立てている)。ここを通していないループ
/// アニメーションが混ざると `pumpAndSettle` が返らなくなるので、
/// 通し忘れはテストが落ちて教えてくれる。
abstract final class AppMotion {
  static bool isReduced(BuildContext context) =>
      MediaQuery.maybeOf(context)?.disableAnimations ?? false;

  /// 装飾のアニメーションの長さ。減らす設定なら 0(= 即座に終わった状態)。
  ///
  /// **操作の時間には使わない。** 「長押しして説明する」の長さのように、
  /// ユーザーの入力を測っているものを 0 にすると、操作そのものが壊れる。
  static Duration decorative(BuildContext context, Duration value) =>
      isReduced(context) ? Duration.zero : value;

  /// 画面読み上げが動いているか。
  ///
  /// 長押しのような「時間で測る操作」には、必ずタップの代替を用意する。
  /// 押し続けられない人がいるし、読み上げ中はタップの意味自体が変わる。
  static bool prefersTapOverHold(BuildContext context) {
    final MediaQueryData? query = MediaQuery.maybeOf(context);
    return query?.accessibleNavigation ?? false;
  }
}
