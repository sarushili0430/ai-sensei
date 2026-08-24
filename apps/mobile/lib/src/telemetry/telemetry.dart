import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// クラッシュと**縮退**の監視(計画書 §10-7)。
///
/// §10-7 が「提出前に必ず塞ぐ」と名指ししている唯一の項目。穴は3層とも空いていた:
/// Dartコードに `Sentry.` の呼び出しが1件も無く、`SENTRY_DSN` が空で、
/// `codemagic.yaml` が `SENTRY_DSN` だけ `--dart-define` に渡していなかった。
/// **依存だけ入って動いていない状態は、入っていないより危険**(入れたつもりで
/// 運用に入るため)。実際、dSYMs は「Sentryのシンボル化に要る」というコメント付きで
/// 保存されていた —— 送り先が無いのにシンボルだけ集めていた。
///
/// ## クラッシュと縮退を同じ棚に置かない
///
/// ここで本当に見たいのはクラッシュではなく**縮退**。
/// 「落ちてはいないが、約束が破れている」状態のことで、いまはどれも
/// `debugPrint` にしか出ていない = **本番では観測手段がゼロ**だった:
///
///   - 板書がとぎれた([Degradation.boardGap])— agent の送信漏れに気づく唯一の手段
///   - LaTeX が縮小率の下限を割って横スクロールに落ちた([Degradation.latexScaleFloor])
///     — **agent 側の式の分割が効いていない**シグナル(計画書 §3-6b の宿題そのもの)
///   - 板書の実効幅が実測の前提(340pt)を割った([Degradation.boardTooNarrow])
///   - 配送されたSVGを端末で解釈できなかった([Degradation.figureSvgFailed])
///
/// だから `captureException` ではなく **`captureMessage(level: warning)`** を使う。
/// クラッシュの棚に混ぜると、本当に落ちたものが埋もれる。
///
/// ## 送らないもの — ユーザーは未成年
///
/// ノートの写真・問題の写真・生徒の発話・transcript・カルテの本文・**問題文**は
/// 一切送らない。問題文は他者の著作物で、**R2にすら保存しないと決めたもの**
/// (計画書 §4-1)なので、監視に流れたら決定そのものが無効になる。
/// 数式(`tex`)だけは中身が数式なので先頭を送るが、それも [texPrefixLength] 文字まで。
///
/// 落とし方は [scrubEvent] と [SentryOptions] の設定の2段構え。理由はそれぞれのコメント。
abstract final class SentryConfig {
  /// **既定値を持たせない。** 値が入ると、テストでもCIでも本番の受け口に飛ぶ。
  ///
  /// 渡し方:
  ///   - 手元 … `dart_defines/local.json`(`local.example.json` に欄がある)
  ///   - CI  … `codemagic.yaml` の `--dart-define=SENTRY_DSN=...`
  ///           (変数グループ `mobile-dart-defines`)
  static const String dsn = String.fromEnvironment('SENTRY_DSN');

  /// DSN の無いビルド(手元・テスト・値の入れ忘れ)では**何もしない**。
  /// 監視が無いことでアプリの挙動が変わってはいけないので、初期化ごと飛ばす。
  static bool get isConfigured => dsn.isNotEmpty;
}

/// 落ちてはいないが、約束が破れている状態。
enum Degradation {
  /// 板書がとぎれた(封筒の欠落・順序違反・読めないJSON)。
  boardGap('board_gap'),

  /// LaTeX が縮小率の下限(`BoardStyle.latexMinScale`)を割り、横スクロールに落ちた。
  /// **起きてはいけない状態**で、agent 側が式を2手順に分割していないことを意味する。
  latexScaleFloor('latex_scale_floor'),

  /// 板書に使える幅が、実測の前提(340pt)を割った。
  /// 縮小率の判定はこの幅を基準にしているので、ここが痩せると
  /// 「収まるはずの式」が横スクロールに落ちる。
  boardTooNarrow('board_too_narrow'),

  /// サーバで検証済みのはずのSVGを、端末の `flutter_svg` が解釈できなかった。
  /// 空行へ縮退して授業は続けるが、記録しないと図が消えた事実を誰も観測できない。
  figureSvgFailed('figure_svg_failed'),

  /// 「うまく言えない」を押したのに、先輩に伝えられなかった。
  ///
  /// **約束3(パスを恥にしない)は、パスが残ることで成立している。**
  /// 送れないと穴として価値化されず、その生徒にとっては
  /// 「言えなかったのに、何も起きなかった」だけになる。しかも
  /// **画面上は何事もなく進む**ので、本人にもこちらにも見えない。
  passNotSent('pass_not_sent'),

