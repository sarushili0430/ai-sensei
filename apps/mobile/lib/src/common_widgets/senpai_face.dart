import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../theme/motion.dart';
import '../theme/tokens.dart';

/// 先輩の表情(「最大の報酬はキャラの表情」)。
///
/// **報酬の位置はピボットで動いていない。** 後輩に説明が伝わって顔が輝く、が
/// 先輩に教え返せて「そう、それ」に変わっただけで、
/// いちばん嬉しい瞬間に顔が輝くという構造は同じ(ピボット計画§2のコアループ)。
///
/// v0はCustomPaintの簡素な自作。表情差分3〜5枚から始め、
/// v1.1でRiveのステートマシンに載せ替える(そのとき差し替えるのはこのWidgetだけ)。
///
/// 動きは2系統ある。**いつも動いているもの**(呼吸・まばたき・うなずき)は
/// [AppDurations.breath] を周期にした1本のコントローラから作り、
/// **表情が変わった瞬間だけのもの**(納得したときのはずみ・きらり)は
/// 別のコントローラで一度だけ再生する。
/// 生きている感じは前者が、ご褒美は後者が担当する。
enum SenpaiMood {
  /// 待機。まだ始まっていない、または**ただ受け取った**。
  ///
  /// 「うまく言えない」を押したあともここに留まる。詳しくは [puzzled] を参照。
  neutral,

  /// 聞いている。教え返しを受け取っている最中。うなずきの微アニメーション。
  listening,

  /// 「そう、それ」。**教え返しが伝わった瞬間**の最大の報酬。
  ///
  /// 配役が変わっても、ここが体験の頂点であることは変わらない。
  /// 後輩版では「わかった!」だったものが、先輩の承認に置き換わっただけ。
  delighted,

  /// **困っているのは先輩のほう。** 生徒に向ける顔ではない。
  ///
  /// ここが後輩版といちばん意味が違う。後輩の困り顔は
  /// 「聞いても分からなかった」= 教わる側の困惑で、相手(生徒)の説明が
  /// 足りないことを指していた。先輩は分かっている側なので、同じ絵を
  /// 同じ意味では使えない。**逆に、うまくいかなかった責任をこちらが引き取る顔**
  /// として定義し直す:
  ///
  ///   - 先輩が来られなかった・つながらなかった(こちら側の不首尾)
  ///
  /// 汗のしずくが乗っているのは、そのため。**生徒が詰まったときには使わない。**
  /// 詰まったのは織り込み済みの出来事(それを見つけに来ている)なので、
  /// そこで顔が困ると、パスが失敗として演出されてしまう(§0 の約束3)。
  /// 詰まったときは [neutral] のまま受け取り、言葉とマーカーだけで応える。
  puzzled,
}

class SenpaiFace extends StatefulWidget {
  const SenpaiFace({required this.mood, this.size = 120, super.key});

  final SenpaiMood mood;
  final double size;

  @override
  State<SenpaiFace> createState() => _SenpaiFaceState();
}

class _SenpaiFaceState extends State<SenpaiFace> with TickerProviderStateMixin {
  /// 呼吸・まばたき・うなずきの元になる位相。0→1を延々と繰り返す。
  late final AnimationController _ambient = AnimationController(
    vsync: this,
    duration: AppDurations.breath,
  );

  /// 表情が切り替わった瞬間だけ動く。初期値1(=切り替え済み)で置く。
  late final AnimationController _mood = AnimationController(
    vsync: this,
    duration: AppDurations.celebrate,
    value: 1,
  );

