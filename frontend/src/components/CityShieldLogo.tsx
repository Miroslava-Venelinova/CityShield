// ─── src/components/CityShieldLogo.tsx ───────────────────────────────────────
// CityShield brand logo: three light-blue swoosh bands forming the upper-left
// of a shield, closed by a dark navy arc along the right edge and bottom tip.
// Rendered with react-native-svg. A standalone copy of the artwork lives in
// frontend/assets/logo.svg for use outside the app (README, stores, web).
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {Path} from 'react-native-svg';
import {font} from '../theme';

interface Props {
  size?: number; // shield height in dp
  showWordmark?: boolean;
}

// Brand colors (from the logo artwork, independent of the app theme)
const BRAND_BLUE = '#3E9FD8';
const BRAND_NAVY = '#1F3B4E';

export default function CityShieldLogo({size = 72, showWordmark = true}: Props) {
  const width = size * (120 / 132);

  return (
    <View style={styles.wrap}>
      <Svg width={width} height={size} viewBox="0 0 120 132">
        {/* Navy crescent: top-right tip, down the right edge, through the
            bottom tip, up the lower-left edge, ending in an angled cut */}
        <Path
          d="M 97 17
             C 104 29, 110 44, 110 58
             C 110 82, 96 105, 62 121
             C 48 113, 36 101, 27 88
             L 35 82
             C 43 95, 52 106, 62 112
             C 84 100, 99 82, 100 60
             C 100 45, 97 28, 93 21
             Z"
          fill={BRAND_NAVY}
        />

        {/* Swoosh band 1 (top, thickest) */}
        <Path
          d="M 13 14
             C 40 4, 72 6, 99 26
             C 70 16, 40 20, 13 40
             Z"
          fill={BRAND_BLUE}
        />

        {/* Swoosh band 2 (middle) */}
        <Path
          d="M 13 46
             C 36 34, 58 32, 78 39
             C 54 42, 32 50, 15 64
             Z"
          fill={BRAND_BLUE}
        />

        {/* Swoosh band 3 (bottom, shortest) */}
        <Path
          d="M 16 68
             C 32 58, 47 55, 62 57
             C 45 63, 30 70, 21 84
             Z"
          fill={BRAND_BLUE}
        />
      </Svg>

      {showWordmark && (
        <Text style={styles.wordmark}>
          <Text style={styles.wordmarkCity}>City</Text>
          <Text style={styles.wordmarkShield}>Shield</Text>
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
    letterSpacing: 1.5,
    marginTop: 8,
  },
  wordmarkCity: {color: BRAND_NAVY},
  wordmarkShield: {color: BRAND_BLUE},
});
