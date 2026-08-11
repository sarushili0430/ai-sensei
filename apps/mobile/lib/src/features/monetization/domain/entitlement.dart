import 'package:flutter/foundation.dart';
import 'package:purchases_flutter/purchases_flutter.dart';

/// 課金まわりのドメイン。SDKの型を、この画面が必要とする形に落とすだけの層。
///
/// ここに書いたものはすべて純関数か不変クラスにしてある。テスト方針の
/// 「①純関数ユニット」で押さえられる範囲を最大にするため。
///
/// **サーバ側の判定が正**。ここはUIの出し分けにだけ使い、
/// クライアントの申告でセッション上限を緩めることはしない。

/// 売る期間。RevenueCat の [PackageType] のうち、このアプリが
/// ダッシュボードに用意した3つ(weekly / monthly / yearly)だけ扱う。
enum PlanPeriod {
  weekly,
  monthly,
  yearly;

  /// 対応するものが無ければ null。lifetime や独自パッケージを足しても
  /// 黙って落ちるだけで、画面が壊れないようにしておく。
  static PlanPeriod? fromPackageType(PackageType type) => switch (type) {
    PackageType.weekly => PlanPeriod.weekly,
    PackageType.monthly => PlanPeriod.monthly,
    PackageType.annual => PlanPeriod.yearly,
    _ => null,
  };
}

/// ペイウォールに出す1プラン。価格の文字列はストアが返したものを
/// **そのまま**使う(通貨記号と桁区切りを自前で組み立てない)。
@immutable
class SubscriptionPlan {
  const SubscriptionPlan({
    required this.package,
    required this.period,
    this.isBestValue = false,
  });

  final Package package;
  final PlanPeriod period;

  /// 月あたりが最も安いプラン。**計算できたときだけ**立てる。
  /// 「おすすめ」ではなく事実として出すためのフラグ。
  final bool isBestValue;

  StoreProduct get product => package.storeProduct;

  String get priceString => product.priceString;

  /// 「月あたり◯円」。年額の割安さを、煽らずに数字で見せるために使う。
  String? get pricePerMonthString => product.pricePerMonthString;

  double? get pricePerMonth => product.pricePerMonth;

  /// 無料トライアルの日数。0 ならトライアル無し。
  ///
  /// introductoryPrice は「割引価格」も表すので、**0円のときだけ**
  /// 無料と呼ぶ。有料の入会キャンペーンを「無料」と書かないための分岐。
  int get freeTrialDays {
    final IntroductoryPrice? intro = product.introductoryPrice;
    if (intro == null || intro.price > 0) return 0;

    final int daysPerUnit = switch (intro.periodUnit) {
      PeriodUnit.day => 1,
      PeriodUnit.week => 7,
      PeriodUnit.month => 30,
      PeriodUnit.year => 365,
      PeriodUnit.unknown => 0,
    };
    // cycles は「その価格が適用される回数」。0 が返る実装もあるので 1 に寄せる。
    final int cycles = intro.cycles <= 0 ? 1 : intro.cycles;
    return daysPerUnit * intro.periodNumberOfUnits * cycles;
  }

  bool get hasFreeTrial => freeTrialDays > 0;
}

/// Offering から売り物を取り出す。
///
/// 並びは **週 → 月 → 年** の期間順で固定する。高い順に並べて年額へ
/// 誘導するようなことはしない(§6 煽らない)。ダッシュボードの
/// パッケージ順に依存しないので、Offering をいじっても画面はぶれない。
List<SubscriptionPlan> plansOf(Offering? offering) {
  if (offering == null) return const <SubscriptionPlan>[];

  final List<({Package package, PlanPeriod period})> found =
      <({Package package, PlanPeriod period})>[];
  for (final PlanPeriod period in PlanPeriod.values) {
    for (final Package package in offering.availablePackages) {
      if (PlanPeriod.fromPackageType(package.packageType) == period) {
        found.add((package: package, period: period));
        break; // 同じ期間が複数あっても最初の1つだけ出す
      }
    }
  }

  // 月あたり単価が全プランで取れたときだけ「いちばんお得」を出す。
  // ストアが pricePerMonth を返さないことがあるので、欠けたら黙って出さない。
  final Iterable<double?> perMonth = found.map(
    (({Package package, PlanPeriod period}) it) => it.package.storeProduct.pricePerMonth,
  );
  final bool comparable = found.length > 1 && !perMonth.contains(null);
  final double? cheapest = comparable
      ? perMonth.cast<double>().reduce((double a, double b) => a < b ? a : b)
      : null;

  return <SubscriptionPlan>[
    for (final ({Package package, PlanPeriod period}) it in found)
      SubscriptionPlan(
        package: it.package,
        period: it.period,
        isBestValue: cheapest != null && it.package.storeProduct.pricePerMonth == cheapest,
      ),
  ];
}

