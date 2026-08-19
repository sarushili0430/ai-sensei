import 'dart:convert';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:ai_sensei/src/features/monetization/application/entitlement_controller.dart';
import 'package:ai_sensei/src/features/monetization/application/premium_sync.dart';
import 'package:ai_sensei/src/features/parent_report/application/parent_report_controller.dart';
import 'package:ai_sensei/src/features/parent_report/domain/parent_report.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 課金が通ったあと、サーバ側のPremium判定を読み直せているか。
///
/// これが無いと **webhookが200で届いていてもアプリは無料のまま**になる。
/// 画面が出し分けに使っているのはサーバの `is_premium` で、それを持つ
/// Controller は keepAlive = 起動時に一度読んだきりだから。
/// 「課金したのに使えない」の実体がここなので、経路ごと押さえておく。

const String _deviceId = '11111111-2222-4333-8444-555555555555';

/// webhookを待つ間隔。テストでは実時間を使わない。
const List<Duration> _noWait = <Duration>[
  Duration.zero,
  Duration.zero,
  Duration.zero,
  Duration.zero,
];

/// `/v1/me/progress` を返す偽サーバ。
///
/// [freeResponses] 回目までは無料で返し、それ以降はPremiumで返す。
/// webhookが届くまでの遅れを、回数で作るためのもの。
class _FakeServer {
  _FakeServer({this.freeResponses = 1});

  int freeResponses;
  int progressCalls = 0;
  int parentReportCalls = 0;

  bool get _premium => progressCalls > freeResponses;

  http.Client get client => MockClient((http.Request request) async {
    if (request.url.path.endsWith('/v1/me/progress')) {
      progressCalls += 1;
      return _json(<String, dynamic>{
        'progress': <String, dynamic>{
          'streak_days': 3,
          'filled_holes': 4,
          'open_holes': 1,
          'last_session_date': '2026-08-03',
        },
        'is_premium': _premium,
        'limits': <String, dynamic>{
          'max_seconds': 1200,
          'remaining_seconds_today': _premium ? 3600 : 1200,
          'lesson_allowed_today': _premium,
        },
      });
    }
    if (request.url.path.endsWith('/v1/me/parent-report')) {
      parentReportCalls += 1;
      if (!_premium) {
        return _json(<String, dynamic>{
          'requires_premium': true,
          'report': null,
        });
      }
      return _json(<String, dynamic>{
        'requires_premium': false,
        'report': <String, dynamic>{
          'period': <String, dynamic>{
            'start_date': '2026-08-01',
            'end_date': '2026-08-11',
          },
          'filled_holes': 2,
          'streak_days': 4,
          'explained_topics': <dynamic>[],
          'quotes': <dynamic>[],
        },
      });
    }
    return http.Response('{"error":{"code":"not_found","message":""}}', 404);
  });

  http.Response _json(Map<String, dynamic> body) => http.Response(
    jsonEncode(body),
    200,
    headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
  );
}

/// entitlement を手で動かせるようにしたもの。SDKは呼ばない。
class FakeEntitlementController extends EntitlementController {
  @override
  Future<Entitlement> build() async => Entitlement.free;

  /// 購入・復元・失効で SDK が push してくるのと同じ形の更新。
  void emit({required bool isPremium}) =>
      state = AsyncValue<Entitlement>.data(Entitlement(isPremium: isPremium));

  /// 購入中に挟まる loading。直前の値を保つかどうかは実装依存なので、
  /// **保たない**ほうを再現しておく(取りこぼすならここで出る)。
  void emitLoading() => state = const AsyncValue<Entitlement>.loading();
}

ProviderContainer _container(_FakeServer server) {
  final ProviderContainer container = ProviderContainer(
    // `Override` 型は Riverpod 3 の公開APIに出ていない(harness.dart と同じ理由)。
    overrides: <Object?>[
      deviceIdProvider.overrideWithValue(_deviceId),
      apiClientProvider.overrideWithValue(
        ApiClient(baseUrl: 'http://localhost:8787', deviceId: _deviceId, client: server.client),
      ),
      entitlementControllerProvider.overrideWith(FakeEntitlementController.new),
    ].cast(),
  );
  addTearDown(container.dispose);
  return container;
}

/// 起動直後の状態を作る。ホームが進捗を一度読み、entitlement が確定したところ。
Future<void> _boot(ProviderContainer container) async {
  container.read(premiumSyncProvider);
  await container.read(progressControllerProvider.future);
  await container.read(entitlementControllerProvider.future);
}

FakeEntitlementController _entitlement(ProviderContainer container) =>
    container.read(entitlementControllerProvider.notifier) as FakeEntitlementController;

/// listener が動き出してから、同期が終わるまで待つ。
Future<void> _settle(ProviderContainer container) async {
  await Future<void>.delayed(Duration.zero);
  await container.read(premiumSyncProvider.notifier).settled;
}

