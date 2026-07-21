// ─── src/context/ThemeContext.tsx ────────────────────────────────────────────
// Light/dark theming.
//
// Screens must not import a palette from `../theme` directly: that value is
// resolved once at module load and would never follow a theme change. They
// take colours from `useTheme()` and build their StyleSheets through
// `useThemedStyles()` instead.
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  ReactNode,
} from 'react';
import {useColorScheme} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Colors, Elevation, createElevation, darkColors, lightColors,
} from '../theme';

const STORAGE_KEY = 'app_theme';

/** What the user picked. `system` defers to the OS setting. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** What is actually being rendered, after resolving `system`. */
export type ColorScheme = 'light' | 'dark';

interface ThemeContextType {
  colors: Colors;
  elevation: Elevation;
  scheme: ColorScheme;
  isDark: boolean;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
}

const lightElevation = createElevation(lightColors, false);
const darkElevation  = createElevation(darkColors, true);

const ThemeContext = createContext<ThemeContextType>({
  colors: lightColors,
  elevation: lightElevation,
  scheme: 'light',
  isDark: false,
  preference: 'system',
  setPreference: () => {},
});

export const ThemeProvider = ({children}: {children: ReactNode}) => {
  // `useColorScheme` re-renders on OS theme changes, so 'system' tracks the
  // device live rather than only at launch.
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === 'system' || stored === 'light' || stored === 'dark') {
          setPreferenceState(stored);
        }
      } catch {
        // Storage unavailable — follow the system setting
      }
    })();
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const value = useMemo<ThemeContextType>(() => {
    const scheme: ColorScheme =
      preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light')
      : preference;
    const isDark = scheme === 'dark';
    return {
      colors: isDark ? darkColors : lightColors,
      elevation: isDark ? darkElevation : lightElevation,
      scheme,
      isDark,
      preference,
      setPreference,
    };
  }, [preference, systemScheme, setPreference]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);

/**
 * Per-scheme StyleSheet cache.
 *
 * `StyleSheet.create` is cheap but not free, and the factories below are
 * module-level constants shared by every instance of a component (each row in
 * a list, say). Keying by factory identity means each sheet is built at most
 * twice for the lifetime of the app — once per scheme — instead of once per
 * mount. The WeakMap lets a factory be collected with its module if the bundle
 * ever splits.
 */
type StyleFactory<T> = (colors: Colors, elevation: Elevation) => T;
const sheetCache = new WeakMap<
  StyleFactory<unknown>,
  Partial<Record<ColorScheme, unknown>>
>();

/**
 * Builds (and caches) a StyleSheet for the active theme.
 *
 * `factory` must be defined at module scope — a factory redeclared on each
 * render defeats the cache and rebuilds the sheet every time.
 */
export function useThemedStyles<T>(factory: StyleFactory<T>): T {
  const {colors, elevation, scheme} = useTheme();
  return useMemo(() => {
    let perScheme = sheetCache.get(factory as StyleFactory<unknown>);
    if (!perScheme) {
      perScheme = {};
      sheetCache.set(factory as StyleFactory<unknown>, perScheme);
    }
    if (perScheme[scheme] === undefined) {
      perScheme[scheme] = factory(colors, elevation);
    }
    return perScheme[scheme] as T;
  }, [factory, scheme, colors, elevation]);
}
