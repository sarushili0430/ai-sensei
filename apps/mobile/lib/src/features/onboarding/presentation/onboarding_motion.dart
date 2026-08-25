import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../theme/motion.dart';
import '../../../theme/tokens.dart';

/// オンボーディング専用の動きの部品。
///
/// **新しい動きの語彙は増やさない。**ここにあるのは、既存の
/// [FadeSlideIn] / [PopIn] / [MarkerText] / [BoardReveal] が持っている
/// 「遅らせて始める → 減らす設定なら終わった状態で置く → dispose で片づける」
/// という同じ形を、オンボーディングでしか要らない絵に当てはめ直したものだけ。
/// 時間もカーブも `AppDurations` / `AppCurves` から取る(ADR 0004 の1経路)。
///
/// **ループするものは必ず [AppMotion.isReduced] を見る。**通していないループを
/// 混ぜると `pumpAndSettle` が返らなくなり、テストが返ってこない形で落ちる。

/// 何枚目まで来たかの棒。
///
/// 点(旧 `_Dots`)から棒に替えてある。点は「何枚あるか」は言えるが
/// **「あとどれだけか」を言えない**。枚数が増えたぶん、残りが目で測れる形の
/// ほうが最後まで連れていける(Mobbin の学習アプリ — Brilliant / Duolingo /
/// Uxcel が揃ってこの形を上に置いている)。
///
/// 読み上げには枚数を言葉で渡す。棒そのものは装飾なので、
/// [Semantics.label] に [label] を入れて絵を隠す。
class OnboardingProgressBar extends StatelessWidget {
  const OnboardingProgressBar({
    required this.value,
    required this.label,
    super.key,
  });

  /// 0(まだ何も進んでいない)〜 1(最後の枚)。
  final double value;

  /// 読み上げ用の「5枚中3枚目」。
  final String label;

  static const double _height = 6;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      value: '${(value * 100).round()}%',
      child: ExcludeSemantics(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.chip),
          child: SizedBox(
            height: _height,
            child: Stack(
              children: <Widget>[
                const ColoredBox(
                  color: AppColors.border,
                  child: SizedBox.expand(),
                ),
                // 伸びるところを見せる。棒が伸びる動きそのものが「進んだ」の
                // 手ごたえなので、瞬間で置き換えない。
                TweenAnimationBuilder<double>(
                  tween: Tween<double>(begin: 0, end: value.clamp(0.0, 1.0)),
                  duration: AppMotion.decorative(context, AppDurations.reaction),
                  curve: AppCurves.enter,
                  builder: (BuildContext context, double current, Widget? child) =>
                      FractionallySizedBox(
                    widthFactor: current,
                    alignment: Alignment.centerLeft,
                    child: child,
                  ),
                  child: const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: <Color>[AppColors.blue, AppColors.streak],
                      ),
                    ),
                    child: SizedBox.expand(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 先輩の後ろで、ゆっくり息をしている光。
///
/// 周期は [AppDurations.breath] — **顔の呼吸と同じ**。別の周期にすると、
/// 光と顔が独立に動いて2つの生き物に見える。
///
/// 減らす設定では**いちばん膨らんだところで止める**。0で止めると光が消え、
/// 顔だけが地に浮いた別の絵になる(ADR 0004「出さないときは終わった状態を描く」)。
class AmbientHalo extends StatefulWidget {
  const AmbientHalo({
    required this.child,
    this.color = AppColors.blue,
    this.size = 260,
    super.key,
  });

  final Widget child;
  final Color color;

  /// いちばん膨らんだときの直径。
  final double size;

  @override
  State<AmbientHalo> createState() => _AmbientHaloState();
}

class _AmbientHaloState extends State<AmbientHalo> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppDurations.breath,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = 1;
      return;
    }
    _controller.repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Animation<double> breath =
        CurvedAnimation(parent: _controller, curve: AppCurves.breathe);

    return Stack(
      alignment: Alignment.center,
      children: <Widget>[
        AnimatedBuilder(
          animation: breath,
          builder: (BuildContext context, Widget? child) {
            final double scale = 0.88 + 0.12 * breath.value;
            return IgnorePointer(
              child: Opacity(
                opacity: 0.5 + 0.3 * breath.value,
                child: Transform.scale(scale: scale, child: child),
              ),
            );
          },
          child: SizedBox(
            width: widget.size,
            height: widget.size,
            child: DecoratedBox(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: <Color>[
                    widget.color.withValues(alpha: 0.18),
                    widget.color.withValues(alpha: 0),
                  ],
                ),
              ),
            ),
          ),
        ),
        widget.child,
      ],
    );
  }
}

