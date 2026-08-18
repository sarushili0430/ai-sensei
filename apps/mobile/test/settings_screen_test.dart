import 'package:ai_sensei/src/api/device_id.dart';
import 'package:ai_sensei/src/features/notifications/application/push_controller.dart';
import 'package:ai_sensei/src/features/notifications/data/push_repository.dart';
import 'package:ai_sensei/src/features/settings/presentation/settings_screen.dart';
import 'package:ai_sensei/src/l10n/strings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// 設定の「先輩からのおさらい」。
///
/// 見ているのは通知が届くかどうかではなく、**アプリ側に状態を持っていないか**。
/// スイッチが自分の値を覚えた瞬間に「アプリではオンなのに届かない」が生まれる
/// (OSで切られてもスイッチはオンのまま残る)。ここが崩れても実機では
/// 「なぜか通知が来ない人」としてしか現れず、手元では気づけない。
class FakePushPermissionController extends PushPermissionController {
  FakePushPermissionController({required this.granted, this.grantOnRequest = false});

  final bool granted;

  /// 許可を求めたら通す(= システムダイアログでオンにした)。
  final bool grantOnRequest;

  int requests = 0;

  @override
  PushPermission build() => PushPermission(granted: granted, available: true);

  @override
  Future<bool> request() async {
    requests++;
    state = PushPermission(granted: grantOnRequest, available: true);
    return grantOnRequest;
  }
}

void main() {
  /// `openAppSettings()` の行き先を塞いで、呼ばれた回数だけ数える。
  ///
  /// 塞がないと応答が返らず、`pumpAndSettle` が返らなくなる。
  List<String> mockPermissionChannel() {
    final List<String> calls = <String>[];
    const MethodChannel channel = MethodChannel('flutter.baseflow.com/permissions/methods');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (MethodCall call) async {
        calls.add(call.method);
        // `openAppSettings()` は bool を待っている。許可の照会は enum の番号。
        return call.method == 'openAppSettings' ? true : permissionGranted;
      },
    );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    return calls;
  }

  Future<FakePushPermissionController> pumpSettings(
    WidgetTester tester, {
    required bool granted,
    bool grantOnRequest = false,
  }) async {
    final FakePushPermissionController controller = FakePushPermissionController(
      granted: granted,
      grantOnRequest: grantOnRequest,
    );
    await pumpApp(
      tester,
      const SettingsScreen(),
      overrides: <Object?>[
        deviceIdProvider.overrideWithValue('11111111-2222-3333-4444-555555555555'),
        pushPermissionControllerProvider.overrideWith(() => controller),
      ],
    );
    return controller;
  }

  group('先輩からのおさらい', () {
    testWidgets('スイッチが出しているのは、OSの許可そのもの', (WidgetTester tester) async {
      mockPermissionChannel();
      await pumpSettings(tester, granted: true);

      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    });

    testWidgets('許可されていなければオフで出る', (WidgetTester tester) async {
      mockPermissionChannel();
      await pumpSettings(tester, granted: false);

      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    });

    testWidgets('オフのスイッチを入れると、許可を求める', (WidgetTester tester) async {
      mockPermissionChannel();
      final FakePushPermissionController controller = await pumpSettings(
        tester,
        granted: false,
        grantOnRequest: true,
      );

      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();

      expect(controller.requests, 1);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    });

    // iOS はシステムダイアログを一度しか出せない。断られたあとに押しても
    // 何も出ないので、設定アプリへの行き方を出す。
    testWidgets('断られたら、オフのまま設定への行き方を出す', (WidgetTester tester) async {
      mockPermissionChannel();
      await pumpSettings(tester, granted: false);

      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();

      final AppStrings strings = AppStrings.of(tester.element(find.byType(SettingsScreen)));
      expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
      expect(find.text(strings.settingsNotificationsOpenSettings), findsOneWidget);
    });

    // ここがこの画面のいちばん壊れやすいところ。切るのは設定アプリの仕事で、
    // アプリ側が勝手にオフを覚えると、OSの許可と二重の状態になる。
    testWidgets('オンのスイッチを切っても、アプリ側では覚えない', (WidgetTester tester) async {
      final List<String> calls = mockPermissionChannel();
      final FakePushPermissionController controller = await pumpSettings(tester, granted: true);

      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();

      expect(calls, contains('openAppSettings'));
      expect(controller.requests, 0);
      expect(
        tester.widget<Switch>(find.byType(Switch)).value,
        isTrue,
        reason: 'OSの許可はまだ生きている。アプリ側でオフにしてはいけない',
      );
    });

    testWidgets('行のどこを押しても切り替わる(右端の狭い的にしない)', (WidgetTester tester) async {
      mockPermissionChannel();
      final FakePushPermissionController controller = await pumpSettings(
        tester,
        granted: false,
        grantOnRequest: true,
      );

      final AppStrings strings = AppStrings.of(tester.element(find.byType(SettingsScreen)));
      await tester.tap(find.text(strings.settingsNotifications));
      await tester.pumpAndSettle();

      expect(controller.requests, 1);
    });
  });
}
