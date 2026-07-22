// ─── src/components/CityShieldLogo.tsx ───────────────────────────────────────
// CityShield brand mark: a flat blue shield holding a single tower that
// broadcasts two alert waves.
//
// This is a hand-port of frontend/assets/logo-mark.svg — that file is the
// source of truth for the geometry. Change it there first, then mirror here.
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {font} from '../theme';
import {useTheme} from '../context/ThemeContext';

interface Props {
  size?: number; // shield height in dp (the mark is square)
  showWordmark?: boolean;
}

// The mark carries the app's own accent blue (`colors.primary`) rather than a
// literal of its own, so the shield and every primary button/badge on screen
// read as the same blue. Taking it from the palette — not a constant — is what
// keeps that true in dark mode too, where `primary` lifts to a tint that still
// separates from the navy canvas.
//
// Only the shield body follows the theme: the tower and waves stay white,
// which is legible against either end of the primary scale.

// Outline of the shield: straight shoulders into a single curve per side,
// meeting in a softened tip.
const SHIELD_PATH = `M 64 8
  L 104 21.5
  Q 108 22.8 108 27
  L 108 60
  Q 108 88 66.4 119.4
  Q 64 121 61.6 119.4
  Q 20 88 20 60
  L 20 27
  Q 20 22.8 24 21.5
  Z`;

export default function CityShieldLogo({size = 72, showWordmark = true}: Props) {
  const {colors} = useTheme();

  return (
    <View style={styles.wrap}>
      <Svg width={size} height={size} viewBox="0 0 128 128">
        <Path d={SHIELD_PATH} fill={colors.primary} />

        {/* Tower and beacon lamp */}
        <Rect x={57.5} y={58} width={13} height={36} rx={2} fill="#FFFFFF" />
        <Circle cx={64} cy={48} r={4} fill="#FFFFFF" />

        {/* Two alert waves. The outer one is held at 0.55 so the pair reads as
            one signal fading outward rather than as two equal rings. */}
        <Path
          d="M 53.6 42 A 12 12 0 0 1 74.4 42"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={3.6}
          strokeLinecap="round"
        />
        <Path
          d="M 46.7 36 A 22 22 0 0 1 81.3 36"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={3.6}
          strokeLinecap="round"
          opacity={0.55}
        />
      </Svg>

      {showWordmark && (
        <Text style={styles.wordmark}>
          <Text style={{color: colors.textPrimary}}>City</Text>
          <Text style={{color: colors.primary}}>Shield</Text>
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {alignItems: 'center'},
  wordmark: {
    fontSize: font.sizes.xl,
    fontWeight: font.weights.extrabold,
    letterSpacing: -0.4,
    marginTop: 6,
  },
});