/// 上から降ってきて、少し行き過ぎてから収まる。
///
/// 通知の見本のように「**届いた**」ことが要る絵にだけ使う。行き過ぎて戻る
/// [AppCurves.pop] は、にぎやかな画面でしか使わない決まり(`tokens.dart`)なので、
/// カルテ・復習の本編には持ち込まない。
class DropIn extends StatefulWidget {
  const DropIn({
    required this.child,
    this.delay = Duration.zero,
    this.offset = 40,
    super.key,
  });

  final Widget child;
  final Duration delay;

  /// 何ピクセル上から降ってくるか。
  final double offset;

  @override
  State<DropIn> createState() => _DropInState();
}

class _DropInState extends State<DropIn> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppDurations.celebrate,
  );
  Timer? _timer;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = 1;
      return;
    }
    if (widget.delay == Duration.zero) {
      _controller.forward();
    } else {
      _timer = Timer(widget.delay, () {
        if (mounted) _controller.forward();
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) {
        // 位置だけ行き過ぎさせる。透明度まで `pop` に通すと 1 を越えて
        // clamp され、最後のひと押しが見えなくなる。
        final double slide = AppCurves.pop.transform(_controller.value);
        return Opacity(
          opacity: _controller.value.clamp(0.0, 1.0),
          child: Transform.translate(
            offset: Offset(0, -widget.offset * (1 - slide)),
            child: child,
          ),
        );
      },
      child: widget.child,
    );
  }
}

/// 縦の年表の1行。
class TrailNode {
  const TrailNode({
    required this.icon,
    required this.tint,
    required this.child,
  });

  final IconData icon;

  /// 印の色。**最後の1つだけ色を変える**使い方を想定している
  /// (そこが持ち帰るもの、または折り返し地点)。
  final Color tint;

  /// 印の右に置く中身。見出しだけのことも、見出し+注記のこともある。
  final Widget child;
}

/// 上から下へ線が引かれ、線の先が届いた印だけが現れる年表。
///
/// **「4つの手順」と「今日 → 3日後 → 7日後」の両方がこれ。**同じ絵にして
/// あるのは、オンボーディングが説明しているのが**1本の道**だからで、
/// 途中で図法が変わると、後半が別の話に見える。
///
/// 動きは [MarkerText] と同じ発想 — ペン先(= 線の先)が通り過ぎたところまでが
/// 見える。減らす設定では線も印も**引き終わった状態**で置く。
class RevealTrail extends StatefulWidget {
  const RevealTrail({
    required this.nodes,
    this.delay = Duration.zero,
    this.rowGap = AppSpacing.md,
    super.key,
  });

  final List<TrailNode> nodes;
  final Duration delay;

  /// 行のあいだ。**中身が2行ある年表では詰める。**
  /// 見出し+注記の行は自前で高さを持っているので、既定のままだと
  /// 下にぶら下がる注記が折り返しの外へ出る(375×667の英語で実測)。
  final double rowGap;

  /// 印1つぶんを引く時間。全体はこれ×本数になる。
  static const Duration perNode = AppDurations.draw;

  @override
  State<RevealTrail> createState() => _RevealTrailState();
}

