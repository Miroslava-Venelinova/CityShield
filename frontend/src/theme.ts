// ─── src/theme.ts ────────────────────────────────────────────────────────────

export const colors = {
  // Primary blues (light theme)
  navy:        '#FFFFFF',   // was dark background → now white base
  dark:        '#F0F6FF',   // was darker bg → now very light blue-tinted white
  primary:     '#1A56DB',
  primaryDark: '#1442B5',
  primaryLight:'#2D6FE8',
  accent:      '#0EA5E9',
  accentGlow:  '#BAE6FD',

  // UI surfaces
  surface:     '#FFFFFF',
  card:        '#EAF2FF',
  border:      '#C7DCFA',
  borderLight: '#D8E9FD',

  // Text (dark on light)
  textPrimary:   '#0D2145',
  textSecondary: '#3B5F96',
  textMuted:     '#7A9AC8',

  // Status
  success:  '#16A34A',
  warning:  '#D97706',
  danger:   '#DC2626',
  info:     '#0EA5E9',

  // Misc
  white: '#FFFFFF',
  black: '#000000',
};

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
  weights: {
    regular:   '400' as const,
    medium:    '500' as const,
    semibold:  '600' as const,
    bold:      '700' as const,
    extrabold: '800' as const,
  },
};
