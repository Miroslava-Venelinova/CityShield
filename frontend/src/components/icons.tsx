// ─── src/components/icons.tsx ─────────────────────────────────────────────────
// Line icon set (Feather-style, 24×24 grid) rendered with react-native-svg.
// Usage: <Icon name="bell" size={20} color={colors.primary} />
import React from 'react';
import Svg, {Path, Circle, Rect, Line, Polyline, Polygon} from 'react-native-svg';

export type IconName =
  | 'home'
  | 'bell'
  | 'user'
  | 'map-pin'
  | 'map'
  | 'mail'
  | 'lock'
  | 'eye'
  | 'eye-off'
  | 'droplet'
  | 'bus'
  | 'zap'
  | 'alert-triangle'
  | 'info'
  | 'x'
  | 'check'
  | 'chevron-right'
  | 'chevron-left'
  | 'log-out'
  | 'inbox'
  | 'settings'
  | 'clock'
  | 'shield'
  | 'navigation'
  | 'trash'
  | 'key'
  | 'smartphone'
  | 'megaphone'
  | 'refresh'
  | 'flame'
  | 'road';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({
  name,
  size = 20,
  color = '#0D2145',
  strokeWidth = 2,
}: IconProps) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };

  const renderPaths = () => {
    switch (name) {
      case 'home':
        return (
          <>
            <Path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...common} />
            <Polyline points="9 22 9 12 15 12 15 22" {...common} />
          </>
        );
      case 'bell':
        return (
          <>
            <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" {...common} />
            <Path d="M13.73 21a2 2 0 0 1-3.46 0" {...common} />
          </>
        );
      case 'user':
        return (
          <>
            <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" {...common} />
            <Circle cx="12" cy="7" r="4" {...common} />
          </>
        );
      case 'map-pin':
        return (
          <>
            <Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" {...common} />
            <Circle cx="12" cy="10" r="3" {...common} />
          </>
        );
      case 'map':
        return (
          <>
            <Path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z" {...common} />
            <Line x1="8" y1="2" x2="8" y2="18" {...common} />
            <Line x1="16" y1="6" x2="16" y2="22" {...common} />
          </>
        );
      case 'mail':
        return (
          <>
            <Rect x="2" y="4" width="20" height="16" rx="2" {...common} />
            <Polyline points="22,6 12,13 2,6" {...common} />
          </>
        );
      case 'lock':
        return (
          <>
            <Rect x="3" y="11" width="18" height="11" rx="2" {...common} />
            <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...common} />
          </>
        );
      case 'eye':
        return (
          <>
            <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" {...common} />
            <Circle cx="12" cy="12" r="3" {...common} />
          </>
        );
      case 'eye-off':
        return (
          <>
            <Path
              d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
              {...common}
            />
            <Line x1="1" y1="1" x2="23" y2="23" {...common} />
          </>
        );
      case 'droplet':
        return <Path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" {...common} />;
      case 'bus':
        return (
          <>
            <Rect x="4" y="3" width="16" height="14" rx="2" {...common} />
            <Line x1="4" y1="11" x2="20" y2="11" {...common} />
            <Line x1="8" y1="21" x2="8" y2="17" {...common} />
            <Line x1="16" y1="21" x2="16" y2="17" {...common} />
            <Line x1="8" y1="14.5" x2="8" y2="14.5" {...common} strokeWidth={strokeWidth + 1} />
            <Line x1="16" y1="14.5" x2="16" y2="14.5" {...common} strokeWidth={strokeWidth + 1} />
          </>
        );
      case 'zap':
        return <Polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" {...common} />;
      case 'alert-triangle':
        return (
          <>
            <Path
              d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
              {...common}
            />
            <Line x1="12" y1="9" x2="12" y2="13" {...common} />
            <Line x1="12" y1="17" x2="12.01" y2="17" {...common} />
          </>
        );
      case 'info':
        return (
          <>
            <Circle cx="12" cy="12" r="10" {...common} />
            <Line x1="12" y1="16" x2="12" y2="12" {...common} />
            <Line x1="12" y1="8" x2="12.01" y2="8" {...common} />
          </>
        );
      case 'x':
        return (
          <>
            <Line x1="18" y1="6" x2="6" y2="18" {...common} />
            <Line x1="6" y1="6" x2="18" y2="18" {...common} />
          </>
        );
      case 'check':
        return <Polyline points="20 6 9 17 4 12" {...common} />;
      case 'chevron-right':
        return <Polyline points="9 18 15 12 9 6" {...common} />;
      case 'chevron-left':
        return <Polyline points="15 18 9 12 15 6" {...common} />;
      case 'log-out':
        return (
          <>
            <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...common} />
            <Polyline points="16 17 21 12 16 7" {...common} />
            <Line x1="21" y1="12" x2="9" y2="12" {...common} />
          </>
        );
      case 'inbox':
        return (
          <>
            <Polyline points="22 12 16 12 14 15 10 15 8 12 2 12" {...common} />
            <Path
              d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
              {...common}
            />
          </>
        );
      case 'settings':
        return (
          <>
            <Circle cx="12" cy="12" r="3" {...common} />
            <Path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
              {...common}
            />
          </>
        );
      case 'clock':
        return (
          <>
            <Circle cx="12" cy="12" r="10" {...common} />
            <Polyline points="12 6 12 12 16 14" {...common} />
          </>
        );
      case 'shield':
        return <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...common} />;
      case 'navigation':
        return <Polygon points="3 11 22 2 13 21 11 13 3 11" {...common} />;
      case 'trash':
        return (
          <>
            <Polyline points="3 6 5 6 21 6" {...common} />
            <Path
              d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
              {...common}
            />
          </>
        );
      case 'key':
        return (
          <Path
            d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
            {...common}
          />
        );
      case 'smartphone':
        return (
          <>
            <Rect x="5" y="2" width="14" height="20" rx="2" {...common} />
            <Line x1="12" y1="18" x2="12.01" y2="18" {...common} />
          </>
        );
      case 'megaphone':
        return (
          <>
            <Path d="M3 11l18-7v18l-18-7v-4z" {...common} />
            <Path d="M7.5 15.5V19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-2" {...common} />
          </>
        );
      case 'refresh':
        return (
          <>
            <Polyline points="23 4 23 10 17 10" {...common} />
            <Path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" {...common} />
          </>
        );
      case 'flame':
        return (
          <Path
            d="M12 22c4.5 0 7-2.9 7-6.5 0-2.5-1.3-4.5-2.7-6C14.9 8 14 6.5 14 4.5c0-1-.3-1.8-1-2.5-.4 2-1.4 3.3-2.8 4.6C8.5 8.2 5 10.5 5 15.5 5 19.1 7.5 22 12 22z"
            {...common}
          />
        );
      case 'road':
        return (
          <>
            <Path d="M4 21L9 3" {...common} />
            <Path d="M20 21L15 3" {...common} />
            <Line x1="12" y1="4" x2="12" y2="7" {...common} />
            <Line x1="12" y1="11" x2="12" y2="14" {...common} />
            <Line x1="12" y1="18" x2="12" y2="20" {...common} />
          </>
        );
      default:
        return null;
    }
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {renderPaths()}
    </Svg>
  );
}
