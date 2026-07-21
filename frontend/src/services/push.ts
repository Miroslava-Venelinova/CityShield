// ─── src/services/push.ts ─────────────────────────────────────────────────────
// Wraps react-native-onesignal (replaces the @react-native-firebase/messaging
// client). The app no longer holds or uploads a device token: OneSignal keeps
// the device registration and the backend addresses users by `external_id`,
// which is our own `user_id` — set here via OneSignal.login().
//
// Notification *history* is no longer captured from incoming pushes either.
// Firebase's setBackgroundMessageHandler had no OneSignal equivalent on
// Android, so the in-app list is rebuilt from GET /api/alerts/recent instead
// (see services/notifications.ts). That also survives reinstalls and alerts
// that arrived while the app was killed, which the old handler did not.
import {OneSignal, LogLevel} from 'react-native-onesignal';
import {ONESIGNAL_APP_ID} from '../config';

/**
 * Must run before the app mounts (called from index.js) so a notification tap
 * that cold-starts the app still reaches the click listener.
 */
export function initPush(): void {
  if (__DEV__) {
    OneSignal.Debug.setLogLevel(LogLevel.Warn);
  }
  OneSignal.initialize(ONESIGNAL_APP_ID);
}

/**
 * Android 13+ shows the runtime POST_NOTIFICATIONS prompt; older versions
 * resolve immediately. Resolves to whether notifications are permitted.
 */
export async function requestPushPermission(): Promise<boolean> {
  try {
    return await OneSignal.Notifications.requestPermission(true);
  } catch (err) {
    console.warn('[Push] Permission request failed:', err);
    return false;
  }
}

export function hasPushPermission(): boolean {
  return OneSignal.Notifications.hasPermission();
}

/**
 * Binds this device to the signed-in user, so the backend can target them by
 * id. Safe to call repeatedly — OneSignal treats the same external id as the
 * same user, which is what lets one account cover several devices.
 */
export function identifyUser(userId: string): void {
  try {
    OneSignal.login(userId);
  } catch (err) {
    console.warn('[Push] login failed:', err);
  }
}

/** Unbinds the device on sign-out, so alerts for that account stop arriving. */
export function clearUser(): void {
  try {
    OneSignal.logout();
  } catch (err) {
    console.warn('[Push] logout failed:', err);
  }
}

/**
 * Notification arrived while the app is open, or was tapped. Both are just a
 * cue that the feed has something new — the payload itself is not persisted.
 * Returns an unsubscribe function.
 */
export function registerNotificationHandlers(onIncoming: () => void): () => void {
  const foreground = () => onIncoming();
  const click = () => onIncoming();

  OneSignal.Notifications.addEventListener('foregroundWillDisplay', foreground);
  OneSignal.Notifications.addEventListener('click', click);

  return () => {
    OneSignal.Notifications.removeEventListener('foregroundWillDisplay', foreground);
    OneSignal.Notifications.removeEventListener('click', click);
  };
}