  /// 類題の「できた / できなかった」を押したのに、先輩に伝えられなかった。
  ///
  /// **この経路の壊れ方は、パスより静かで長い。** 先輩は解答待ちの間だけ
  /// 15秒判定を外してセッションの残り時間まで待つので、申告が届かないと
  /// **何分でも黙ったまま**になる。押した生徒からは「ボタンが効かない」に見え、
  /// 画面にはボタンが消えたことしか起きない。声でも申告できる作りにしてあるが、
  /// **押して駄目だった事実が残らないと、その静けさの原因を追えない。**
  solvingReportNotSent('solving_report_not_sent'),

  /// 「わかった」を押したのに、先輩へ制御通知を届けられなかった。
  /// 画面は宣言を受け取って先にボタンを塞ぐため、記録しないと
  /// 「押したのに声が止まらない」という壊れ方がこちらから見えない。
  understoodNotSent('understood_not_sent');

  const Degradation(this.id);

  /// Sentry 上の見出し。**日本語にしない**(検索とグルーピングのため)。
  final String id;
}

/// `tex` を送ってよい長さ。式の見分けがつけばよく、全文は要らない。
const int texPrefixLength = 40;

/// 同じことを何度も送らないための間引き。
///
/// **1回の授業で何十手順も流れる。** 素直に送ると1セッションで大量に飛び、
/// 「1件起きた」と「ずっと起き続けている」の区別がつかなくなるうえ、
/// 無料枠のイベント数も食う。板書1枚につき1件だけ送れば、どの板書で
/// 起きたかは分かる。
class DegradationThrottle {
  DegradationThrottle({this.limit = 64});

  /// 覚えておく鍵の上限。
  ///
  /// **無制限に覚えると、長時間の利用でここだけが太り続ける。**
  /// 上限に達したら全部忘れる(= そこから先はもう一度だけ送る)。
  /// 送りすぎより「長く使った人からは何も飛ばなくなる」ほうが困るので、
  /// 忘れる側に倒してある。
  final int limit;

  final Set<String> _seen = <String>{};

  bool allow(String key) {
    if (_seen.contains(key)) return false;
    if (_seen.length >= limit) _seen.clear();
    _seen.add(key);
    return true;
  }

  void reset() => _seen.clear();
}

/// 送る直前に、本文が混ざっていないか落とす**最後の関門**。
///
/// ここが要るのは、こちらが積んでいない情報を SDK が勝手に足すため:
///
///   - **`enablePrintBreadcrumbs` の既定が true。** `debugPrint` の出力が
///     そのままパンくずになる。このアプリの `debugPrint` には `tex` の全文や
///     カルテ取得の失敗理由が入っているので、**既定のままだと本文が流れる**。
///     オプション側でも切っているが(二重に止める)、ここでも全部落とす。
///   - `request` にはAPIのURLが載る。本文は載らないが、監視に要らない。
///
/// **[SentryEvent] を返さないと送信そのものが止まる**ので、落とすのは中身だけ。
SentryEvent? scrubEvent(SentryEvent event, Hint hint) {
  // `copyWith` は非推奨(値を直接入れる形に変わった)。
  // `request` は null を代入して消す必要があるので、どのみち直接代入が要る。
  event.breadcrumbs = const <Breadcrumb>[];
  event.request = null;
  return event;
}

/// `tex` を送ってよい形に切る。[DegradationEvent.latexScaleFloor] の内側で呼ばれる。
String truncateTex(String tex) =>
    tex.length <= texPrefixLength ? tex : '${tex.substring(0, texPrefixLength)}…';

/// payload のどの文字列にも許す最大長。
///
/// **1フィールドに発話やカルテが丸ごと入らない、という上限。**
/// ここに来る文字列は本来ID・型名・診断文だけなので、200字あれば足りる。
/// 万一この先で自由文が混ざる書き方をしても、**流れる量を切り落とす**。
const int maxFieldLength = 200;

/// 縮退1件ぶんの中身。
///
/// **コンストラクタは private で、名前つきの生成子からしか作れない。**
/// [Telemetry.report] が生のMapを受け取らないのはそのためで、
/// 「payload に何を入れてよいか」の判断を**このファイルの外に出さない**。
/// 種類を足すときも、ここに生成子を1つ増やすことになる —— 送ってよいものの
/// 規則([SentryConfig] のコメント)が目に入る場所で書かれる。
///
/// ## 文字列を入れてよいのは3種類だけ
///
///   1. **ID**(`session_id` / `board_id`)
///   2. **型名・enum名**(`error` の `runtimeType` / `phase`)
///   3. **こちらが組み立てた診断文**(契約違反の理由。数値とIDだけでできている)
///
/// **唯一の例外が `tex`**。中身は数式なので送ってよいが、それでも
/// [texPrefixLength] 字までに切る。**切るのはここの内側**で、
/// 呼び出し側が全文を渡しても外には出ない。
///
/// 生徒の発話・transcript・カルテ本文・**問題文**を入れる生成子は無い。
/// 増やさないこと(問題文はR2にすら保存しないと決めたもの・計画書§4-1)。
@immutable
class DegradationEvent {
  const DegradationEvent._(this.kind, {required this.dedupeKey, required this.data});

