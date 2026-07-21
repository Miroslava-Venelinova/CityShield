// ─── src/components/CityShieldLogo.tsx ───────────────────────────────────────
// CityShield brand mark: a crest shield in the blue ramp holding a city
// skyline, with a beacon on the centre tower broadcasting two alert waves.
//
// This is a hand-port of frontend/assets/logo-mark.svg — that file is the
// source of truth for the geometry. Change it there first, then mirror here.
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import {font} from '../theme';

interface Props {
  size?: number; // shield height in dp (the mark is square)
  showWordmark?: boolean;
}

// Brand colors. Deliberately literal rather than pulled from `colors`: the
// artwork has to survive a theme change without the skyline going invisible.
const SHIELD_TOP = '#3B82F6';
const SHIELD_MID = '#1A56DB';
const SHIELD_TIP = '#0F2E7A';
const SIGNAL = '#7DD3FC';
const BEACON = '#BAE6FD';
const INK = '#0D2145';

// Outline of the shield, reused for the fill, the sheen and the inset rim.
const SHIELD_PATH = `M 64 6.2
  C 65.2 6.2 66.4 6.4 67.5 6.8
  L 101.7 17.6
  C 105.5 18.8 108 22.3 108 26.3
  L 108 60
  C 108 86 92 106.4 66.6 120.9
  C 65 121.8 63 121.8 61.4 120.9
  C 36 106.4 20 86 20 60
  L 20 26.3
  C 20 22.3 22.5 18.8 26.3 17.6
  L 60.5 6.8
  C 61.6 6.4 62.8 6.2 64 6.2
  Z`;

// Centre tower, with the setback that makes it read as a skyscraper.
const TOWER_PATH = `M 57.5 94 L 57.5 59.5 Q 57.5 58 59 58 L 60.5 58 L 60.5 51.5
  Q 60.5 50 62 50 L 66 50 Q 67.5 50 67.5 51.5 L 67.5 58
  L 69 58 Q 70.5 58 70.5 59.5 L 70.5 94 Z`;

export default function CityShieldLogo({size = 72, showWordmark = true}: Props) {
  // Gradient ids are document-global, so two logos on one screen would other-
  // wise fight over them.
  const uid = React.useId().replace(/:/g, '');
  const fillId = `csFill${uid}`;
  const sheenId = `csSheen${uid}`;

  return (
    <View style={styles.wrap}>
      <Svg width={size} height={size} viewBox="0 0 128 128">
        <Defs>
          <LinearGradient
            id={fillId}
            x1="24"
            y1="8"
            x2="104"
            y2="120"
            gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={SHIELD_TOP} />
            <Stop offset="0.52" stopColor={SHIELD_MID} />
            <Stop offset="1" stopColor={SHIELD_TIP} />
          </LinearGradient>
          <LinearGradient
            id={sheenId}
            x1="28"
            y1="10"
            x2="76"
            y2="88"
            gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.26" />
            <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0.04" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </LinearGradient>
        </Defs>

        <Path d={SHIELD_PATH} fill={`url(#${fillId})`} />
        <Path d={SHIELD_PATH} fill={`url(#${sheenId})`} />

        {/* Inset rim */}
        <G scale={0.93} originX={64} originY={61}>
          <Path
            d={SHIELD_PATH}
            fill="none"
            stroke="#FFFFFF"
            strokeOpacity={0.22}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
        </G>

        {/* Skyline, baseline y=94. Roof heights avoid a pyramid so the
            silhouette reads as a city, not a signal-strength meter. */}
        <Rect x={38} y={71} width={8.5} height={23} rx={1.4} fill="#FFFFFF" opacity={0.52} />
        <Rect x={80.5} y={76} width={9.5} height={18} rx={1.4} fill="#FFFFFF" opacity={0.52} />
        <Rect x={48} y={80} width={8} height={14} rx={1.4} fill="#FFFFFF" opacity={0.78} />
        <Rect x={72} y={66} width={7} height={28} rx={1.4} fill="#FFFFFF" opacity={0.78} />
        <Path d={TOWER_PATH} fill="#FFFFFF" />

        {/* Floor bands. Horizontal, not vertical: vertical mullions split the
            tower into three bars and it reverts to reading as a meter. */}
        <G fill={INK} opacity={0.28}>
          <Rect x={59} y={67} width={10} height={1.2} rx={0.6} />
          <Rect x={59} y={73} width={10} height={1.2} rx={0.6} />
          <Rect x={59} y={79} width={10} height={1.2} rx={0.6} />
          <Rect x={59} y={85} width={10} height={1.2} rx={0.6} />
        </G>

        {/* Beacon mast, lamp and the two alert waves */}
        <Rect x={63.2} y={43} width={1.6} height={8} rx={0.8} fill={SIGNAL} />
        <Circle cx={64} cy={42} r={3.4} fill={BEACON} />
        <Path
          d="M 51.95 37.13 A 13 13 0 0 1 76.05 37.13"
          fill="none"
          stroke={SIGNAL}
          strokeWidth={3.4}
          strokeLinecap="round"
        />
        <Path
          d="M 44.53 34.13 A 21 21 0 0 1 83.47 34.13"
          fill="none"
          stroke={SIGNAL}
          strokeWidth={3.4}
          strokeLinecap="round"
          opacity={0.5}
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
    letterSpacing: -0.4,
    marginTop: 6,
  },
  wordmarkCity: {color: INK},
  wordmarkShield: {color: SHIELD_MID},
});
