import 'dart:async';

import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../karte/application/karte_controllers.dart';
import '../../parent_report/application/parent_report_controller.dart';
// Entitlement は entitlement_controller が domain ごと re-export している。
import 'entitlement_controller.dart';

part 'premium_sync.g.dart';

/// 課金が通ったあと、**サーバ側のPremium判定を読み直す**配線。
/// `AiSenseiApp` が一度だけ watch して起動する(`PushSetup` と同じ位置づけ)。
///
/// Premiumの状態は2つの経路で別々に更新される:
///
///   - アプリ側の entitlement — SDKが購入直後に push してくる(即時)
///   - サーバ側の `users.is_premium` — RevenueCatのwebhookが書く(数秒遅れ)
///
/// そして画面が出し分けに使っているのは**サーバ側**のほう(ホームと
/// 復習画面の授業可否・セッション開始の可否、親レポートのロック)。
/// ProgressController は keepAlive で、起動時に一度読んだきり誰も読み直さない。
/// 親レポートも、ペイウォールが上に載っている間はロック済みの応答を保持する。
///
/// つまりここが無いと、**買った直後はアプリを再起動するまで無料のまま**になる。
/// webhookが200で届いていてもD1がPremiumになっていても、アプリの手元にある
/// のは起動時に読んだ `is_premium: false` だから。
@Riverpod(keepAlive: true)
class PremiumSync extends _$PremiumSync {
  /// 最後に見えた entitlement。
  ///
  /// `ref.listen` の `previous` を使わないのは、購入中に挟まる
  /// `AsyncLoading` が直前の値を保つかどうかに judgment を預けたくないため。
  /// 保たない実装だと `previous` が null になり、**購入の瞬間だけ取りこぼす**。
  bool? _lastSeen;

  Future<void>? _inFlight;

  /// 走っている同期が終わるまで待つ。走っていなければすぐ返る。
  ///
  /// 画面は provider を watch していれば勝手に追いつくので、通常は要らない。
  /// 「反映されたか」を確かめたい側(テスト)のために出している。
  Future<void> get settled => _inFlight ?? Future<void>.value();

  @override
  void build() {
    // 購入・復元・Customer Centerでの解約・期限切れが、すべてここを通る。
    // SDKの `addCustomerInfoUpdateListener` も EntitlementController 経由で
    // ここに流れてくるので、ペイウォールの中で完結した購入も拾える。
    ref.listen<AsyncValue<Entitlement>>(entitlementControllerProvider, (
      AsyncValue<Entitlement>? _,
      AsyncValue<Entitlement> next,
    ) {
      final bool? seen = next.value?.isPremium;
      if (seen == null) return; // まだ読めていない(loading / error)

      final bool? previous = _lastSeen;
      _lastSeen = seen;

      // 起動直後の1回目は動かさない。各 Controller の build() がこれから
      // 読むので、追いかけても同じものを二度取りに行くだけになる。
      if (previous == null || previous == seen) return;

      _inFlight = sync(expectPremium: seen);
      unawaited(_inFlight);
    });
  }

  /// サーバ側の判定が [expectPremium] に追いつくまで読み直す。
  ///
  /// webhookは購入の数秒後に届く。一度読んで違っていたら、間隔を空けて
  /// 数回だけ読み直す。追いつかないまま試行を使い切ったら、そこで終わりにして
  /// **サーバの言うとおりに**しておく。クライアントの申告で解放はしない
  /// (webhookが恒久的に壊れている場合はサーバ側で直すべきもので、
  /// ここで上書きすると誰も壊れていることに気づけなくなる)。
  Future<void> sync({
    required bool expectPremium,
    List<Duration> backoff = webhookBackoff,
  }) async {
    final ProgressController progress = ref.read(progressControllerProvider.notifier);

    for (int attempt = 0; ; attempt++) {
      await progress.refresh();
      final bool? server = ref.read(progressControllerProvider).value?.isPremium;
      if (server == expectPremium || attempt >= backoff.length) break;
      await Future<void>.delayed(backoff[attempt]);
    }

    // 親レポートも同じサーバ側のPremium判定を読む。entitlementが変わった直後に
    // 取り直すだけでは、webhook前のロック応答をもう一度つかむことがあるため、
    // 上の待ち合わせが終わった時点でもキャッシュを捨てる。autoDisposeなので、
    // 画面を一度も開いていない人のために新しい通信を始めることはない。
    ref.invalidate(parentReportControllerProvider);
  }

  /// webhookを待つ間隔。合計でおよそ15秒ぶん。
  ///
  /// 届くのはたいてい数秒以内なので1回目か2回目で抜ける。長くしすぎないのは、
  /// 届かないときにいつまでも「反映されるかもしれない」状態を続けないため。
  static const List<Duration> webhookBackoff = <Duration>[
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
  ];
}
