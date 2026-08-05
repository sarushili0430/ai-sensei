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
}
