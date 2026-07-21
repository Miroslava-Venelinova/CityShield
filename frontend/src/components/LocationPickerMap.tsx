// ─── src/components/LocationPickerMap.tsx ────────────────────────────────────
// OpenStreetMap pin-picker rendered with Leaflet inside a WebView.
// Tap anywhere to drop a draggable pin; every placement/drag reports the
// coordinates back to React Native via window.ReactNativeWebView.postMessage.
import React from 'react';
import {StyleProp, ViewStyle} from 'react-native';
import {WebView, WebViewProps, WebViewMessageEvent} from 'react-native-webview';
import {LEAFLET_HEAD, hardenedWebViewProps, safeCoord} from './leafletWebView';
import {useTheme} from '../context/ThemeContext';

// react-native-webview's class-component typings don't line up with the
// React 19 / RN 0.85 type definitions yet (props collapse to `never`), so
// re-type the component against its own published props.
const WebViewComponent = WebView as unknown as React.ComponentType<
  WebViewProps & React.RefAttributes<WebView>
>;

interface Props {
  onPick: (lat: number, lng: number) => void;
  initialLat?: number;
  initialLng?: number;
  style?: StyleProp<ViewStyle>;
}

// Varna city centre
const HOME_LAT = 43.2141;
const HOME_LNG = 27.9147;
const HOME_ZOOM = 12;

function buildHtml(
  dark: boolean,
  backdrop: string,
  initialLat?: number,
  initialLng?: number,
): string {
  // `Number.isFinite` rather than `typeof === 'number'`: these values come from
  // the stored user profile and are interpolated straight into the generated
  // page script below, where a NaN would silently leave the map blank.
  const hasInitial =
    Number.isFinite(initialLat as number) && Number.isFinite(initialLng as number);
  const centerLat = safeCoord(initialLat, HOME_LAT);
  const centerLng = safeCoord(initialLng, HOME_LNG);
  const centerZoom = hasInitial ? 15 : HOME_ZOOM;

  return `<!DOCTYPE html>
<html>
<head>
${LEAFLET_HEAD}
<style>
  html, body, #map { margin:0; padding:0; height:100%; width:100%; background:${backdrop}; }
  /* The picker owns every gesture in its bounds — see MAP_GESTURE_SCRIPT. */
  #map { touch-action: none; }
  body { overflow: hidden; overscroll-behavior: none; }
  .cs-pin { background:transparent; border:none; }
  .cs-pin svg { filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4)); }
  ${dark ? `
  /* Same single-provider dark treatment as AlertMap; the pin sits above the
     filtered tile pane and keeps its brand blue. */
  .leaflet-tile-pane {
    filter: invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.75);
  }
  .leaflet-container { background:${backdrop}; }
  .leaflet-control-attribution {
    background: rgba(10,18,32,0.75) !important;
    color: #A9C1E2 !important;
  }
  .leaflet-control-attribution a { color: #8AB4FF !important; }
  ` : ''}
</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', { zoomControl: false, attributionControl: true })
             .setView([${centerLat}, ${centerLng}], ${centerZoom});
  map.attributionControl.setPrefix(false);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  function post(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  var pinIcon = L.divIcon({
    className: 'cs-pin',
    html: '<svg width="34" height="34" viewBox="0 0 24 24" fill="#1B4DB1" stroke="#fff" stroke-width="1.2">' +
          '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
          '<circle cx="12" cy="10" r="3" fill="#fff" stroke="none"/></svg>',
    iconSize: [34, 34],
    iconAnchor: [17, 33]
  });

  var pin = null;

  function reportPin() {
    var pos = pin.getLatLng();
    post({ type: 'pin', lat: pos.lat, lng: pos.lng });
  }

  function placePin(latlng) {
    if (pin) {
      pin.setLatLng(latlng);
    } else {
      pin = L.marker(latlng, { icon: pinIcon, draggable: true }).addTo(map);
      pin.on('dragend', reportPin);
    }
    reportPin();
  }

  map.on('click', function (e) { placePin(e.latlng); });

  ${hasInitial ? `placePin(L.latLng(${centerLat}, ${centerLng}));` : ''}
  post({ type: 'ready' });
</script>
</body>
</html>`;
}

export default function LocationPickerMap({
  onPick,
  initialLat,
  initialLng,
  style,
}: Props) {
  const {isDark, colors} = useTheme();
  return (
    <WebViewComponent
      // Theming is baked into the document, so a theme change reloads it.
      key={isDark ? 'dark' : 'light'}
      style={style}
      source={{
        html: buildHtml(isDark, colors.mapBackdrop, initialLat, initialLng),
      }}
      {...hardenedWebViewProps}
      onMessage={(event: WebViewMessageEvent) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data) as {
            type: string;
            lat?: number;
            lng?: number;
          };
          // Range-check before this reaches PUT /api/auth/location, which
          // rejects out-of-range coordinates with a 400 — better to never
          // send them than to surface a server error to the user.
          if (
            msg.type === 'pin' &&
            Number.isFinite(msg.lat) &&
            Number.isFinite(msg.lng) &&
            msg.lat! >= -90 && msg.lat! <= 90 &&
            msg.lng! >= -180 && msg.lng! <= 180
          ) {
            onPick(msg.lat!, msg.lng!);
          }
        } catch {
          // Ignore malformed messages
        }
      }}
    />
  );
}
