import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// 画面の識別子。パスを文字列で散らかさないためだけの列挙。
///
/// パスは全画面ぶんフラットに見えるが、ルータ側では復習・設定・ペイウォール・
/// カルテを `/` の**子ルート**として組んである(`app_router.dart`)。
/// 子にしておくと `go('/review')` でもホームが下に積まれるので、
/// 通知タップでアプリが起動したときにも戻るボタンが効く。
enum AppRoute {
  onboarding('/onboarding'),
  home('/'),
  capture('/capture'),
  session('/session'),
  celebration('/celebration'),
  karte('/karte'),
  review('/review'),
  paywall('/paywall'),
  thanks('/thanks'),
  settings('/settings');

  const AppRoute(this.path);

  final String path;

  /// `/` の子ルートに書くときの相対パス。
  String get segment => path == '/' ? path : path.substring(1);
}

/// 画面の閉じ方。
///
/// 寄り道(push)で来ていれば元の画面に戻し、そうでなければホームへ逃がす。
/// 通知から復習画面に直接着地した場合など、来かたが1つに決まらない画面で使う。
extension AppNavigation on BuildContext {
  void closeOrGoHome() {
    if (canPop()) {
      pop();
    } else {
      go(AppRoute.home.path);
    }
  }

  /// ペイウォールを、購入のお礼に**差し替える**。
  ///
  /// push ではなく差し替えなのは、買ったあとに戻れても、戻る先が
  /// 「もう一度買う画面」しか無いから。差し替えておくと、お礼を閉じたときに
  /// ペイウォールを開く前の画面(ホーム・カルテ・復習)へそのまま戻る。
  void replaceWithThanks({bool restored = false}) =>
      pushReplacement(thanksLocation(restored: restored));

  /// お礼を重ねて出す。設定から復元したときのように、
  /// **元の画面を残したい**ところから使う。
  void pushThanks({bool restored = false}) => push(thanksLocation(restored: restored));
}

/// お礼画面の行き先。
///
/// 復元だけクエリで渡す。無料トライアルかどうかは entitlement が知っているので
/// 渡さない(渡すと、画面とSDKで別々の事実を持つことになる)。
String thanksLocation({bool restored = false}) =>
    restored ? '${AppRoute.thanks.path}?restored=1' : AppRoute.thanks.path;
