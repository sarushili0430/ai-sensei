import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// Centers content when it fits, scrolls only when it does not.
/// Centering alone overflows at large text sizes; scrolling alone
/// pins content to the top on roomy screens.
class CenteredScroll extends StatelessWidget {
  const CenteredScroll({
    required this.children,
    this.padding = const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
    super.key,
  });

  final List<Widget> children;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double minHeight = constraints.hasBoundedHeight
            ? (constraints.maxHeight - padding.vertical).clamp(0.0, double.infinity)
            : 0.0;

        return SingleChildScrollView(
          padding: padding,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children,
            ),
          ),
        );
      },
    );
  }
}