  final Degradation kind;

  /// 「同じ出来事」の単位。板書がらみは `board_id`(1枚につき1件)。
  final String dedupeKey;

  final Map<String, Object?> data;

  /// 板書がとぎれた。
  ///
  /// [reason] は `BoardContractViolation` が組み立てた文で、seq と index の話しかない
  /// (生徒の発話も問題文も入らない)。それでも [maxFieldLength] で頭を押さえる。
  factory DegradationEvent.boardGap({
    required String sessionId,
    required String? boardId,
    required String reason,
    required int stepsSoFar,
  }) {
    return DegradationEvent._(
      Degradation.boardGap,
      // 板書IDが取れないほど早く壊れたときは、セッション単位に落とす。
      dedupeKey: boardId ?? sessionId,
      data: _sanitize(<String, Object?>{
        'session_id': sessionId,
        'board_id': boardId,
        'reason': reason,
        'steps_so_far': stepsSoFar,
      }),
    );
  }

  /// LaTeX が縮小率の下限を割り、横スクロールに落ちた。
  ///
  /// **[tex] は全文で渡してよい。** ここで切る。
  factory DegradationEvent.latexScaleFloor({
    required String tex,
    required double scale,
    required double minScale,
    required double availableWidth,
    required double naturalWidth,
  }) {
    final String prefix = truncateTex(tex);
    return DegradationEvent._(
      Degradation.latexScaleFloor,
      // この層は `board_id` を知らないので、式ごとに1件。
      // 同じ式が何度描き直されても1件、別の式なら別件で飛ぶ。
      dedupeKey: prefix,
      data: _sanitize(<String, Object?>{
        'tex': prefix,
        'scale': double.parse(scale.toStringAsFixed(3)),
        'min_scale': minScale,
        'available_width': availableWidth.round(),
        'natural_width': naturalWidth.round(),
      }),
    );
  }

  /// 板書の実効幅が実測の前提を割った。**数値しか入らない。**
  factory DegradationEvent.boardTooNarrow({
    required double availableWidth,
    required double assumedWidth,
  }) {
    return DegradationEvent._(
      Degradation.boardTooNarrow,
      dedupeKey: availableWidth.round().toString(),
      data: _sanitize(<String, Object?>{
        'available_width': availableWidth.round(),
        'assumed_width': assumedWidth,
      }),
    );
  }

  /// 図のSVGを描けなかった。**SVG本文は受け取らない**ので、監視へ流しようがない。
  factory DegradationEvent.figureSvgFailed({
    required int svgLength,
    required Type error,
  }) {
    return DegradationEvent._(
      Degradation.figureSvgFailed,
      // 同じSVGの再buildは1件にする。本文のhashを持たず、長さで図ごとに近似する。
      dedupeKey: '${error.toString()}/$svgLength',
      data: _sanitize(<String, Object?>{
        'svg_length': svgLength,
        'error': error.toString(),
      }),
    );
  }

  /// 「うまく言えない」を送れなかった。
  ///
  /// **パスの文言は受け取らない。** 引数に無いので、渡しようがない。
  /// [error] も型だけ受け取る —— 例外の `toString()` は接続先URLやトークンの
  /// 断片を含むことがあるので、`runtimeType` を渡すこと。
  factory DegradationEvent.passNotSent({
    required String? sessionId,
    required String phase,
    required Type error,
  }) {
    return DegradationEvent._(
      Degradation.passNotSent,
      // 1セッションに1件。同じ会話で何度も詰まるのは**正常**なので、
      // そのたびに飛ばすと「送信経路が壊れている」ほうが埋もれる。
      dedupeKey: sessionId ?? 'unknown',
      data: _sanitize(<String, Object?>{
        'session_id': sessionId,
        'phase': phase,
        'error': error.toString(),
      }),
    );
  }

  /// 類題の本人申告を送れなかった。
  ///
  /// **申告の文言は受け取らない。**「できた / できなかった」のどちらだったかも
  /// 送らない —— 送信できなかった事実と、どこで起きたかで足りる。
  /// [error] は [DegradationEvent.passNotSent] と同じ理由で型だけ受け取る。
  factory DegradationEvent.solvingReportNotSent({
    required String? sessionId,
    required String phase,
    required Type error,
  }) {
    return DegradationEvent._(
      Degradation.solvingReportNotSent,
      // パスと同じく1セッションに1件。送信経路が壊れている事実が知りたいので、
      // 同じ会話で二度押されたぶんを別々に飛ばしても情報は増えない。
      dedupeKey: sessionId ?? 'unknown',
      data: _sanitize(<String, Object?>{
        'session_id': sessionId,
        'phase': phase,
        'error': error.toString(),
      }),
    );
  }

