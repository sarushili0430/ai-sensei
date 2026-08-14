import 'package:flutter/material.dart';

import 'tokens.dart';

/// App theme. Colors live in tokens and screens add the liveliness,
/// so the theme itself defaults to the quiet state.
abstract final class AppTheme {
  static const String fontFamily = 'ZenMaruGothic';

  static ThemeData light() {
    const ColorScheme scheme = ColorScheme.light(
      primary: AppColors.blue,
      secondary: AppColors.streak,
      surface: AppColors.surface,
      onSurface: AppColors.ink,
      error: AppColors.hole,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: AppColors.background,
      fontFamily: fontFamily,
      textTheme: _textTheme,
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.background,
        foregroundColor: AppColors.ink,
        elevation: 0,
        centerTitle: false,
      ),
      dividerColor: AppColors.border,
      splashFactory: NoSplash.splashFactory,
    );
  }

  static const TextTheme _textTheme = TextTheme(
    // Celebration screen heading: words lead, not numbers.
    displaySmall: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: AppColors.ink),
    titleLarge: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: AppColors.ink),
    titleMedium: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.ink),
    bodyLarge: TextStyle(fontSize: 16, height: 1.6, color: AppColors.ink),
    bodyMedium: TextStyle(fontSize: 14, height: 1.6, color: AppColors.ink),
    bodySmall: TextStyle(fontSize: 12, height: 1.5, color: AppColors.inkMuted),
  );
}
