import 'dart:convert';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart' show ProgressSummary;
import 'package:ai_sensei/src/features/session/application/session_controller.dart';
import 'package:ai_sensei/src/features/session/domain/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/harness.dart';

/// 残り時間の精算(`POST /v1/sessions/{id}/finish`)のテスト。
///
/// テスターの報告「残り時間が毎セッション20分引かれる(20分経っていなくても)」への
/// 手当て。`/start` の仮押さえはカルテと一緒に届く精算(`/complete`)まで残高から
/// 引かれたままで、先輩が来なかった回には精算そのものが来なかった。
/// 会話の終わり・接続の失敗で必ず精算を送り、応答の残高でホームの表示を戻す。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  http.Response json(Map<String, dynamic> body, {int status = 200}) => http.Response.bytes(
        utf8.encode(jsonEncode(body)),
        status,
        headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
      );

  Map<String, dynamic> finishBody({int remaining = 932}) => <String, dynamic>{
        'session_id': 'ses_1',
        'limits': <String, dynamic>{
          'max_seconds': 1200,
          'remaining_seconds_today': remaining,
          'lesson_allowed_today': true,
        },
      };

  test('finishSession は秒数を送らず、精算後の残高を読む', () async {
    late http.Request sent;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      deviceId: 'device-session',
      client: MockClient((http.Request request) async {
        sent = request;
        return json(finishBody());
      }),
    );

    final SessionFinish finish = await api.finishSession('ses_1');

    expect(sent.method, 'POST');
    expect(sent.url.path, '/v1/sessions/ses_1/finish');
    expect(sent.headers['x-device-id'], 'device-session');
    // 経過はサーバが測る。こちらから秒数を申告しない(改竄対策の設計ごと固定する)。
    expect(sent.body, isEmpty);
    expect(finish.limits.remainingSecondsToday, 932);
    expect(finish.limits.lessonAllowedToday, isTrue);
  });

  /// 部屋につなげなかった回も、仮押さえを返してもらう。
  ///
  /// ここを呼ばないと、話せなかった20分がトークンの寿命までホームから
  /// 消えたままになる(寿命後は満額で精算されてしまう)。
  test('接続に失敗したら精算を送り、応答の残高をホームへ反映する', () async {
    final List<String> finishCalls = <String>[];
    final MockClient client = MockClient((http.Request request) async {
      if (request.method == 'POST' && request.url.path == '/v1/sessions/ses_1/finish') {
        finishCalls.add(request.url.path);
        return json(finishBody(remaining: 1170));
      }
      return json(<String, dynamic>{
        'error': <String, dynamic>{'code': 'internal_error', 'message': '想定外の呼び出しです'},
      }, status: 500);
    });

    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        apiClientProvider.overrideWithValue(
          ApiClient(baseUrl: 'http://test', deviceId: 'device-session', client: client),
        ),
        progressControllerProvider.overrideWith(FakeProgressController.new),
      ].cast(),
    );
    addTearDown(container.dispose);

    // AutoDisposeの会話コントローラを、テストのあいだ生かしておく。
    final ProviderSubscription<SessionState> subscription =
        container.listen(sessionControllerProvider, (_, _) {});
    addTearDown(subscription.close);
    await container.read(progressControllerProvider.future);

    // テスト環境ではLiveKitへつなげないので、connect は必ず失敗の経路へ入る。
    await container.read(sessionControllerProvider.notifier).connect(
          const SessionStart(
            sessionId: 'ses_1',
            kind: 'new',
            livekit: LiveKitConnection(
              // 開いていないポートへ即失敗させる(名前解決やタイムアウトを待たない)。
              url: 'ws://127.0.0.1:9',
              token: 'token',
              room: 'ses_1',
            ),
            limits: SessionLimits(
              maxSeconds: 1200,
              remainingSecondsToday: 0,
              lessonAllowedToday: false,
            ),
          ),
          locale: 'ja',
        );

    // 精算は失敗処理を待たせないよう fire-and-forget なので、届くまで実時間で待つ。
    for (int i = 0; i < 100 && finishCalls.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }

    expect(container.read(sessionControllerProvider).phase, SessionPhase.failed);
    expect(finishCalls, hasLength(1));
    final ProgressSummary summary = container.read(progressControllerProvider).value!;
    // /start の仮押さえで 0 になっていた残高が、精算の応答で実測へ戻っている。
    expect(summary.limits.remainingSecondsToday, 1170);
    expect(summary.limits.lessonAllowedToday, isTrue);
  });
}
