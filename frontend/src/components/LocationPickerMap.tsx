// ─── src/components/LocationPickerMap.tsx ────────────────────────────────────
// OpenStreetMap pin-picker rendered with Leaflet inside a WebView.
// Tap anywhere to drop a draggable pin; every placement/drag reports the
// coordinates back to React Native via window.ReactNativeWebView.postMessage.
import React from 'react';
import {StyleProp, ViewStyle} from 'react-native';
import {WebView, WebViewProps, WebViewMessageEvent} from 'react-native-webview';

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

function buildHtml(initialLat?: number, initialLng?: number): string {
  const hasInitial =
    typeof initialLat === 'number' && typeof initialLng === 'number';
  const centerLat = hasInitial ? initialLat : HOME_LAT;
  const centerLng = hasInitial ? initialLng : HOME_LNG;
  const centerZoom = hasInitial ? 15 : HOME_ZOOM;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { margin:0; padding:0; height:100%; width:100%; background:#EAF2FF; }
  .cs-pin { background:transparent; border:none; }
  .cs-pin svg { filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4)); }
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
  return (
    <WebViewComponent
      style={style}
      source={{html: buildHtml(initialLat, initialLng)}}
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      setSupportMultipleWindows={false}
      overScrollMode="never"
      onMessage={(event: WebViewMessageEvent) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data) as {
            type: string;
            lat?: number;
            lng?: number;
          };
          if (
            msg.type === 'pin' &&
            typeof msg.lat === 'number' &&
            typeof msg.lng === 'number'
          ) {
            onPick(msg.lat, msg.lng);
          }
        } catch {
          // Ignore malformed messages
        }
      }}
    />
  );
}
