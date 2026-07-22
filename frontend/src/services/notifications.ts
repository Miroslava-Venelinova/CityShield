// ─── src/services/notifications.ts ───────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {IconName} from '../components/icons';
import type {TranslationKey} from '../i18n/translations';
import {alertsApi} from './api';

const STORAGE_KEY = 'cityshield_notifications';
// Server alert ids the user has dismissed. Kept separately from the list
// itself: deleting an entry only removes it from storage, and the next
// syncFromRecentAlerts would rebuild it straight back off the feed — which is
// what made the delete button look like it did nothing.
const DISMISSED_KEY = 'cityshield_notifications_dismissed';
const MAX_ITEMS   = 10;

export type NotificationCategory =
  'vik' | 'vt' | 'epro' | 'heating' | 'general';

export interface StoredNotification {
  id:         string;
  /** Server-side alert id — dedups repeated feed syncs of the same alert. */
  sourceId?:  string;
  title:      string;
  body:       string;
  category:   NotificationCategory;
  startTime:  string | null;
  endTime:    string | null;
  receivedAt: string;   // ISO timestamp
  read:       boolean;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function persist(items: StoredNotification[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export async function loadNotifications(): Promise<StoredNotification[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredNotification[]) : [];
  } catch {
    return [];
  }
}

async function loadDismissed(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

async function persistDismissed(ids: Set<string>): Promise<void> {
  await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
}

export async function addNotification(
  payload: Omit<StoredNotification, 'id' | 'receivedAt' | 'read'>,
): Promise<StoredNotification | null> {
  const existing = await loadNotifications();
  if (payload.sourceId && existing.some(n => n.sourceId === payload.sourceId)) {
    return null; // this alert is already in the list
  }
  if (payload.sourceId && (await loadDismissed()).has(payload.sourceId)) {
    return null; // the user deleted this one — don't resurrect it
  }
  const newItem: StoredNotification = {
    ...payload,
    id:         makeId(),
    receivedAt: new Date().toISOString(),
    read:       false,
  };
  const updated = [newItem, ...existing].slice(0, MAX_ITEMS);
  await persist(updated);
  return newItem;
}

/**
 * Rebuilds the list from the server's recent-alerts feed.
 *
 * Pushes are not persisted as they arrive: OneSignal has no headless Android
 * hook equivalent to Firebase's setBackgroundMessageHandler, so the feed is the
 * source of truth. It is also the more accurate one — it holds alerts that
 * arrived while the app was killed, and survives a reinstall.
 *
 * Local `read` flags and deletions are preserved across syncs, and never
 * throws: a failed sync just leaves the previously stored list in place.
 */
export async function syncFromRecentAlerts(authToken: string): Promise<StoredNotification[]> {
  const existing = await loadNotifications();
  try {
    const alerts = await alertsApi.getRecent(authToken);
    const readIds = new Set(existing.filter(n => n.read).map(n => n.sourceId));
    const dismissed = await loadDismissed();

    // The feed is a 48 h window, so an id that has aged out of it can never
    // come back — dropping those keeps the dismissed set from growing forever
    // without needing a separate expiry.
    const stillLive = new Set(alerts.map(a => a.id).filter(id => dismissed.has(id)));
    if (stillLive.size !== dismissed.size) await persistDismissed(stillLive);

    const synced: StoredNotification[] = alerts
      .filter(alert => !dismissed.has(alert.id))
      .slice(0, MAX_ITEMS)
      .map(alert => ({
        id:         makeId(),
        sourceId:   alert.id,
        title:      alert.original_message.title,
        body:       alert.original_message.content ?? alert.original_message.body ?? '',
        category:   (alert.source as NotificationCategory) ?? 'general',
        startTime:  alert.processed_data.start_time,
        endTime:    alert.processed_data.end_time,
        receivedAt: alert.created_at,
        read:       readIds.has(alert.id),
      }));

    await persist(synced);
    return synced;
  } catch {
    return existing;
  }
}

export async function markAsRead(id: string): Promise<void> {
  const items = await loadNotifications();
  await persist(items.map(n => n.id === id ? {...n, read: true} : n));
}

export async function markAllAsRead(): Promise<void> {
  const items = await loadNotifications();
  await persist(items.map(n => ({...n, read: true})));
}

export async function deleteNotification(id: string): Promise<void> {
  const items = await loadNotifications();
  // Remember the *server* id, not the local one: local ids are regenerated on
  // every sync, so they cannot identify the alert on the way back in.
  const gone = items.find(n => n.id === id);
  if (gone?.sourceId) {
    const dismissed = await loadDismissed();
    dismissed.add(gone.sourceId);
    await persistDismissed(dismissed);
  }
  await persist(items.filter(n => n.id !== id));
}

/** Full reset — drops the dismissal record too, so a fresh sign-in on this
 *  device starts from the feed rather than inheriting someone else's deletes. */
export async function clearNotifications(): Promise<void> {
  await AsyncStorage.multiRemove([STORAGE_KEY, DISMISSED_KEY]);
}

// ── Category metadata ─────────────────────────────────────────────────────────
// `icon` is an IconName rendered by src/components/icons.tsx
//
// Array order is also the *display* order for category lists (see
// categoryOrder below), independent of the order the API returns them in.
// Traffic sits last because it is the one category that expands: switching it
// on reveals the bus-line picker underneath, which would otherwise push the
// utility categories down the screen.
export const CATEGORIES: {
  key:   NotificationCategory;
  label: string;
  icon:  IconName;
  color: string;
}[] = [
  {key: 'vik',     label: 'Water (ВиК)',  icon: 'droplet',   color: '#3B82F6'},
  {key: 'epro',    label: 'Power (еПро)', icon: 'zap',       color: '#EF4444'},
  {key: 'heating', label: 'Heating',      icon: 'flame',     color: '#F97316'},
  {key: 'vt',      label: 'Traffic',      icon: 'bus',       color: '#F59E0B'},
  {key: 'general', label: 'General',      icon: 'megaphone', color: '#6B7280'},
];

/** Sort key for display lists. Unknown categories fall to the end. */
export function categoryOrder(category: string): number {
  const i = CATEGORIES.findIndex(c => c.key === category);
  return i === -1 ? CATEGORIES.length : i;
}

export function getCategoryMeta(category: string) {
  return (
    CATEGORIES.find(c => c.key === category) ??
    CATEGORIES.find(c => c.key === 'general')!
  );
}

// Translation key for a category's display label; screens render it with t()
// so the label follows the selected language (the `label` field above stays
// as the English fallback for non-UI uses).
export function getCategoryLabelKey(category: string): TranslationKey {
  return `category.${getCategoryMeta(category).key}` as TranslationKey;
}
