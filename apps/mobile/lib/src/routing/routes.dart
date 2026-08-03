/// 画面の識別子。パスを文字列で散らかさないためだけの列挙。
enum AppRoute {
  onboarding('/onboarding'),
  home('/'),
  capture('/capture'),
  session('/session'),
  celebration('/celebration'),
  karte('/karte'),
  review('/review'),
  paywall('/paywall');

  const AppRoute(this.path);

  final String path;
}
