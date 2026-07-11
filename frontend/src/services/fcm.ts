// ─── src/services/fcm.ts ──────────────────────────────────────────────────────
// Wraps @react-native-firebase/messaging. All incoming messages (foreground,
// background, quit) are persisted via the notifications storage service.
import messaging, {
  FirebaseMessagingTypes,
} from '@react-native-firebase/messaging';
import {Alert} from 'react-native';
import {
  addNotification,
  NotificationCategory,
} from './notifications';

// ── Get real FCM token ─────────────────────────────────────────────────────────
export async function getFCMToken(): Promise<string | null> {
  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) return null;

    return await messaging().getToken();
  } catch (err) {
    console.warn('[FCM] Failed to get token:', err);
    return null;
  }
}

// ── Persist + optionally show an in-app alert ─────────────────────────────────
async function handleMessage(
  message: FirebaseMessagingTypes.RemoteMessage,
  showAlert = false,
) {
  const title     = message.notification?.title ?? 'CityShield Alert';
  const body      = message.notification?.body  ?? 'A new alert for your area.';
  const category  = (message.data?.category as NotificationCategory) ?? 'general';
  const startTime = (message.data?.startTime as string) || null;
  const endTime   = (message.data?.endTime   as string) || null;

  await addNotification({
    title,
    body,
    category,
    startTime,
    endTime,
    messageId: message.messageId ?? undefined,
  });

  if (showAlert) {
    Alert.alert(title, body);
  }
}

// ── Foreground listener ───────────────────────────────────────────────────────
// FCM suppresses heads-up notifications in the foreground, so we persist the
// message and show a manual Alert so the user doesn't miss anything.
export function registerForegroundHandler(): () => void {
  return messaging().onMessage(async remoteMessage => {
    await handleMessage(remoteMessage, /* showAlert */ true);
  });
}

// ── Background / quit handler ─────────────────────────────────────────────────
// Must be registered before the app mounts (called from index.js).
// Firebase already shows the system notification — we just need to persist it.
export function registerBackgroundHandler(): void {
  messaging().setBackgroundMessageHandler(async remoteMessage => {
    console.log('[FCM] Background message:', remoteMessage.messageId);
    await handleMessage(remoteMessage, /* showAlert */ false);
  });
}

// ── Token refresh ─────────────────────────────────────────────────────────────
export function registerTokenRefreshHandler(
  onRefresh: (newToken: string) => void,
): () => void {
  return messaging().onTokenRefresh(onRefresh);
}

// ── Cold-start: app opened by tapping a notification ─────────────────────────
// If the notification was already persisted by the background handler we skip
// it (same messageId); if not (e.g. data-only message) we persist it now.
export async function handleInitialNotification(): Promise<void> {
  const message = await messaging().getInitialNotification();
  if (message) {
    await handleMessage(message, /* showAlert */ false);
  }
}

/** @deprecated Use handleInitialNotification() instead */
export async function getInitialNotification() {
  return messaging().getInitialNotification();
}
