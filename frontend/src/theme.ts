// ─── src/theme.ts ────────────────────────────────────────────────────────────
// Design tokens. Screens should reference these rather than literal values, so
// that spacing rhythm, elevation and colour stay consistent across the app.
//
// Colour is the one scale that is *not* a plain export: the app ships a light
// and a dark palette and picks between them at runtime. Get them from
// `useTheme()` / `useThemedStyles()` in context/ThemeContext.tsx rather than
// importing a palette directly, otherwise the value is frozen at module load
// and the screen stops following the theme.

/**
 * Colour roles. Both palettes implement this exact set, so a screen written
 * against it renders in either theme without branching.
 *
 * Names describe the *role*, not the hue — `background` is the app canvas in
 * both themes even though one is near-white and the other near-black.
 */
export interface Colors {
  background: string;
  surface: string;
  card: string;
  border: string;
  borderLight: string;

  primary: string;
  primaryDark: string;
  primaryLight: string;
  accent: string;
  accentGlow: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;

  success: string;
  warning: string;
  danger: string;
  info: string;

  successSoft: string;
  warningSoft: string;
  dangerSoft: string;
  infoSoft: string;

  white: string;
  black: string;
  overlay: string;

  /** Shadow colour — near-black in light, pure black in dark. */
  shadow: string;
  /**
   * Backdrop painted behind a map WebView while its tiles load, and the page
   * background inside it. Kept next to the palette so the two never disagree.
   */
  mapBackdrop: string;
}

export const lightColors: Colors = {
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
  shadow: '#0D2145',
  mapBackdrop: '#EAF2FF',
};

/**
 * Dark palette.
 *
 * Surfaces are navy rather than neutral grey so the brand blue still reads as
 * the accent instead of the only colour on screen. Brand and status hues are
 * lifted a few steps versus the light palette — #1A56DB on a #131E31 card is
 * below any usable contrast ratio, so `primary` here is a lifted tint rather
 * than the literal brand value. The one place the raw brand blue survives is
 * the logo mark, which carries its own literal colours by design.
 */
export const darkColors: Colors = {
  background:  '#0A1220',
  surface:     '#131E31',
  card:        '#1C2B44',
  border:      '#283A57',
  borderLight: '#1E2C42',

  primary:     '#5B93F8',
  primaryDark: '#3B7AE8',
  primaryLight:'#8AB4FF',
  accent:      '#38BDF8',
  accentGlow:  '#0C4A6E',

  textPrimary:   '#E9F1FD',
  textSecondary: '#A9C1E2',
  textMuted:     '#7189AC',
  textInverse:   '#0A1220',

  success:  '#4ADE80',
  warning:  '#FBBF24',
  danger:   '#F87171',
  info:     '#38BDF8',

  // Softer fills need more alpha on a dark canvas to stay visible at all.
  successSoft: 'rgba(74,222,128,0.16)',
  warningSoft: 'rgba(251,191,36,0.16)',
  dangerSoft:  'rgba(248,113,113,0.16)',
  infoSoft:    'rgba(56,189,248,0.16)',

  white: '#FFFFFF',
  black: '#000000',
  overlay: 'rgba(2,6,14,0.65)',
  shadow: '#000000',
  mapBackdrop: '#0F1826',
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
 *
 * Palette-dependent (shadow colour, and a stronger opacity in dark where a
 * soft navy shadow on a navy canvas is invisible), hence a factory.
 */
export function createElevation(c: Colors, dark: boolean) {
  const boost = dark ? 2 : 1;
  return {
    sm: {
      shadowColor: c.shadow,
      shadowOffset: {width: 0, height: 1},
      shadowOpacity: 0.05 * boost,
      shadowRadius: 4,
      elevation: 1,
    },
    md: {
      shadowColor: c.shadow,
      shadowOffset: {width: 0, height: 2},
      shadowOpacity: 0.1 * boost,
      shadowRadius: 8,
      elevation: 3,
    },
    lg: {
      shadowColor: c.shadow,
      shadowOffset: {width: 0, height: -2},
      shadowOpacity: 0.16 * boost,
      shadowRadius: 20,
      elevation: 12,
    },
    accent: {
      shadowColor: dark ? c.shadow : c.primary,
      shadowOffset: {width: 0, height: 4},
      shadowOpacity: 0.28,
      shadowRadius: 10,
      elevation: 6,
    },
  } as const;
}

export type Elevation = ReturnType<typeof createElevation>;
