import 'dart:convert';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/features/karte/application/karte_controllers.dart';
import 'package:ai_sensei/src/features/karte/domain/karte.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/harness.dart';

Map<String, dynamic> _problemJson() => <String, dynamic>{
  'id': 'prb_review',
  'session_id': 'ses_review',
  'board_id': 'brd_review',
  'topic_id': 'M1-NIJI-HANBETSU',
  'question': 'x² − 6x + 5 = 0 の解の個数は?',
  'created_at': '2026-08-03T13:24:07.000Z',
};

Map<String, dynamic> _progressJson() => <String, dynamic>{
  'streak_days': 4,
  'filled_holes': 5,
  'open_holes': 1,
  'solved_problems': 13,
  'open_problems': 1,
  'last_session_date': '2026-08-11',
};

Map<String, dynamic> _queueJson() => <String, dynamic>{
  'items': <dynamic>[
    <String, dynamic>{
      'problem': _problemJson(),
      'days_since': 3,
      'topic_label': '判別式と解の個数',
      'last_verdict': null,
    },
  ],
  'solved': <dynamic>[],
};

Map<String, dynamic> _answerJson({String verdict = 'correct'}) =>
    <String, dynamic>{
      'attempt': <String, dynamic>{
        'id': 'att_review',
        'problem_id': 'prb_review',
        'answered_at': '2026-08-06T11:03:27.000Z',
        'response': 'D = 16 で D > 0 だから2個',
        'verdict': verdict,
        'graded_by': 'test-grader',
        'comment': 'Dの符号から解の個数までつなげられている。',
      },
      'next_schedule': <dynamic>[
        <String, dynamic>{
          'problem_id': 'prb_review',
          'step': 2,
          'days': 3,
          'scheduled_at': '2026-08-09T11:00:00.000Z',
        },
        <String, dynamic>{
          'problem_id': 'prb_review',
          'step': 3,
          'days': 7,
          'scheduled_at': '2026-08-13T11:00:00.000Z',
        },
      ],
      'progress': _progressJson(),
    };

http.Response _json(Map<String, dynamic> body, {int status = 200}) =>
    http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: <String, String>{
        'content-type': 'application/json; charset=utf-8',
      },
    );

void main() {
  test('answerPractice は本人のテキストをJSONで送り、AI採点と通知予定を読む', () async {
    late http.Request sent;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      deviceId: 'device-review',
      client: MockClient((http.Request request) async {
        sent = request;
        return _json(_answerJson());
      }),
    );

    final PracticeAnswer answer = await api.answerPractice(
      'prb_review',
      'D = 16 で D > 0 だから2個',
    );

    expect(sent.method, 'POST');
    expect(sent.url.path, '/v1/me/practice/prb_review');
    expect(sent.headers['x-device-id'], 'device-review');
    expect(jsonDecode(sent.body), <String, dynamic>{
      'response': 'D = 16 で D > 0 だから2個',
    });
    expect(answer.attempt.verdict, PracticeVerdict.correct);
    expect(
      answer.nextSchedule.map((PracticeScheduleEntry entry) => entry.days),
      <int>[3, 7],
    );
    expect(answer.progress.solvedProblems, 13);
  });

  test('採点の成功後は結果を画面用に残し、応答の進捗をそのまま反映する', () async {
    int practiceGets = 0;
    late http.Request answerRequest;
    final MockClient client = MockClient((http.Request request) async {
      if (request.method == 'GET' && request.url.path == '/v1/me/practice') {
        practiceGets += 1;
        return _json(_queueJson());
      }
      if (request.method == 'POST' &&
          request.url.path == '/v1/me/practice/prb_review') {
        answerRequest = request;
        return _json(_answerJson());
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
          ApiClient(
            baseUrl: 'http://test',
            deviceId: 'device-review',
            client: client,
          ),
        ),
        progressControllerProvider.overrideWith(FakeProgressController.new),
      ].cast(),
    );
    addTearDown(container.dispose);
    await container.read(progressControllerProvider.future);
    await container.read(reviewControllerProvider.future);

    container
        .read(practiceAnswerControllerProvider.notifier)
        .updateDraft('prb_review', ' D = 16 で D > 0 だから2個 ');
    final bool succeeded = await container
        .read(practiceAnswerControllerProvider.notifier)
        .submit('prb_review');

    expect(succeeded, isTrue);
    expect(jsonDecode(answerRequest.body), <String, dynamic>{
      'response': 'D = 16 で D > 0 だから2個',
    });
    expect(practiceGets, 1, reason: '結果を読む前に問題をキューから消さない');
    expect(
      container
          .read(practiceAnswerControllerProvider)
          .answerFor('prb_review')
          ?.attempt
          .verdict,
      PracticeVerdict.correct,
    );
    expect(
      container.read(progressControllerProvider).value?.progress,
      Progress.fromJson(_progressJson()),
    );
  });

  test('採点に失敗しても下書きを残し、同じ問題を再送できる状態へ戻す', () async {
    int posts = 0;
    final ProviderContainer container = ProviderContainer(
      overrides: <Object?>[
        apiClientProvider.overrideWithValue(
          ApiClient(
            baseUrl: 'http://test',
            deviceId: 'device-review',
            client: MockClient((http.Request request) async {
              posts += 1;
              return _json(<String, dynamic>{
                'error': <String, dynamic>{
                  'code': 'grading_unavailable',
                  'message': '採点できませんでした',
                },
              }, status: 503);
            }),
          ),
        ),
      ].cast(),
    );
    addTearDown(container.dispose);
    final PracticeAnswerController controller = container.read(
      practiceAnswerControllerProvider.notifier,
    );
    controller.updateDraft('prb_review', '途中式は D = 16');

    final bool succeeded = await controller.submit('prb_review');
    final PracticeAnswersState state = container.read(
      practiceAnswerControllerProvider,
    );

    expect(succeeded, isFalse);
    expect(posts, 1);
    expect(state.draftFor('prb_review'), '途中式は D = 16');
    expect(state.isGrading('prb_review'), isFalse);
    expect(state.errorFor('prb_review'), isA<ApiException>());
  });
}
