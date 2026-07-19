// ─── src/components/AlertMap.tsx ─────────────────────────────────────────────
// OpenStreetMap alert map rendered with Leaflet inside a WebView.
// No Google Maps SDK, no API keys — tiles come straight from OSM.
//
// RN → web: marker/polygon data via injectJavaScript (window.__setData),
//           camera moves via window.__flyTo.
// web → RN: marker taps via window.ReactNativeWebView.postMessage.
import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useEffect,
  useCallback,
} from 'react';
import {StyleProp, ViewStyle} from 'react-native';
import {WebView, WebViewProps, WebViewMessageEvent} from 'react-native-webview';

// react-native-webview's class-component typings don't line up with the
// React 19 / RN 0.85 type definitions yet (props collapse to `never`), so
// re-type the component against its own published props.
const WebViewComponent = WebView as unknown as React.ComponentType<
  WebViewProps & React.RefAttributes<WebView>
>;

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  color: string;   // ring color (severity)
}

export interface MapPolygon {
  id: string;
  coords: [number, number][]; // [lat, lng]
  color: string;
}

export interface AlertMapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  recenter: () => void;
}

interface Props {
  markers: MapMarker[];
  polygons: MapPolygon[];
  onMarkerPress?: (id: string) => void;
  style?: StyleProp<ViewStyle>;
}

// Varna city centre
const HOME_LAT = 43.2141;
const HOME_LNG = 27.9147;
const HOME_ZOOM = 12;

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { margin:0; padding:0; height:100%; width:100%; background:#EAF2FF; }
  .cs-marker { background:transparent; border:none; }
  .cs-marker div {
    width:24px; height:24px; border-radius:50%;
    background:#fff; border:3px solid #888;
    box-shadow:0 1px 4px rgba(0,0,0,0.35);
    box-sizing:border-box;
  }
</style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', { zoomControl: false, attributionControl: true })
             .setView([${HOME_LAT}, ${HOME_LNG}], ${HOME_ZOOM});
  map.attributionControl.setPrefix(false);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var overlays = L.layerGroup().addTo(map);

  function post(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  window.__setData = function (data) {
    overlays.clearLayers();
    (data.polygons || []).forEach(function (p) {
      L.polygon(p.coords, {
        color: p.color, weight: 2,
        fillColor: p.color, fillOpacity: 0.2
      }).addTo(overlays);
    });
    (data.markers || []).forEach(function (m) {
      var icon = L.divIcon({
        className: 'cs-marker',
        html: '<div style="border-color:' + m.color + '"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      L.marker([m.lat, m.lng], { icon: icon })
        .on('click', function () { post({ type: 'markerPress', id: m.id }); })
        .addTo(overlays);
    });
  };

  window.__flyTo = function (lat, lng, zoom) {
    map.flyTo([lat, lng], zoom || 14, { duration: 0.6 });
  };

  post({ type: 'ready' });
</script>
</body>
</html>`;

const AlertMap = forwardRef<AlertMapHandle, Props>(function AlertMap(
  {markers, polygons, onMarkerPress, style},
  ref,
) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);

  const pushData = useCallback(() => {
    const payload = JSON.stringify({markers, polygons});
    webRef.current?.injectJavaScript(
      `window.__setData && window.__setData(${payload}); true;`,
    );
  }, [markers, polygons]);

  // Re-push overlays whenever data changes (after the map reported ready)
  useEffect(() => {
    if (readyRef.current) {
      pushData();
    }
  }, [pushData]);

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, zoom = 14) => {
      webRef.current?.injectJavaScript(
        `window.__flyTo && window.__flyTo(${lat}, ${lng}, ${zoom}); true;`,
      );
    },
    recenter: () => {
      webRef.current?.injectJavaScript(
        `window.__flyTo && window.__flyTo(${HOME_LAT}, ${HOME_LNG}, ${HOME_ZOOM}); true;`,
      );
    },
  }));

  return (
    <WebViewComponent
      ref={webRef}
      style={style}
      source={{html: HTML}}
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      setSupportMultipleWindows={false}
      overScrollMode="never"
      onMessage={(event: WebViewMessageEvent) => {
        try {
          const msg = JSON.parse(event.nativeEvent.data) as {type: string; id?: string};
          if (msg.type === 'ready') {
            readyRef.current = true;
            pushData();
          } else if (msg.type === 'markerPress' && msg.id && onMarkerPress) {
            onMarkerPress(msg.id);
          }
        } catch {
          // Ignore malformed messages
        }
      }}
    />
  );
});

export default AlertMap;