  /// 「わかった」の制御通知を送れなかった。
  ///
  /// 到達の宣言には自由文が無いので、失敗した事実・場所・例外型だけを持つ。
  /// [error] は接続先やトークンを混ぜないよう、例外本文ではなく型だけを受け取る。
  factory DegradationEvent.understoodNotSent({
    required String? sessionId,
    required String phase,
    required Type error,
  }) {
    return DegradationEvent._(
      Degradation.understoodNotSent,
      // ボタン自体を1回で塞ぐが、再buildや将来の再試行が入っても
      // 同じセッションの通信不調を重ねて数えない。
      dedupeKey: sessionId ?? 'unknown',
      data: _sanitize(<String, Object?>{
        'session_id': sessionId,
        'phase': phase,
        'error': error.toString(),
      }),
    );
  }

  /// 文字列は長さで頭を押さえる。**最後の安全弁**で、通常はここで切れない。
  static Map<String, Object?> _sanitize(Map<String, Object?> data) {
    return data.map((String key, Object? value) {
      if (value is! String || value.length <= maxFieldLength) {
        return MapEntry<String, Object?>(key, value);
      }
      return MapEntry<String, Object?>(key, '${value.substring(0, maxFieldLength)}…');
    });
  }
}

abstract final class Telemetry {
  static final DegradationThrottle _throttle = DegradationThrottle();

  /// テスト用。間引きの記憶を消す。
  @visibleForTesting
  static void resetThrottle() => _throttle.reset();

  /// アプリを監視つきで起動する。
  ///
  /// DSN が無ければ**初期化ごと飛ばして**そのまま起動する。監視の有無で
  /// アプリの挙動が変わらないようにするため(手元とCIは常にこちらを通る)。
  static Future<void> runWithMonitoring(FutureOr<void> Function() appRunner) async {
    if (!SentryConfig.isConfigured) {
      await appRunner();
      return;
    }

    await SentryFlutter.init(
      (SentryFlutterOptions options) {
        options.dsn = SentryConfig.dsn;

        // --- 本文を送らないための設定(ユーザーは未成年) ---

        // 画面をそのまま送る設定。**ノートと問題の写真が写る。**
        // 既定は false だが、既定に頼らず明示する(既定が変わったら気づけない)。
        options.attachScreenshot = false;

        // ウィジェットの木。テキストの中身が載りうるので使わない。
        // (SDK側では experimental 扱いだが、**既定に頼らず切っておく**ほうが安全。
        //  将来この項目が消えたらコンパイルが落ちて気づける。)
        // ignore: experimental_member_use
        options.attachViewHierarchy = false;

        // 端末やユーザーを特定しうる情報。匿名のデバイスIDだけで運用する。
        options.sendDefaultPii = false;

        // **既定 true。`debugPrint` がそのままパンくずになる。**
        // このアプリの `debugPrint` には `tex` の全文や失敗理由が入っている。
        options.enablePrintBreadcrumbs = false;

        // ネイティブ側のパンくず(タップした要素のラベルなど)も止める。
        options.enableAutoNativeBreadcrumbs = false;

        // 最後の関門。上をすり抜けたものはここで落とす。
        options.beforeSend = scrubEvent;

        // パンくずはそもそも溜めない(溜めなければ漏れようがない)。
        options.beforeBreadcrumb = (Breadcrumb? breadcrumb, Hint hint) => null;

        // 性能計測はしない。縮退とクラッシュだけを見る。
        options.tracesSampleRate = 0;
      },
      appRunner: () async => appRunner(),
    );
  }

  /// 縮退を1件記録する。
  ///
  /// **`captureException` は使わない。** 落ちてはいないので、
  /// クラッシュと同じ棚に積むと本当に落ちたものが埋もれる(§10-7)。
  ///
  /// **生のMapを受け取らない。** 何を送ってよいかの判断を呼び出し側に配ると、
  /// 種類が増えるたびに同じ判断をやり直すことになる(そして1回間違えば漏れる)。
  /// [DegradationEvent] の生成子だけが入口。
  static void report(DegradationEvent event) {
    // 監視の有無にかかわらず、手元では今までどおり見えるようにしておく。
    debugPrint('[${event.kind.id}] ${event.data}');

    if (!SentryConfig.isConfigured) return;
    if (!_throttle.allow('${event.kind.id}/${event.dedupeKey}')) return;

    unawaited(
      Sentry.captureMessage(
        event.kind.id,
        level: SentryLevel.warning,
        withScope: (Scope scope) async {
          // タグにしておくと Sentry 側で種類ごとに絞れる。
          await scope.setTag('degradation', event.kind.id);
          await scope.setContexts(event.kind.id, event.data);
        },
      ),
    );
  }
}
