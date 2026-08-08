import 'package:flutter/widgets.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../api/device_id.dart';

part 'language_controller.g.dart';

/// アプリの言語。端末に合わせる(既定)/ 日本語 / English。
///
/// 端末の設定に任せきりにしない。端末を日本語のまま英語で説明したい人
/// (その逆も)がいるし、端末の言語を変えると**他のアプリまで全部変わる**。
///
/// ここで選んだ言語は画面の文言だけでは終わらない。セッションを作るときに
/// サーバへ送る `locale` になり、後輩の話す言葉・単元の課程・ガードレール・
/// 音声までが切り替わる([ADR 0005](../../../../../docs/adr/0005-locale-curricula.md))。
enum AppLanguage {
  system('system', null),
  japanese('ja', Locale('ja')),
  english('en', Locale('en'));

  const AppLanguage(this.code, this.locale);

  /// 保存する値。`Locale` をそのまま書き出さないのは、`system`(端末に合わせる)を
  /// 「保存していない」と区別して残すため。**選んだうえでの「端末に合わせる」**は、
  /// まだ選んでいない状態とは別のもので、あとから既定を変えても踏み潰さない。
  final String code;

  /// `MaterialApp.locale` に渡す値。`null` は端末の言語に従う
  /// (= 解決を `AppStrings.resolve` に任せる)。
  final Locale? locale;

  /// 選択肢に出す表記。**その言語自身の言葉で書く**。
  /// 英語しか読めない人に「英語」と日本語で書いても、切り替えにたどり着けない。
  ///
  /// 「端末に合わせる」だけは言語に依存しないので、`AppStrings` が持つ。
  String? get nativeName => switch (this) {
        AppLanguage.system => null,
        AppLanguage.japanese => '日本語',
        AppLanguage.english => 'English',
      };

  static AppLanguage fromCode(String? code) {
    for (final AppLanguage language in values) {
      if (language.code == code) return language;
    }
    // 保存されていない(初回起動)か、知らない値。どちらも端末に合わせる。
    // 対応言語が減った・増えたあとでも、ここで落ちないようにしておく。
    return AppLanguage.system;
  }
}

const String _languageKey = 'ai_sensei.language';

/// 言語の設定。設定画面が書き、`AiSenseiApp` が読む。
///
/// keepAlive にしているのは、設定画面を閉じても選択が生きている必要があるため
/// (アプリ全体の `locale` がここを見ている)。
@Riverpod(keepAlive: true)
class LanguageController extends _$LanguageController {
  @override
  AppLanguage build() =>
      AppLanguage.fromCode(ref.read(preferencesProvider).getString(_languageKey));

  Future<void> select(AppLanguage language) async {
    if (state == language) return;

    // 先に切り替える。書き込みを待ってからにすると、押してから画面の言葉が
    // 変わるまでディスクI/Oぶん遅れる。取り返しのつく操作なので待たせない。
    state = language;
    await ref.read(preferencesProvider).setString(_languageKey, language.code);
  }
}
