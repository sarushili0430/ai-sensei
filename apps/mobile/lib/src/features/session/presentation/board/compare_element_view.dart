import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import 'board_style.dart';

/// 2列の対比表(`BoardElement.compare`)。「現在完了 と 過去形」。
///
/// **2列で固定。** 実効幅340pt(`BoardStyle.measuredWidthAssumption`)に3列は
/// 入らず、英語の文法の対比はほとんどが2項の使い分けなので、列を可変にする
/// 意味がない。列数の検査は `ensureValidCompare` が受信時に持つ。
///
/// `Table` を使うのは、2列の幅を中身に合わせて**同じ比率で**割るため。
/// `Row` + `Expanded` だと行ごとに幅が変わり、縦に読めない表になる。
class CompareElementView extends StatelessWidget {
  const CompareElementView({
    required this.columns,
    required this.rows,
    this.title,
    super.key,
  });

  final List<String> columns;
  final List<List<String>> rows;
  final String? title;

  @override
  Widget build(BuildContext context) {
    // **セルの文字もチョークで書く。**テーマの既定色(インク)のままだと、
    // 板の上では黒に黒で、表の枠だけが見えて中身が読めない。
    final TextTheme textTheme = Theme.of(context).textTheme.apply(
          bodyColor: BoardStyle.chalk,
          displayColor: BoardStyle.chalk,
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (title != null) ...<Widget>[
          Text(title!, style: textTheme.bodyMedium?.copyWith(color: BoardStyle.chalkMuted)),
          const SizedBox(height: AppSpacing.xs),
        ],
        DecoratedBox(
          decoration: BoxDecoration(
            border: Border.all(color: BoardStyle.chalkMuted),
            borderRadius: BorderRadius.circular(AppRadius.card),
          ),
          child: Table(
            // 2列を等分する。見出しの長さで幅が決まると、行によって
            // 境界の位置がずれて対比として読めなくなる。
            columnWidths: const <int, TableColumnWidth>{
              0: FlexColumnWidth(),
              1: FlexColumnWidth(),
            },
            border: const TableBorder.symmetric(
              inside: BorderSide(color: BoardStyle.chalkMuted),
            ),
            children: <TableRow>[
              TableRow(
                decoration: BoxDecoration(color: BoardStyle.chalk.withValues(alpha: 0.08)),
                children: <Widget>[
                  for (final String heading in columns)
                    _Cell(
                      text: heading,
                      style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
                    ),
                ],
              ),
              for (final List<String> row in rows)
                TableRow(
                  children: <Widget>[
                    for (final String cell in row) _Cell(text: cell, style: textTheme.bodyMedium),
                  ],
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Cell extends StatelessWidget {
  const _Cell({required this.text, this.style});

  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.sm),
      child: Text(text, style: style),
    );
  }
}
