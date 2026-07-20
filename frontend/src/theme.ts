// ─── src/theme.ts ────────────────────────────────────────────────────────────
// Design tokens. Screens should reference these rather than literal values, so
// that spacing rhythm, elevation and colour stay consistent across the app.

export const colors = {
  // ── Surfaces ──
  // Named by role, not by hue. These were previously `navy` and `dark`, left
  // over from a dark theme; after the switch to a light palette `navy` was
  // #FFFFFF and `dark` was the lightest blue in the set, which made every
  // usage site read backwards.
  background:  '#F0F6FF',   // app canvas — very light blue tint
  surface:     '#FFFFFF',   // cards, headers, sheets
  card:        '#EAF2FF',   // subtly raised fill inside a surface
  border:      '#C7DCFA',
  borderLight: '#D8E9FD',

  // ── Brand ──
  primary:     '#1A56DB',
  primaryDark: '#1442B5',
  primaryLight:'#2D6FE8',
  accent:      '#0EA5E9',
  accentGlow:  '#BAE6FD',

  // ── Text (dark on light) ──
  textPrimary:   '#0D2145',
  textSecondary: '#3B5F96',
  textMuted:     '#7A9AC8',
  textInverse:   '#FFFFFF',

  // ── Status ──
  success:  '#16A34A',
  warning:  '#D97706',
  danger:   '#DC2626',
  info:     '#0EA5E9',

  // Tinted status fills, for badges and banners. Pre-mixed rather than
  // composed with alpha suffixes at call sites, which produced slightly
  // different tints on different screens.
  successSoft: 'rgba(22,163,74,0.12)',
  warningSoft: 'rgba(217,119,6,0.12)',
  dangerSoft:  'rgba(220,38,38,0.12)',
  infoSoft:    'rgba(14,165,233,0.12)',

  // ── Misc ──
  white: '#FFFFFF',
  black: '#000000',
  /** Scrim behind modals and bottom sheets. */
  overlay: 'rgba(13,33,69,0.45)',
};

/** 4pt spacing scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
};

export const font = {
  sizes: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 17,
    xl: 20,
    xxl: 26,
    xxxl: 34,
  },
  /**
   * Line heights paired to each size. Body copy in the alert feed is Bulgarian
   * and often wraps to several lines, where the platform default leading is
   * noticeably tight.
   */
  lineHeights: {
    xs: 16,
    sm: 18,
    md: 22,
    lg: 24,
    xl: 26,
    xxl: 32,
    xxxl: 40,
  },
  weights: {
    regular:   '400' as const,
    medium:    '500' as const,
    semibold:  '600' as const,
    bold:      '700' as const,
    extrabold: '800' as const,
  },
};

/**
 * Elevation presets covering both iOS (`shadow*`) and Android (`elevation`).
 *
 * Shadows were previously written inline per component, which drifted into
 * five different opacity/radius combinations for what are visually the same
 * layer. Pick the level by role:
 *   sm — resting cards in a list
 *   md — headers, floating controls, raised cards
 *   lg — modals and bottom sheets
 * `accent` is the primary-tinted variant used by filled brand buttons.
 */
export const elevation = {
  sm: {
    shadowColor: colors.textPrimary,
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  md: {
    shadowColor: colors.textPrimary,
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  lg: {
    shadowColor: colors.textPrimary,
    shadowOffset: {width: 0, height: -2},
    shadowOpacity: 0.16,
    shadowRadius: 20,
    elevation: 12,
  },
  accent: {
    shadowColor: colors.primary,
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 6,
  },
} as const;
