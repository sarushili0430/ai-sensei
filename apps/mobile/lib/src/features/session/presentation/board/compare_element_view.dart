import 'package:flutter/material.dart';

import '../../../../theme/tokens.dart';
import 'board_style.dart';

/// A two-column comparison (`BoardElement.compare`), e.g. present perfect vs
/// past simple.
///
/// Fixed at two columns: three do not fit an effective width of 340pt
/// (`BoardStyle.measuredWidthAssumption`), and English grammar comparisons are
/// almost always between two options, so a variable column count buys nothing.
/// `ensureValidCompare` checks the count on receipt.
///
/// `Table` is used so both columns split at the same ratio. `Row` + `Expanded`
/// would vary the width per row, leaving a table that cannot be read down.
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
    // Cell text is chalk too. Left at the theme default (ink) it would be black
    // on black, leaving only the table's rules visible.
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
            // Split the two columns evenly. Sizing by heading length would move
            // the boundary per row and destroy the comparison.
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
