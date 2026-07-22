// ─── src/screens/NotificationsScreen.tsx ─────────────────────────────────────
import React, {useState, useEffect, useCallback} from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Switch, ActivityIndicator, RefreshControl, Alert,
  Modal, ScrollView, Platform,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {Colors, spacing, radius, font} from '../theme';
import {useTheme, useThemedStyles} from '../context/ThemeContext';
import Icon from '../components/icons';
import {useAuth} from '../context/AuthContext';
import {useI18n} from '../context/LanguageContext';
import {
  preferencesApi, NotificationPreferenceDTO, BusLineSubscriptionDTO,
} from '../services/api';
import {
  loadNotifications, syncFromRecentAlerts, markAsRead, markAllAsRead,
  deleteNotification, StoredNotification, getCategoryMeta, getCategoryLabelKey,
  categoryOrder,
} from '../services/notifications';

type Tab = 'inbox' | 'settings';

export default function NotificationsScreen() {
  const {token} = useAuth();
  const {t} = useI18n();
  const {colors} = useTheme();
  const styles = useThemedStyles(makeStyles);
  const picker = useThemedStyles(makePicker);

  const [activeTab,     setActiveTab]     = useState<Tab>('inbox');
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);
  const [preferences,   setPreferences]   = useState<NotificationPreferenceDTO[]>([]);
  const [prefLoading,   setPrefLoading]   = useState(false);
  const [refreshing,    setRefreshing]    = useState(false);
  const [selected,      setSelected]      = useState<StoredNotification | null>(null);
  const [busLines,      setBusLines]      = useState<BusLineSubscriptionDTO | null>(null);
  const [linePickerOpen, setLinePickerOpen] = useState(false);

  // ── Load inbox ─────────────────────────────────────────────────────────────
  // Show what's stored first so the list never blanks out, then reconcile with
  // the server feed — that feed, not the incoming pushes, is what fills this
  // list (see services/notifications.ts).
  const loadInbox = useCallback(async () => {
    setNotifications(await loadNotifications());
    if (token) setNotifications(await syncFromRecentAlerts(token));
  }, [token]);

  // ── Load category preferences ──────────────────────────────────────────────
  const loadPreferences = useCallback(async () => {
    if (!token) return;
    setPrefLoading(true);
    try {
      const [prefs, lines] = await Promise.all([
        preferencesApi.getAll(token),
        preferencesApi.getBusLines(token),
      ]);
      // The API returns them in its own KNOWN_CATEGORIES order; the display
      // order is ours (services/notifications.ts), which keeps Traffic — and
      // the bus-line picker it unfolds — at the bottom of the list.
      setPreferences([...prefs].sort(
        (a, b) => categoryOrder(a.category) - categoryOrder(b.category)));
      setBusLines(lines);
    } catch { /* shown in UI */ }
    finally { setPrefLoading(false); }
  }, [token]);

  useFocusEffect(useCallback(() => { loadInbox(); }, [loadInbox]));
  useEffect(() => { loadPreferences(); }, [loadPreferences]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadInbox(), loadPreferences()]);
    setRefreshing(false);
  };

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleOpen = async (item: StoredNotification) => {
    // Auto-mark as read when opened
    if (!item.read) {
      await markAsRead(item.id);
      setNotifications(prev =>
        prev.map(n => n.id === item.id ? {...n, read: true} : n));
      setSelected({...item, read: true});
    } else {
      setSelected(item);
    }
  };

  const handleMarkReadFromDetail = async () => {
    if (!selected) return;
    await markAsRead(selected.id);
    setNotifications(prev =>
      prev.map(n => n.id === selected.id ? {...n, read: true} : n));
    setSelected({...selected, read: true});
  };

  const handleDeleteFromDetail = async () => {
    if (!selected) return;
    Alert.alert(t('notif.deleteTitle'), t('notif.deleteMsg'), [
      {text: t('common.cancel'), style: 'cancel'},
      {text: t('notif.delete'), style: 'destructive', onPress: async () => {
        await deleteNotification(selected.id);
        setNotifications(prev => prev.filter(n => n.id !== selected.id));
        setSelected(null);
      }},
    ]);
  };

  const handleDeleteFromList = async (id: string) => {
    await deleteNotification(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const handleMarkAllRead = async () => {
    await markAllAsRead();
    setNotifications(prev => prev.map(n => ({...n, read: true})));
  };

  const handleToggle = async (category: string, newValue: boolean) => {
    if (!token) return;
    setPreferences(prev =>
      prev.map(p => p.category === category ? {...p, isEnabled: newValue} : p));
    try {
      await preferencesApi.set(category, newValue, token);
    } catch {
      setPreferences(prev =>
        prev.map(p => p.category === category ? {...p, isEnabled: !newValue} : p));
      Alert.alert(t('common.error'), t('notif.prefSaveFailed'));
    }
  };

  // ── Bus-line filter for Traffic alerts ─────────────────────────────────────
  // Every change PUTs the full selection (optimistic, reverted on failure).
  const saveBusLines = async (nextSelection: string[]) => {
    if (!token || !busLines) return;
    const prev = busLines;
    setBusLines({...busLines, selected: nextSelection});
    try {
      await preferencesApi.setBusLines(nextSelection, token);
    } catch {
      setBusLines(prev);
      Alert.alert(t('common.error'), t('notif.busSaveFailed'));
    }
  };

  const toggleBusLine = (line: string) => {
    if (!busLines) return;
    saveBusLines(
      busLines.selected.includes(line)
        ? busLines.selected.filter(l => l !== line)
        : [...busLines.selected, line],
    );
  };

  // Selected lines in catalog order for display
  const selectedLines = busLines
    ? busLines.available.filter(l => busLines.selected.includes(l))
    : [];
  const busLineSummary = !busLines
    ? '—'
    : selectedLines.length === 0
      ? t('notif.allLines')
      : selectedLines.join(', ');

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{t('notif.title')}</Text>
          {unreadCount > 0 && (
            <Text style={styles.headerSub}>
              {t('notif.unread').replace('{n}', String(unreadCount))}
            </Text>
          )}
        </View>
        {unreadCount > 0 && activeTab === 'inbox' && (
          <TouchableOpacity onPress={handleMarkAllRead} style={styles.markAllBtn}>
            <Text style={styles.markAllText}>{t('notif.markAllRead')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Tabs ── */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'inbox' && styles.tabActive]}
          onPress={() => setActiveTab('inbox')}>
          <Icon
            name="inbox"
            size={15}
            color={activeTab === 'inbox' ? colors.primary : colors.textMuted}
          />
          <Text style={[styles.tabText, activeTab === 'inbox' && styles.tabTextActive]}>
            {t('notif.inbox')}{unreadCount > 0 ? ` (${unreadCount})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'settings' && styles.tabActive]}
          onPress={() => setActiveTab('settings')}>
          <Icon
            name="settings"
            size={15}
            color={activeTab === 'settings' ? colors.primary : colors.textMuted}
          />
          <Text style={[styles.tabText, activeTab === 'settings' && styles.tabTextActive]}>
            {t('notif.categories')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Inbox ── */}
      {activeTab === 'inbox' && (
        <FlatList
          data={notifications}
          keyExtractor={n => n.id}
          contentContainerStyle={
            notifications.length === 0 ? styles.emptyContainer : styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
              tintColor={colors.primary} />}
          ListEmptyComponent={<EmptyInbox />}
          renderItem={({item}) => (
            <NotificationCard
              item={item}
              onPress={() => handleOpen(item)}
              onDelete={() => handleDeleteFromList(item.id)}
            />
          )}
        />
      )}

      {/* ── Categories ── */}
      {activeTab === 'settings' && (
        <View style={styles.settingsWrap}>
          <Text style={styles.settingsHint}>{t('notif.settingsHint')}</Text>
          {prefLoading ? (
            <ActivityIndicator style={{marginTop: spacing.xl}} color={colors.primary} />
          ) : (
            <View style={styles.prefsCard}>
              {preferences.map((pref, i) => {
                const meta = getCategoryMeta(pref.category);
                return (
                  <React.Fragment key={pref.category}>
                    {i > 0 && <View style={styles.divider} />}
                    <View style={styles.prefRow}>
                      <View style={[styles.catIcon, {backgroundColor: `${meta.color}22`}]}>
                        <Icon name={meta.icon} size={20} color={meta.color} />
                      </View>
                      <View style={styles.prefText}>
                        <Text style={styles.prefLabel}>
                          {t(getCategoryLabelKey(pref.category))}
                        </Text>
                        <Text style={styles.prefSub}>
                          {pref.isEnabled ? t('notif.receiving') : t('notif.muted')}
                        </Text>
                      </View>
                      <Switch
                        value={pref.isEnabled}
                        onValueChange={v => handleToggle(pref.category, v)}
                        trackColor={{false: colors.border, true: meta.color + '88'}}
                        thumbColor={pref.isEnabled ? meta.color : colors.textMuted}
                      />
                    </View>

                    {/* Bus-line filter — only meaningful while Traffic is on */}
                    {pref.category === 'vt' && pref.isEnabled && (
                      <TouchableOpacity
                        style={styles.busLineRow}
                        onPress={() => setLinePickerOpen(true)}
                        disabled={!busLines}
                        activeOpacity={0.7}>
                        <View style={styles.busLineText}>
                          <Text style={styles.busLineLabel}>{t('notif.busLines')}</Text>
                          <Text style={styles.busLineValue} numberOfLines={1}>
                            {busLineSummary}
                          </Text>
                        </View>
                        <Icon name="chevron-right" size={16} color={colors.textMuted} />
                      </TouchableOpacity>
                    )}
                  </React.Fragment>
                );
              })}
              {preferences.length === 0 && (
                <Text style={styles.prefEmpty}>{t('notif.prefLoadFailed')}</Text>
              )}
            </View>
          )}
        </View>
      )}

      {/* ── Bus-line dropdown ── */}
      <Modal
        visible={linePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setLinePickerOpen(false)}>
        <View style={picker.overlay}>
          <View style={picker.card}>
            <View style={picker.titleRow}>
              <Icon name="bus" size={18} color={colors.primary} />
              <Text style={picker.title}>{t('notif.busLines')}</Text>
              <TouchableOpacity
                onPress={() => setLinePickerOpen(false)}
                style={picker.closeBtn}
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="x" size={14} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={picker.hint}>{t('notif.pickerHint')}</Text>

            <ScrollView style={picker.list} showsVerticalScrollIndicator>
              {/* No filter */}
              <TouchableOpacity
                style={[picker.row, selectedLines.length === 0 && picker.rowActive]}
                onPress={() => saveBusLines([])}>
                <Text style={[
                  picker.rowText,
                  selectedLines.length === 0 && picker.rowTextActive,
                ]}>
                  {t('notif.allLines')}
                </Text>
                {selectedLines.length === 0 && (
                  <Icon name="check" size={16} color={colors.primary} />
                )}
              </TouchableOpacity>

              {(busLines?.available ?? []).map(line => {
                const isSelected = busLines?.selected.includes(line) ?? false;
                return (
                  <TouchableOpacity
                    key={line}
                    style={[picker.row, isSelected && picker.rowActive]}
                    onPress={() => toggleBusLine(line)}>
                    <Text style={[picker.rowText, isSelected && picker.rowTextActive]}>
                      {t('notif.line').replace('{n}', line)}
                    </Text>
                    {isSelected && (
                      <Icon name="check" size={16} color={colors.primary} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              style={picker.doneBtn}
              onPress={() => setLinePickerOpen(false)}>
              <Text style={picker.doneText}>{t('notif.done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Detail modal ── */}
      <DetailModal
        item={selected}
        onClose={() => setSelected(null)}
        onMarkRead={handleMarkReadFromDetail}
        onDelete={handleDeleteFromDetail}
      />
    </SafeAreaView>
  );
}

// ── NotificationCard ──────────────────────────────────────────────────────────

function NotificationCard({item, onPress, onDelete}: {
  item: StoredNotification;
  onPress:  () => void;
  onDelete: () => void;
}) {
  const {t}          = useI18n();
  const {colors}     = useTheme();
  const styles       = useThemedStyles(makeStyles);
  const meta         = getCategoryMeta(item.category);
  const receivedDate = new Date(item.receivedAt);
  const timeStr      = receivedDate.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  const dateStr      = receivedDate.toLocaleDateString([], {day: '2-digit', month: 'short'});

  return (
    <TouchableOpacity
      style={[styles.card, !item.read && styles.cardUnread]}
      onPress={onPress}
      activeOpacity={0.8}>

      {/* Unread dot */}
      {!item.read && (
        <View style={[styles.unreadDot, {backgroundColor: meta.color}]} />
      )}

      {/* Category icon */}
      <View style={[styles.cardIconWrap, {backgroundColor: `${meta.color}22`}]}>
        <Icon name={meta.icon} size={20} color={meta.color} />
      </View>

      {/* Body */}
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text
            style={[styles.cardTitle, !item.read && styles.cardTitleUnread]}
            numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.cardTime}>{timeStr}</Text>
        </View>

        <Text style={styles.cardMessage} numberOfLines={2}>{item.body}</Text>

        {(item.startTime || item.endTime) && (
          <View style={styles.timeRow}>
            <Icon name="clock" size={11} color={colors.textMuted} />
            <Text style={styles.timeText}>
              {item.startTime && item.endTime
                ? `${item.startTime} – ${item.endTime}`
                : item.startTime
                  ? `${t('common.from')} ${item.startTime}`
                  : `${t('common.until')} ${item.endTime}`}
            </Text>
          </View>
        )}

        <View style={styles.cardFooter}>
          <View style={[styles.catBadge, {borderColor: `${meta.color}55`}]}>
            <Text style={[styles.catBadgeText, {color: meta.color}]}>
              {t(getCategoryLabelKey(item.category))}
            </Text>
          </View>
          <Text style={styles.cardDate}>{dateStr}</Text>
        </View>
      </View>

      {/* Delete button */}
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={e => { e.stopPropagation?.(); onDelete(); }}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Icon name="x" size={13} color={colors.danger} strokeWidth={2.5} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ── DetailModal ───────────────────────────────────────────────────────────────

function DetailModal({item, onClose, onMarkRead, onDelete}: {
  item:        StoredNotification | null;
  onClose:     () => void;
  onMarkRead:  () => void;
  onDelete:    () => void;
}) {
  const {t} = useI18n();
  const {colors} = useTheme();
  const modal = useThemedStyles(makeModal);
  // Modals render outside the screen's SafeAreaView, so this sheet has to
  // clear the gesture bar on its own.
  const insets = useSafeAreaInsets();
  if (!item) return null;

  const meta         = getCategoryMeta(item.category);
  const receivedDate = new Date(item.receivedAt);
  const fullDateTime = receivedDate.toLocaleString([], {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <Modal
      visible={!!item}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={modal.overlay}>
        <View style={[modal.sheet, {paddingBottom: insets.bottom + spacing.lg}]}>

          {/* Handle bar */}
          <View style={modal.handle} />

          <ScrollView showsVerticalScrollIndicator={false}>

            {/* Category pill */}
            <View style={modal.categoryRow}>
              <View style={[modal.categoryBadge, {backgroundColor: `${meta.color}22`}]}>
                <Icon name={meta.icon} size={15} color={meta.color} />
                <Text style={[modal.categoryLabel, {color: meta.color}]}>
                  {t(getCategoryLabelKey(item.category))}
                </Text>
              </View>
              {!item.read && (
                <View style={modal.unreadBadge}>
                  <Text style={modal.unreadBadgeText}>{t('notif.unreadBadge')}</Text>
                </View>
              )}
            </View>

            {/* Title */}
            <Text style={modal.title}>{item.title}</Text>

            {/* Time window */}
            {(item.startTime || item.endTime) && (
              <View style={modal.timeBox}>
                <Icon name="clock" size={20} color={colors.textSecondary} />
                <View>
                  <Text style={modal.timeBoxLabel}>{t('notif.scheduledWindow')}</Text>
                  <Text style={modal.timeBoxValue}>
                    {item.startTime && item.endTime
                      ? `${item.startTime} – ${item.endTime}`
                      : item.startTime
                        ? `${t('common.from')} ${item.startTime}`
                        : `${t('common.until')} ${item.endTime}`}
                  </Text>
                </View>
              </View>
            )}

            {/* Body */}
            <View style={modal.bodyBox}>
              <Text style={modal.bodyText}>{item.body}</Text>
            </View>

            {/* Received at */}
            <Text style={modal.receivedAt}>
              {t('notif.received').replace('{date}', fullDateTime)}
            </Text>

          </ScrollView>

          {/* Actions */}
          <View style={modal.actions}>
            {!item.read && (
              <TouchableOpacity style={modal.actionSecondary} onPress={onMarkRead}>
                <Icon name="check" size={14} color={colors.primary} />
                <Text style={modal.actionSecondaryText}>{t('notif.markAsRead')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={modal.actionDanger} onPress={onDelete}>
              <Icon name="trash" size={14} color={colors.danger} />
              <Text style={modal.actionDangerText}>{t('notif.delete')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={modal.actionPrimary} onPress={onClose}>
              <Text style={modal.actionPrimaryText}>{t('notif.close')}</Text>
            </TouchableOpacity>
          </View>

        </View>
      </View>
    </Modal>
  );
}

// ── EmptyInbox ────────────────────────────────────────────────────────────────

function EmptyInbox() {
  const {t} = useI18n();
  const {colors} = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIconWrap}>
        <Icon name="bell" size={36} color={colors.textMuted} />
      </View>
      <Text style={styles.emptyTitle}>{t('notif.emptyTitle')}</Text>
      <Text style={styles.emptySub}>{t('notif.emptySub')}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const makeStyles = (colors: Colors) => StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.surface},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.md,
    backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: {color: colors.textPrimary, fontSize: font.sizes.xxl, fontWeight: font.weights.bold},
  headerSub:   {color: colors.primary, fontSize: font.sizes.xs, marginTop: 2},
  markAllBtn:  {paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary},
  markAllText: {color: colors.primary, fontSize: font.sizes.xs, fontWeight: font.weights.semibold},

  tabBar:       {flexDirection: 'row', backgroundColor: colors.background, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm},
  tab:          {flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 6, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border},
  tabActive:    {backgroundColor: `${colors.primary}22`, borderColor: colors.primary},
  tabText:      {color: colors.textMuted, fontSize: font.sizes.sm, fontWeight: font.weights.medium},
  tabTextActive:{color: colors.primary, fontWeight: font.weights.semibold},

  listContent:    {padding: spacing.md, gap: spacing.sm},
  emptyContainer: {flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl},

  card: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, paddingRight: spacing.sm,
    borderWidth: 1, borderColor: colors.border,
    position: 'relative', overflow: 'hidden', gap: spacing.md,
  },
  cardUnread:      {borderColor: `${colors.primary}44`, backgroundColor: `${colors.primary}08`},
  unreadDot:       {position: 'absolute', top: spacing.md, left: 6, width: 7, height: 7, borderRadius: 4},
  cardIconWrap:    {width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  cardBody:        {flex: 1, gap: 4},
  cardTop:         {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  cardTitle:       {flex: 1, color: colors.textSecondary, fontSize: font.sizes.md, fontWeight: font.weights.medium},
  cardTitleUnread: {color: colors.textPrimary, fontWeight: font.weights.semibold},
  cardTime:        {color: colors.textMuted, fontSize: font.sizes.xs, marginLeft: spacing.xs},
  cardMessage:     {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: font.lineHeights.sm},
  timeRow:         {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2},
  timeText:        {color: colors.textMuted, fontSize: font.sizes.xs},
  cardFooter:      {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4},
  catBadge:        {borderWidth: 1, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 2},
  catBadgeText:    {fontSize: 10, fontWeight: font.weights.semibold},
  cardDate:        {color: colors.textMuted, fontSize: 10},
  deleteBtn:       {width: 28, height: 28, borderRadius: 14, backgroundColor: `${colors.danger}15`, alignItems: 'center', justifyContent: 'center', marginLeft: spacing.xs, flexShrink: 0, alignSelf: 'center'},

  emptyWrap:  {alignItems: 'center', gap: spacing.md},
  emptyIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: {color: colors.textPrimary, fontSize: font.sizes.xl, fontWeight: font.weights.semibold},
  emptySub:   {color: colors.textMuted, fontSize: font.sizes.sm, textAlign: 'center', lineHeight: font.lineHeights.sm},

  settingsWrap: {flex: 1, padding: spacing.lg},
  settingsHint: {color: colors.textMuted, fontSize: font.sizes.sm, lineHeight: font.lineHeights.sm, marginBottom: spacing.lg},
  prefsCard:    {backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden'},
  divider:      {height: 1, backgroundColor: colors.border, marginLeft: 68},
  prefRow:      {flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.md},
  catIcon:      {width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center'},
  prefText:     {flex: 1},
  prefLabel:    {color: colors.textPrimary, fontSize: font.sizes.md, fontWeight: font.weights.medium},
  prefSub:      {color: colors.textMuted, fontSize: font.sizes.xs, marginTop: 2},
  prefEmpty:    {color: colors.textMuted, fontSize: font.sizes.sm, padding: spacing.lg, textAlign: 'center'},

  // Bus-line filter row (nested under the Traffic category)
  busLineRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm, paddingRight: spacing.md,
    paddingLeft: 68, // aligns with the category label above
    backgroundColor: colors.background,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  busLineText:  {flex: 1},
  busLineLabel: {color: colors.textSecondary, fontSize: font.sizes.xs},
  busLineValue: {color: colors.textPrimary, fontSize: font.sizes.sm, fontWeight: font.weights.medium, marginTop: 2},
});

// ── Bus-line dropdown styles ─────────────────────────────────────────────────
const makePicker = (colors: Colors) => StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: colors.overlay,
    justifyContent: 'center', padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.xl,
    padding: spacing.lg, maxHeight: '75%',
    borderWidth: 1, borderColor: colors.border,
  },
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm},
  title:    {flex: 1, color: colors.textPrimary, fontSize: font.sizes.lg, fontWeight: font.weights.bold},
  closeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center',
  },
  hint: {color: colors.textMuted, fontSize: font.sizes.xs, lineHeight: font.lineHeights.xs, marginBottom: spacing.md},
  list: {flexShrink: 1, borderTopWidth: 1, borderTopColor: colors.border},
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.md, paddingHorizontal: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowActive:     {backgroundColor: `${colors.primary}12`},
  rowText:       {color: colors.textSecondary, fontSize: font.sizes.md},
  rowTextActive: {color: colors.textPrimary, fontWeight: font.weights.semibold},
  doneBtn: {
    height: 46, borderRadius: radius.md, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: spacing.md,
  },
  doneText: {color: colors.white, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
});

const makeModal = (colors: Colors) => StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg, paddingBottom: Platform.OS === 'ios' ? 36 : spacing.lg,
    paddingTop: spacing.md,
    maxHeight: '85%',
    borderTopWidth: 1, borderColor: colors.border,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center', marginBottom: spacing.lg,
  },

  categoryRow:   {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md},
  categoryBadge: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.full},
  categoryLabel: {fontSize: font.sizes.sm, fontWeight: font.weights.semibold},
  unreadBadge:   {backgroundColor: `${colors.primary}22`, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 2, borderWidth: 1, borderColor: `${colors.primary}55`},
  unreadBadgeText:{color: colors.primary, fontSize: 10, fontWeight: font.weights.semibold},

  title:      {color: colors.textPrimary, fontSize: font.sizes.xl, fontWeight: font.weights.bold, lineHeight: font.lineHeights.xl, marginBottom: spacing.md},

  timeBox:      {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md},
  timeBoxLabel: {color: colors.textMuted, fontSize: font.sizes.xs, marginBottom: 2},
  timeBoxValue: {color: colors.textPrimary, fontSize: font.sizes.md, fontWeight: font.weights.medium},

  bodyBox:    {backgroundColor: colors.background, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, borderWidth: 1, borderColor: colors.border},
  bodyText:   {color: colors.textSecondary, fontSize: font.sizes.md, lineHeight: font.lineHeights.md},

  receivedAt: {color: colors.textMuted, fontSize: font.sizes.xs, textAlign: 'right', marginBottom: spacing.lg},

  actions:             {flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border},
  actionPrimary:       {flex: 1, height: 48, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'},
  actionPrimaryText:   {color: colors.white, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
  actionSecondary:     {height: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center'},
  actionSecondaryText: {color: colors.primary, fontSize: font.sizes.sm, fontWeight: font.weights.medium},
  actionDanger:        {height: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.danger, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center'},
  actionDangerText:    {color: colors.danger, fontSize: font.sizes.sm, fontWeight: font.weights.medium},
});
