// ─── index.js ─────────────────────────────────────────────────────────────────
// Order matters: gesture handler and screens must be patched before anything
// renders. Background FCM handler must be registered before the app mounts.
import 'react-native-gesture-handler';
import {enableScreens} from 'react-native-screens';
import {registerBackgroundHandler} from './src/services/fcm';

enableScreens();
registerBackgroundHandler();

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
