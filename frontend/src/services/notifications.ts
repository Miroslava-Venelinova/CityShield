// ─── src/services/notifications.ts ───────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {IconName} from '../components/icons';

const STORAGE_KEY = 'cityshield_notifications';
const MAX_ITEMS   = 10;

export type NotificationCategory =
  'vik' | 'vt' | 'epro' | 'heating' | 'roads' | 'general';

export interface StoredNotification {
  id:         string;
  /** FCM messageId when available — dedups the background-handler +
   *  cold-start-tap double delivery of the same message. */
  messageId?: string;
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

export async function addNotification(
  payload: Omit<StoredNotification, 'id' | 'receivedAt' | 'read'>,
): Promise<StoredNotification | null> {
  const existing = await loadNotifications();
  if (payload.messageId && existing.some(n => n.messageId === payload.messageId)) {
    return null; // same FCM message already persisted by another handler
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
  await persist(items.filter(n => n.id !== id));
}

export async function clearNotifications(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

// ── Category metadata ─────────────────────────────────────────────────────────
// `icon` is an IconName rendered by src/components/icons.tsx
export const CATEGORIES: {
  key:   NotificationCategory;
  label: string;
  icon:  IconName;
  color: string;
}[] = [
  {key: 'vik',     label: 'Water (ВиК)',  icon: 'droplet',   color: '#3B82F6'},
  {key: 'vt',      label: 'Traffic',      icon: 'bus',       color: '#F59E0B'},
  {key: 'epro',    label: 'Power (еПро)', icon: 'zap',       color: '#EF4444'},
  {key: 'heating', label: 'Heating',      icon: 'flame',     color: '#F97316'},
  {key: 'roads',   label: 'Roads (АПИ)',  icon: 'road',      color: '#8B5CF6'},
  {key: 'general', label: 'General',      icon: 'megaphone', color: '#6B7280'},
];

export function getCategoryMeta(category: string) {
  return (
    CATEGORIES.find(c => c.key === category) ??
    CATEGORIES.find(c => c.key === 'general')!
  );
}