void main() {
  group('購入後のサーバ同期', () {
    test('Premiumになったら、サーバ側の判定を読み直す', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);

      // 起動時の1回目。webhookはまだ書いていない。
      expect((await container.read(progressControllerProvider.future)).isPremium, isFalse);

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      // ここが false のままなのが、報告されたバグそのもの。
      expect(container.read(progressControllerProvider).value?.isPremium, isTrue);
    });

    test('サーバ側がPremiumへ追いついたら、親レポートのロック応答も捨てる', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);

      // ペイウォールが上に載っても画面は破棄されないので、ロック済みproviderを
      // listenしたままにして実際のスタックと同じ寿命を作る。
      final ProviderSubscription<AsyncValue<ParentReportResponse>> subscription =
          container.listen<AsyncValue<ParentReportResponse>>(
        parentReportControllerProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      expect(
        (await container.read(parentReportControllerProvider.future)).requiresPremium,
        isTrue,
      );

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);
      await Future<void>.delayed(Duration.zero);

      final ParentReportResponse refreshed = await container.read(
        parentReportControllerProvider.future,
      );
      expect(refreshed.requiresPremium, isFalse);
      expect(refreshed.report, isNotNull);
      expect(server.parentReportCalls, 2);
    });

    // webhookは購入の数秒後に届く。1回読んで諦めると、届く前のものを掴む。
    test('webhookが遅れていたら、追いつくまで読み直す', () async {
      final _FakeServer server = _FakeServer(freeResponses: 3);
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);
      final int before = server.progressCalls;

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      expect(container.read(progressControllerProvider).value?.isPremium, isTrue);
      expect(server.progressCalls - before, 3, reason: '1回で諦めている');
    });

    // webhookが恒久的に壊れている場合。クライアントの申告で解放はしない。
    test('追いつかなければ諦める。無料のまま倒して、Premiumを騙らない', () async {
      final _FakeServer server = _FakeServer(freeResponses: 9999);
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);
      final int before = server.progressCalls;

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      expect(container.read(progressControllerProvider).value?.isPremium, isFalse);
      // 試行は使い切るが、無限には読まない
      expect(server.progressCalls - before, _noWait.length + 1);
    });

    // 課金直後は webhook が届くまで数回続けて読む。そのあいだ読み込み中の値が
    // 空に落ちると、ホームの連続日数と埋めた穴が点滅して見える
    // (ホームは `summary.value ?? empty` で描いている)。
    // いまの `refresh()` は直前の値を保つので落ちない。retry を足すこの変更で
    // 「何度も読む」ようになったぶん、保たなくなったら目に見えて壊れる。
    test('読み直しているあいだ、ホームのカウンターは0に落ちない', () async {
      final _FakeServer server = _FakeServer(freeResponses: 3);
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);

      final List<int> seen = <int>[];
      container.listen<AsyncValue<ProgressSummary>>(progressControllerProvider, (
        AsyncValue<ProgressSummary>? _,
        AsyncValue<ProgressSummary> next,
      ) {
        // ホームと同じ読み方。0 に落ちると連続日数と埋めた穴が点滅して見える。
        seen.add((next.value ?? ProgressSummary.empty).progress.streakDays);
      });

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      expect(seen, isNotEmpty);
      expect(seen, everyElement(3));
    });
  });

  // 呼び忘れで壊れないように、購入の各入口ではなく entitlement の変化で拾う。
  // ペイウォールの中で完結した購入・Customer Center・SDKのpushも同じ経路。
  group('entitlement の変化を拾う配線', () {
    test('SDKがPremiumをpushしたら、こちらから呼ばなくても同期が走る', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await _boot(container);
      final int before = server.progressCalls;

      _entitlement(container)
        ..emitLoading()
        ..emit(isPremium: true);
      await _settle(container);

      expect(server.progressCalls, greaterThan(before));
      expect(container.read(progressControllerProvider).value?.isPremium, isTrue);
    }, timeout: const Timeout(Duration(seconds: 10)));

    // 起動直後に entitlement が確定するだけでは走らせない。
    // 各 Controller の build() がこれから読むので、二重に取りに行くだけになる。
    test('起動時の1回目では走らない', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await _boot(container);
      final int before = server.progressCalls;

      // 起動時と同じ「はじめて値が入る」遷移(無料のまま)
      _entitlement(container).emit(isPremium: false);
      await _settle(container);

      expect(server.progressCalls, before);
    }, timeout: const Timeout(Duration(seconds: 10)));

    // 期限切れ・返金でPremiumが外れた場合。開いたままのアプリが
    // Premium画面を出し続けないように、こちらもサーバへ揃えにいく。
    test('Premiumが外れたときも読み直す', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await _boot(container);

      _entitlement(container).emit(isPremium: true);
      await _settle(container);
      expect(container.read(progressControllerProvider).value?.isPremium, isTrue);

      // サーバ側も失効した状態にする(EXPIRATION webhookが書いたあと)
      server.freeResponses = 9999;
      final int before = server.progressCalls;

      _entitlement(container).emit(isPremium: false);
      await _settle(container);

      expect(server.progressCalls, greaterThan(before));
      expect(container.read(progressControllerProvider).value?.isPremium, isFalse);
    }, timeout: const Timeout(Duration(seconds: 10)));
  });
}
