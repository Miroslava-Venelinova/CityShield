// ─── index.js ─────────────────────────────────────────────────────────────────
// Order matters: gesture handler and screens must be patched before anything
// renders, and OneSignal must be initialized before the app mounts so a
// notification tap that cold-starts the app still reaches its click listener.
import 'react-native-gesture-handler';
import {enableScreens} from 'react-native-screens';
import {initPush} from './src/services/push';

enableScreens();
initPush();

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