  bool _configured = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_configured) return;
    _configured = true;

    // 動かさない設定のときは、位相を0に固定したまま回さない。
    // 0 は sin が 0 の点なので、そのまま「息を吸う前」の静止画になる。
    if (!AppMotion.isReduced(context)) _ambient.repeat();
  }

  @override
  void didUpdateWidget(SenpaiFace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.mood == widget.mood) return;

    _mood
      ..duration = AppMotion.decorative(
        context,
        // 納得した瞬間だけは、ゆっくり見せる。ここが報酬なので。
        widget.mood == SenpaiMood.delighted ? AppDurations.celebrate : AppDurations.reaction,
      )
      ..forward(from: 0);
  }

  @override
  void dispose() {
    _ambient.dispose();
    _mood.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // 読み上げのラベルは毎フレーム作り直さない(builderの外で1回だけ引く)。
    final AppStrings strings = AppStrings.of(context);

    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[_ambient, _mood]),
      builder: (BuildContext context, Widget? child) {
        final double phase = _ambient.value;
        final double wave = math.sin(phase * 2 * math.pi);
        final double moodT = _mood.value;

        // 呼吸。ふくらむ量はごく小さくていい。大きくすると、
        // 待っているだけの画面が落ち着かなくなる。
        double scale = 1 + 0.022 * wave;

        // 納得した瞬間のはずみ。行き過ぎて戻る。
        if (widget.mood == SenpaiMood.delighted) {
          scale += 0.13 * math.sin(moodT * math.pi);
        }

        // うなずき。呼吸の3倍の速さで、下に沈んで戻る。
        double dy = 0;
        if (widget.mood == SenpaiMood.listening) {
          final double nod = (phase * 3) % 1;
          dy = widget.size * 0.022 * (1 - math.cos(nod * 2 * math.pi)) / 2;
        }

        // うれしさは、最初のはずみで終わらない。
        //
        // 祝福画面は**何かを待たせることがある**画面で、はずみが一度きりだと
        // そのあと動きが消えて止まって見える。跳ねは呼吸の位相から作るので
        // タイマーは増えず、動かすのも Transform だけ(顔の描き直しは増えない)。
        if (widget.mood == SenpaiMood.delighted) {
          dy -= widget.size * 0.018 * math.max(0, math.sin(phase * 4 * math.pi));
        }

        // 首をかしげる。困っているのはこちらで、相手を責めてはいない。
        final double tilt = widget.mood == SenpaiMood.puzzled ? 0.05 + 0.015 * wave : 0;

        return AnimatedContainer(
          duration: AppDurations.reaction,
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: widget.mood == SenpaiMood.delighted
                ? AppColors.said.withValues(alpha: 0.25)
                : AppColors.blue.withValues(alpha: 0.12),
            shape: BoxShape.circle,
          ),
          child: Semantics(
            label: switch (widget.mood) {
              SenpaiMood.neutral => strings.senpaiWaiting,
              SenpaiMood.listening => strings.senpaiListening,
              SenpaiMood.delighted => strings.senpaiDelighted,
              SenpaiMood.puzzled => strings.senpaiPuzzled,
            },
            child: Transform.translate(
              offset: Offset(0, dy),
              child: Transform.rotate(
                angle: tilt,
                child: Transform.scale(
                  scale: scale,
                  // 顔は常に動いている。まわりを巻き込んで塗り直さないよう囲う。
                  child: RepaintBoundary(
                    child: CustomPaint(
                      painter: _FacePainter(
                        mood: widget.mood,
                        phase: phase,
                        moodT: moodT,
                        eyeOpenness: _eyeOpenness(phase),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  /// まばたき。周期の終わりぎわに一度だけ閉じる。
  /// 呼吸と同じ位相から作っているので、タイマーを増やさずに済む。
  double _eyeOpenness(double phase) {
    const double start = 0.90;
    const double end = 0.96;
    if (phase < start || phase > end) return 1;
    return 1 - math.sin((phase - start) / (end - start) * math.pi);
  }
}

class _FacePainter extends CustomPainter {
  const _FacePainter({
    required this.mood,
    required this.phase,
    required this.moodT,
    required this.eyeOpenness,
  });

  final SenpaiMood mood;
  final double phase;
  final double moodT;
  final double eyeOpenness;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint stroke = Paint()
      ..color = AppColors.ink
      ..strokeWidth = size.width * 0.045
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    final double eyeY = size.height * 0.42;
    final double eyeDx = size.width * 0.19;
    final double eyeRadius = size.width * 0.045;

    if (mood == SenpaiMood.delighted) {
      // ^ ^ の目。輝きは色(背景)と目の形の両方で出す。
      for (final double sign in <double>[-1, 1]) {
        final Path path = Path()
          ..moveTo(size.width / 2 + sign * eyeDx - eyeRadius * 1.6, eyeY + eyeRadius)
          ..lineTo(size.width / 2 + sign * eyeDx, eyeY - eyeRadius)
          ..lineTo(size.width / 2 + sign * eyeDx + eyeRadius * 1.6, eyeY + eyeRadius);
        canvas.drawPath(path, stroke);
      }
      _paintSparkles(canvas, size);
    } else {
      final Paint fill = Paint()..color = AppColors.ink;
      final double radius = eyeRadius * (mood == SenpaiMood.listening ? 1.15 : 1.0);

      for (final double sign in <double>[-1, 1]) {
        final Offset center = Offset(size.width / 2 + sign * eyeDx, eyeY);
        if (eyeOpenness > 0.15) {
          // まぶたは上から降りてくる。円を縦につぶすと目を閉じた形になる。
          canvas.drawOval(
            Rect.fromCenter(center: center, width: radius * 2, height: radius * 2 * eyeOpenness),
            fill,
          );
        } else {
          canvas.drawLine(
            Offset(center.dx - radius, center.dy),
            Offset(center.dx + radius, center.dy),
            stroke,
          );
        }
      }
    }

    // 口。困り顔でも口角は下げない(責める顔にしないため)。
    //
    // うれしいときだけ、笑い方が少し揺れる。**同じ絵のまま置いておかない**
    // ための揺れなので、幅はごく小さくていい(呼吸と同じ位相から作る)。
    final double mouthY = size.height * 0.63;
    final double smile = mood == SenpaiMood.delighted
        ? 0.16 * (1 + 0.10 * math.sin(phase * 2 * math.pi))
        : 0.08;
    final Rect mouth = Rect.fromCenter(
      center: Offset(size.width / 2, mouthY),
      width: size.width * 0.26,
      height: size.height * smile,
    );
    canvas.drawArc(mouth, 0.15, 2.85, false, stroke);

    if (mood == SenpaiMood.puzzled) _paintSweat(canvas, size);
  }

  /// 「?」ではなく、小さな汗。疑問符は問い詰める印象になる。
  /// ゆっくり伝って、消えて、また出る。
  ///
  /// **汗は「こちらの不首尾」の印。** 分かっている側が汗をかいているので、
  /// 生徒に向けた表情として使うと意味が反転する([SenpaiMood.puzzled])。
  void _paintSweat(Canvas canvas, Size size) {
    final double drip = (phase * 2) % 1;
    final Offset center = Offset(size.width * 0.78, size.height * (0.30 + 0.12 * drip));
    canvas.drawCircle(
      center,
      size.width * 0.035,
      Paint()..color = AppColors.blue.withValues(alpha: 0.6 * (1 - drip)),
    );
  }

  /// 納得したときの「きらり」。
  ///
  /// 位置は固定(乱数を使わない)。撮るたびに違う絵になると
  /// golden で差分が出るし、そもそも毎回違う必要がない。
  void _paintSparkles(Canvas canvas, Size size) {
    const List<Offset> spots = <Offset>[
      Offset(0.12, 0.20),
      Offset(0.88, 0.16),
      Offset(0.94, 0.62),
      Offset(0.06, 0.60),
    ];

    final Paint paint = Paint()..color = AppColors.streak.withValues(alpha: 0.9 * moodT);
    // 出るのは一瞬ではなく、そのまま光っていてほしい。大きさだけ呼吸させる。
    final double twinkle = 1 + 0.15 * math.sin(phase * 2 * math.pi);

    for (int i = 0; i < spots.length; i++) {
      final Offset spot = spots[i];
      final double radius = size.width * (i.isEven ? 0.045 : 0.033) * moodT * twinkle;
      final Offset center = Offset(spot.dx * size.width, spot.dy * size.height);

      // 4つの角がとがった星。円より「きらり」に見える。
      final Path path = Path()
        ..moveTo(center.dx, center.dy - radius)
        ..quadraticBezierTo(center.dx, center.dy, center.dx + radius, center.dy)
        ..quadraticBezierTo(center.dx, center.dy, center.dx, center.dy + radius)
        ..quadraticBezierTo(center.dx, center.dy, center.dx - radius, center.dy)
        ..quadraticBezierTo(center.dx, center.dy, center.dx, center.dy - radius)
        ..close();
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(_FacePainter oldDelegate) =>
      oldDelegate.mood != mood ||
      oldDelegate.phase != phase ||
      oldDelegate.moodT != moodT ||
      oldDelegate.eyeOpenness != eyeOpenness;
}