class _RevealTrailState extends State<RevealTrail> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: RevealTrail.perNode * widget.nodes.length,
  );
  Timer? _timer;
  bool _started = false;

  static const double _badge = 40;

  /// 印から印へ続く線の太さ。
  static const double _lineWidth = 2;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;

    if (AppMotion.isReduced(context)) {
      _controller.value = 1;
      return;
    }
    if (widget.delay == Duration.zero) {
      _controller.forward();
    } else {
      _timer = Timer(widget.delay, () {
        if (mounted) _controller.forward();
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  /// [index] 番目の印から見た進み具合(0 = まだ、1 = 引き終わった)。
  double _localProgress(double value, int index) =>
      (value * widget.nodes.length - index).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            for (int i = 0; i < widget.nodes.length; i++)
              _buildRow(context, i, _localProgress(_controller.value, i)),
          ],
        );
      },
    );
  }

  Widget _buildRow(BuildContext context, int index, double progress) {
    final TrailNode node = widget.nodes[index];
    final bool isLast = index == widget.nodes.length - 1;
    // 印は線より先に立ち上がる。線が到達してから印が出ると、
    // 線だけが宙に伸びている時間ができる。
    final double badge = (progress * 1.6).clamp(0.0, 1.0);

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Column(
            children: <Widget>[
              Transform.scale(
                scale: 0.7 + 0.3 * AppCurves.pop.transform(badge).clamp(0.0, 1.0),
                child: Opacity(
                  opacity: badge,
                  child: Container(
                    width: _badge,
                    height: _badge,
                    decoration: BoxDecoration(
                      color: node.tint.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(AppRadius.button),
                    ),
                    child: Icon(node.icon, size: 20, color: node.tint),
                  ),
                ),
              ),
              // 次の印へ続く線。1本道であることが縦に見える。
              //
              // **伸ばすのは塗りで、高さではない。** 高さを割合で決めると
              // ([FractionallySizedBox])、上の [IntrinsicHeight] が固有高さを
              // 聞きにきたときに「子の固有高さ ÷ 割合」を返す実装に当たる。
              // 引き始めの割合は 0 なので 0÷0 になり、**行の高さが無限**になる。
              // debug なら「BoxConstraints forces an infinite height」で落ちるが、
              // **release は落ちずにそのまま描く** —— 見出しと年表が同じ場所に
              // 重なって出る一瞬(実機で確認)は、これが正体だった。
              if (!isLast)
                Expanded(
                  child: CustomPaint(
                    painter: _TrailLine(progress: progress),
                    // 幅だけ持つ。高さは [Expanded] が決めるので、
                    // 固有高さは 0 のままでいい。
                    child: const SizedBox(width: _lineWidth),
                  ),
                ),
            ],
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Opacity(
              opacity: badge,
              child: Transform.translate(
                offset: Offset(0, 8 * (1 - badge)),
                child: Padding(
                  padding: EdgeInsets.only(
                    top: AppSpacing.sm,
                    bottom: widget.rowGap,
                  ),
                  child: node.child,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 印から印へ続く線。**引かれたぶんだけ**上から塗る。
///
/// 塗る量で伸ばすので、行の高さは引き始めから引き終わりまで動かない
/// ([_RevealTrailState._buildRow] の説明)。1フレームごとの再レイアウトも
/// 消えて、[IntrinsicHeight] を毎フレーム測り直さずに済む。
class _TrailLine extends CustomPainter {
  const _TrailLine({required this.progress});

  /// 0 = まだ引いていない、1 = 次の印まで届いた。
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final double drawn = size.height * progress.clamp(0.0, 1.0);
    if (drawn <= 0) return;

    canvas.drawRect(
      Rect.fromLTWH(0, 0, size.width, drawn),
      Paint()..color = AppColors.border,
    );
  }

  @override
  bool shouldRepaint(_TrailLine oldDelegate) => oldDelegate.progress != progress;
}

/// 採点しているあいだの3つの点。
///
/// 復習画面の `_GradingDots` と**同じ絵**にしてある。リハーサルで見た待ち方と
/// 本番の待ち方が違うと、この枚が下見として働かない。
///
/// 減らす設定では**3つとも点いた状態**で止める。消えたままだと、
/// 待っていることが画面から消える。
class GradingDots extends StatefulWidget {
  const GradingDots({this.color = AppColors.blue, super.key});

  final Color color;

  @override
  State<GradingDots> createState() => _GradingDotsState();
}

class _GradingDotsState extends State<GradingDots> with SingleTickerProviderStateMixin {
  static const int _count = 3;

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppDurations.breath ~/ 3,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (AppMotion.isReduced(context)) return;
    _controller.repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool reduced = AppMotion.isReduced(context);

    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) => Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < _count; i++)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: Opacity(
                opacity: reduced ? 1 : _opacityAt(i),
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: widget.color,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 3つの点を順に明るくする。位相を 1/3 ずつずらした正弦波。
  double _opacityAt(int index) {
    final double phase = (_controller.value - index / _count) % 1.0;
    return 0.3 + 0.7 * (0.5 + 0.5 * math.cos(2 * math.pi * phase));
  }
}

/// 先輩のふきだし。しっぽを左に向けて、話しているのが顔の側だと分かるようにする。
///
/// **オンボーディングの質問はぜんぶこの形**(Mobbin の学習アプリが揃って
/// 置いている「マスコット + ふきだしで1問だけ聞く」)。同じ形にしてあるので、
/// 学年を聞く枚も、板書のあとの一言も、**同じ人が喋っている**ように読める。
class SenpaiBubble extends StatelessWidget {
  const SenpaiBubble({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        const CustomPaint(size: Size(8, 14), painter: _TailPainter()),
        Expanded(
          child: Container(
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: AppColors.blue.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(AppRadius.card),
            ),
            child: child,
          ),
        ),
      ],
    );
  }
}

class _TailPainter extends CustomPainter {
  const _TailPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final Path path = Path()
      ..moveTo(size.width, 0)
      ..lineTo(0, size.height / 2)
      ..lineTo(size.width, size.height)
      ..close();
    canvas.drawPath(path, Paint()..color = AppColors.blue.withValues(alpha: 0.08));
  }

  @override
  bool shouldRepaint(_TailPainter oldDelegate) => false;
}
