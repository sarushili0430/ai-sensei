/// 自習室で先輩がかける声(計画書§4-2)。
///
/// **タイマーを増やさない。** 経過時間から引くだけの純粋な関数にしてあるので、
/// 声かけのために別のTimerやAnimationControllerを持つ必要がない
/// (画面が1秒ごとに塗り直すとき、ついでにここが切り替わる)。
///
/// 頻度は「たまに」。1時間で3回しか変わらない。自習の邪魔をするのが目的ではなく、
/// **隣に人がいる**ことが分かればいいので、これで足りる。
enum SenpaiNudge {
  /// 入ってきた直後。「呼んでいい」ことを最初に言っておく
  /// (課金の切れ目は「先輩、ちょっといい?」なので、押していいと知らせる必要がある)。
  start,

  /// 10分。まだ様子見。
  going,

  /// 25分。集中が切れはじめるあたり。
  takeABreak,

  /// 50分。ここまで来たら休ませる。
  longHaul;

  /// 経過時間から、いま出す声を決める。
  ///
  /// 区切りは「ポモドーロ(25分)」を意識しているが、タイマーとしては
  /// 実装しない。**測って知らせる装置にはしない**(点数を出さないのと同じ理由で、
  /// 自習室に達成の目盛りを持ち込まない)。
  static SenpaiNudge forElapsed(Duration elapsed) {
    if (elapsed >= const Duration(minutes: 50)) return SenpaiNudge.longHaul;
    if (elapsed >= const Duration(minutes: 25)) return SenpaiNudge.takeABreak;
    if (elapsed >= const Duration(minutes: 10)) return SenpaiNudge.going;
    return SenpaiNudge.start;
  }
}
