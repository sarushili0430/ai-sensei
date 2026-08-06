import 'dart:convert';
import 'dart:io';

import 'package:ai_sensei/src/api/api_client.dart';
import 'package:ai_sensei/src/features/capture/application/capture_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 不具合報告: ローカルから動かすと、撮影のたびに
/// 「うまく送れませんでした」になる(サーバのログには何も出ない)。
///
/// `API_BASE_URL` の末尾に `/` が入っていた。アプリは
/// `$baseUrl/v1/sessions` を組み立てるので `//v1/sessions` になり、
/// APIのどのルートにも当たらず 404 が **text/plain** で返る。
/// それをJSONとして読もうとして例外になり、通信そのものの失敗と
/// 見分けがつかなくなっていた。

void main() {
  test('baseUrlの末尾の / は落とす(// で404になるため)', () {
    expect(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com///'), 'https://api.example.com');
    expect(normalizeBaseUrl('  http://localhost:8787/ '), 'http://localhost:8787');
    // パスつきのURL(将来 /api を挟む場合)を壊さない
    expect(normalizeBaseUrl('https://api.example.com/api/'), 'https://api.example.com/api');
    expect(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com');
  });

  test('末尾に / が付いたURLでも /v1/sessions を叩く', () async {
    final List<Uri> urls = <Uri>[];
    final ApiClient client = ApiClient(
      baseUrl: 'https://api.example.com/',
      deviceId: 'device-1',
      client: MockClient((http.Request request) async {
        urls.add(request.url);
        return http.Response.bytes(
          utf8.encode(jsonEncode(<String, dynamic>{'progress': null})),
          200,
          headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );

    try {
      await client.fetchProgress();
    } catch (_) {
      // 本文の形は問わない。宛先だけを見る。
    }

    expect(urls.single.toString(), 'https://api.example.com/v1/me/progress');
  });

  test('JSONでない応答(404のtext/plain)でも例外で落ちず、送信の失敗として出す', () async {
    final Directory tempDir = Directory.systemTemp.createTempSync('api_base_url_test');
    addTearDown(() => tempDir.deleteSync(recursive: true));
    final File photo = File('${tempDir.path}/note.jpg')
      ..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0x00]);

    final MockClient client = MockClient(
      (http.Request request) async => http.Response(
        '404 Not Found',
        404,
        headers: <String, String>{'content-type': 'text/plain; charset=UTF-8'},
      ),
    );

    final List<Object?> overrides = <Object?>[
      apiClientProvider.overrideWithValue(
        ApiClient(baseUrl: 'http://test', deviceId: 'device-1', client: client),
      ),
    ];
    final ProviderContainer container = ProviderContainer(overrides: overrides.cast());
    addTearDown(container.dispose);

    final CaptureController controller = container.read(captureControllerProvider.notifier);
    controller.setPhoto(photo);
    await controller.analyze();

    final CaptureState state = container.read(captureControllerProvider);
    // スピナーのまま固まらない(撮り直しの導線が残る)
    expect(state.isSubmitting, isFalse);
    expect(state.error?.message, contains('うまく送れませんでした'));
  });
}
