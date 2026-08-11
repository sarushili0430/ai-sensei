import 'dart:convert';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/harness.dart';

Map<String, dynamic> _holeJson({required bool filled}) => <String, dynamic>{
      'id': 'hol_review',
      'topic_id': 'M1-NIJI-HANBETSU',
      'desc': '判別式を「なぜ」使うのか、で説明が止まった',
      'severity': 'medium',
      'status': filled ? 'filled' : 'open',
      'created_at': '2026-08-03T13:24:07.000Z',
      'filled_at': filled ? '2026-08-11T12:00:00.000Z' : null,
    };

Map<String, dynamic> _progressJson() => <String, dynamic>{
      'streak_days': 4,
      'filled_holes': 5,
      'open_holes': 1,
      'last_session_date': '2026-08-11',
    };

Map<String, dynamic> _queueJson({required bool answered}) => <String, dynamic>{
      'items': answered
          ? <dynamic>[]
          : <dynamic>[
              <String, dynamic>{
                'hole': _holeJson(filled: false),
                'topic_id': 'M1-NIJI-HANBETSU',
                'days_since': 3,
                'prompt': '3日前の「判別式のなぜ」、いまなら説明できますか?',
                'quiz': '判別式を使うと解の個数がわかる理由を説明できる?',
              },
            ],
      'filled': <dynamic>[],
    };

http.Response _json(Map<String, dynamic> body, {int status = 200}) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  test('answerReview は said_it をJSONで送り、穴と進捗を読む', () async {
    late http.Request sent;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      deviceId: 'device-review',
      client: MockClient((http.Request request) async {
        sent = request;
        return _json(<String, dynamic>{
          'hole': _holeJson(filled: true),
          'progress': _progressJson(),
        });
      }),
    );

    final ReviewAnswer answer = await api.answerReview(
      'hol_review',
      ReviewOutcome.saidIt,
    );

    expect(sent.method, 'POST');
    expect(sent.url.path, '/v1/me/reviews/hol_review');
    expect(sent.headers['x-device-id'], 'device-review');
    expect(jsonDecode(sent.body), <String, dynamic>{'outcome': 'said_it'});
    expect(answer.hole.status, HoleStatus.filled);
    expect(answer.progress.filledHoles, 5);
  });

  test('「言えた」の成功後はキューを読み直し、応答の進捗をそのまま反映する', () async {
    bool answered = false;
    int reviewGets = 0;
    late http.Request answerRequest;
    final MockClient client = MockClient((http.Request request) async {
      if (request.method == 'GET' && request.url.path == '/v1/me/reviews') {
        reviewGets += 1;
        return _json(_queueJson(answered: answered));
      }
      if (request.method == 'POST' && request.url.path == '/v1/me/reviews/hol_review') {
        answerRequest = request;
        answered = true;
        return _json(<String, dynamic>{
          'hole': _holeJson(filled: true),
          'progress': _progressJson(),
        });
      }
      return _json(<String, dynamic>{
        'error': <String, dynamic>{
          'code': 'internal_error',
          'message': '想定外の呼び出しです',
        },
      }, status: 500);
    });
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        apiClientProvider.overrideWithValue(
          ApiClient(baseUrl: 'http://test', deviceId: 'device-review', client: client),
        ),
        progressControllerProvider.overrideWith(FakeProgressController.new),
      ].cast(),
    );
    addTearDown(container.dispose);
    await container.read(progressControllerProvider.future);
    await container.read(reviewControllerProvider.future);

    final bool succeeded = await container
        .read(reviewControllerProvider.notifier)
        .answer('hol_review', ReviewOutcome.saidIt);

    expect(succeeded, isTrue);
    expect(jsonDecode(answerRequest.body), <String, dynamic>{'outcome': 'said_it'});
    expect(reviewGets, 2, reason: '回答後に次の1問を読み直す');
    expect(container.read(reviewControllerProvider).value?.items, isEmpty);
    expect(
      container.read(progressControllerProvider).value?.progress,
      Progress.fromJson(_progressJson()),
    );
  });

  test('hole_not_found は判別でき、回答失敗なら false を返す', () async {
    const ApiException missing = ApiException(
      code: 'hole_not_found',
      message: 'この穴は見つかりませんでした',
    );
    expect(missing.isHoleNotFound, isTrue);

    final MockClient client = MockClient((http.Request request) async {
      if (request.method == 'GET') return _json(_queueJson(answered: false));
      return _json(<String, dynamic>{
        'error': <String, dynamic>{
          'code': 'hole_not_found',
          'message': missing.message,
        },
      }, status: 404);
    });
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        apiClientProvider.overrideWithValue(
          ApiClient(baseUrl: 'http://test', deviceId: 'device-review', client: client),
        ),
      ].cast(),
    );
    addTearDown(container.dispose);
    await container.read(reviewControllerProvider.future);

    final bool succeeded = await container
        .read(reviewControllerProvider.notifier)
        .answer('hol_review', ReviewOutcome.saidIt);

    expect(succeeded, isFalse);
  });
}
