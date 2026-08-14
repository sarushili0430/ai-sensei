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

/// Whether the server's Premium verdict is re-read after a purchase.
///
/// Without it, the app stays free even when the webhook was delivered with a
/// 200. Screens gate on the server's `is_premium`, and the controller holding it
/// is keepAlive — read once at startup and never again. This is what "paid but
/// unusable" actually is, so every path is covered.

const String _deviceId = '11111111-2222-4333-8444-555555555555';

/// Webhook poll intervals; tests never use real time.
const List<Duration> _noWait = <Duration>[
  Duration.zero,
  Duration.zero,
  Duration.zero,
  Duration.zero,
];

/// A fake server for `/v1/me/progress`.
///
/// It returns free for the first [freeResponses] calls and Premium after, using
/// a call count to reproduce the webhook's delay.
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

/// Lets the entitlement be driven by hand; the SDK is never called.
class FakeEntitlementController extends EntitlementController {
  @override
  Future<Entitlement> build() async => Entitlement.free;

  /// The same shape of update the SDK pushes on purchase, restore or expiry.
  void emit({required bool isPremium}) =>
      state = AsyncValue<Entitlement>.data(Entitlement(isPremium: isPremium));

  /// The loading state during a purchase. Whether the prior value is kept is
  /// implementation-dependent, so the not-kept case is reproduced — if anything
  /// is missed, it shows here.
  void emitLoading() => state = const AsyncValue<Entitlement>.loading();
}

ProviderContainer _container(_FakeServer server) {
  final ProviderContainer container = ProviderContainer(
    // The `Override` type is not in Riverpod 3's public API (as in harness.dart).
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

/// Builds the post-startup state: home has read progress once and the
/// entitlement has settled.
Future<void> _boot(ProviderContainer container) async {
  container.read(premiumSyncProvider);
  await container.read(progressControllerProvider.future);
  await container.read(entitlementControllerProvider.future);
}

FakeEntitlementController _entitlement(ProviderContainer container) =>
    container.read(entitlementControllerProvider.notifier) as FakeEntitlementController;

/// Waits from the listener starting until the sync completes.
Future<void> _settle(ProviderContainer container) async {
  await Future<void>.delayed(Duration.zero);
  await container.read(premiumSyncProvider.notifier).settled;
}

void main() {
  group('購入後のサーバ同期', () {
    test('Premiumになったら、サーバ側の判定を読み直す', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);

      // The first read at startup; the webhook has not written yet.
      expect((await container.read(progressControllerProvider.future)).isPremium, isFalse);

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      // Staying false here is the reported bug itself.
      expect(container.read(progressControllerProvider).value?.isPremium, isTrue);
    });

    test('サーバ側がPremiumへ追いついたら、親レポートのロック応答も捨てる', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);

      // The screen survives the paywall being pushed on top, so the locked
      // provider stays listened to, matching the real stack's lifetime.
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

    // The webhook lands seconds after purchase; reading once and giving up grabs
    // the pre-webhook value.
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

    // A permanently broken webhook. Never unlock on the client's claim.
    test('追いつかなければ諦める。無料のまま倒して、Premiumを騙らない', () async {
      final _FakeServer server = _FakeServer(freeResponses: 9999);
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);
      final int before = server.progressCalls;

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      expect(container.read(progressControllerProvider).value?.isPremium, isFalse);
      // It exhausts the attempts but does not read forever.
      expect(server.progressCalls - before, _noWait.length + 1);
    });

    // Right after a purchase it reads repeatedly until the webhook lands. If the
    // loading value dropped to empty in between, home's streak days and filled
    // gaps would flicker (home renders `summary.value ?? empty`). Today's
    // `refresh()` keeps the prior value, so it does not. Adding retries made it
    // read many times, so losing that would break visibly.
    test('読み直しているあいだ、ホームのカウンターは0に落ちない', () async {
      final _FakeServer server = _FakeServer(freeResponses: 3);
      final ProviderContainer container = _container(server);
      await container.read(progressControllerProvider.future);

      final List<int> seen = <int>[];
      container.listen<AsyncValue<ProgressSummary>>(progressControllerProvider, (
        AsyncValue<ProgressSummary>? _,
        AsyncValue<ProgressSummary> next,
      ) {
        // Read the same way home does; dropping to 0 makes both counters flicker.
        seen.add((next.value ?? ProgressSummary.empty).progress.streakDays);
      });

      await container
          .read(premiumSyncProvider.notifier)
          .sync(expectPremium: true, backoff: _noWait);

      expect(seen, isNotEmpty);
      expect(seen, everyElement(3));
    });
  });

  // Driven by entitlement changes rather than each purchase entry point, so a
  // forgotten call cannot break it. Purchases completed inside the paywall,
  // Customer Center and SDK pushes all take the same path.
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

    // The entitlement merely settling at startup does not trigger it: each
    // controller's build() is about to read anyway, so it would just fetch twice.
    test('起動時の1回目では走らない', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await _boot(container);
      final int before = server.progressCalls;

      // The same first-value transition as startup, still free.
      _entitlement(container).emit(isPremium: false);
      await _settle(container);

      expect(server.progressCalls, before);
    }, timeout: const Timeout(Duration(seconds: 10)));

    // Premium dropping on expiry or refund. The app also re-syncs to the server
    // so an open app does not keep showing Premium screens.
    test('Premiumが外れたときも読み直す', () async {
      final _FakeServer server = _FakeServer();
      final ProviderContainer container = _container(server);
      await _boot(container);

      _entitlement(container).emit(isPremium: true);
      await _settle(container);
      expect(container.read(progressControllerProvider).value?.isPremium, isTrue);

      // Put the server into the expired state too (after the EXPIRATION webhook).
      server.freeResponses = 9999;
      final int before = server.progressCalls;

      _entitlement(container).emit(isPremium: false);
      await _settle(container);

      expect(server.progressCalls, greaterThan(before));
      expect(container.read(progressControllerProvider).value?.isPremium, isFalse);
    }, timeout: const Timeout(Duration(seconds: 10)));
  });
}