/// プラン一覧から期間で1つ選ぶ。同じ期間が無ければ先頭(空なら null)。
///
/// ペイウォールの既定選択と、祝福画面に出す一行が**同じプランを指す**ように
/// 1か所に置く。別々に選ぶと、見せた価格と実際に買う価格がずれる。
SubscriptionPlan? planForPeriod(List<SubscriptionPlan> plans, PlanPeriod period) {
  if (plans.isEmpty) return null;
  for (final SubscriptionPlan plan in plans) {
    if (plan.period == period) return plan;
  }
  return plans.first;
}

/// 課金状態のスナップショット。
@immutable
class Entitlement {
  const Entitlement({
    required this.isPremium,
    this.offering,
    this.expiresAt,
    this.willRenew = false,
    this.isTrial = false,
    this.isSandbox = false,
    this.store,
    this.managementUrl,
  });

  /// SDKを設定していないビルドの既定値。
  /// テスト・CI・鍵を渡し忘れたビルドはこれで無料のまま動く。
  static const Entitlement free = Entitlement(isPremium: false);

  /// CustomerInfo から組み立てる。[entitlementId] がダッシュボードと
  /// ずれていると、課金は成立するのに何も解放されない状態になる。
  factory Entitlement.from({
    required CustomerInfo info,
    required String entitlementId,
    Offering? offering,
  }) {
    final EntitlementInfo? active = info.entitlements.active[entitlementId];
    return Entitlement(
      isPremium: active != null,
      offering: offering,
      expiresAt: _parseDate(active?.expirationDate),
      willRenew: active?.willRenew ?? false,
      // 無料期間は「まだ1円も払っていない」。お礼の言い方を変える分岐に使う。
      // intro(有料の入会キャンペーン)を混ぜないこと — あれは払っている。
      isTrial: active?.periodType == PeriodType.trial,
      isSandbox: active?.isSandbox ?? false,
      store: active?.store,
      // ストアの解約画面へのURL。Customer Center が使えないときの逃げ道。
      managementUrl: info.managementURL,
    );
  }

  final bool isPremium;

  /// 現在の Offering。ペイウォールを自前で描くときだけ使う。
  final Offering? offering;

  /// 有効期限。解約済みでもここまでは使える。
  final DateTime? expiresAt;

  final bool willRenew;

  /// 無料トライアル中。**まだ請求は発生していない。**
  ///
  /// ここを見ずに「ご購入ありがとうございます」と出すと、1円も払っていない
  /// 人にお礼を言うことになる(誠実さ)。
  final bool isTrial;

  final bool isSandbox;
  final Store? store;
  final String? managementUrl;

  List<SubscriptionPlan> get plans => plansOf(offering);

  /// 解約予約済み(期限まで有効)。払ったぶんは最後まで使える。
  /// backend 側の CANCELLATION の扱いと合わせてある。
  bool get isCancelled => isPremium && !willRenew;

  /// 期限までの残り日数。**切り上げる。**
  ///
  /// 無料期間の見出し(「7日間、ぜんぶ使えます」)に使う。切り捨てると、
  /// 買った直後に「あと6日」と出ることがある(7日ちょうどに数分足りない)。
  /// 残っていない・期限が分からないときは 0。
  ///
  /// [now] を引数で受けるのは、テストから時計を固定するため。
  int daysLeft(DateTime now) {
    final DateTime? end = expiresAt;
    if (end == null) return 0;
    final Duration left = end.difference(now);
    if (left.isNegative) return 0;
    return (left.inMinutes / Duration.minutesPerDay).ceil();
  }

  /// 契約の管理導線を出すか。契約中か、ストアに解約URLがあるとき。
  bool get canManageSubscription => isPremium || managementUrl != null;

  static DateTime? _parseDate(String? value) =>
      value == null ? null : DateTime.tryParse(value)?.toLocal();
}
