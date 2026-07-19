// ─── src/screens/HomeScreen.tsx ──────────────────────────────────────────────
import React, {useState, useRef, useCallback, useEffect, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  RefreshControl,
  Modal,
  Animated,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import {colors, spacing, radius, font} from '../theme';
import CityShieldLogo from '../components/CityShieldLogo';
import AlertMap, {AlertMapHandle, MapMarker, MapPolygon} from '../components/AlertMap';
import Icon from '../components/icons';
import {alertsApi, Alert} from '../services/api';
import {getCategoryMeta} from '../services/notifications';
import {useAuth} from '../context/AuthContext';

const {height: SCREEN_HEIGHT} = Dimensions.get('window');

// ─── Severity / source helpers ────────────────────────────────────────────────
const SEVERITY_COLOR: Record<string, string> = {
  warning: colors.warning,
  info:    colors.accent,
  danger:  colors.danger,
};

const SEVERITY_BG: Record<string, string> = {
  warning: 'rgba(217,119,6,0.12)',
  info:    'rgba(14,165,233,0.12)',
  danger:  'rgba(220,38,38,0.12)',
};

// Per-category icon/color/label come from the shared registry in
// services/notifications.ts (CATEGORIES) so map pins, filter chips and the
// notification inbox can never drift apart.

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getAlertTitle(alert: Alert): string {
  return alert.original_message.title
    ?? alert.original_message.header
    ?? 'Alert';
}

function getAlertBody(alert: Alert): string {
  return alert.original_message.content
    ?? alert.original_message.body
    ?? '';
}

function formatTime(alert: Alert): string {
  const {start_time, end_time} = alert.processed_data;
  if (start_time && end_time) { return `${start_time} – ${end_time}`; }
  if (start_time) { return `From ${start_time}`; }
  return '';
}

// ── Active window ─────────────────────────────────────────────────────────────
// An alert stays "active" until the end time stated in the message ("HH:MM",
// anchored to the day it was published; an end before the publish time rolls
// over to the next day). Messages that state no end time stay active for 24h.
// Transport (vt) route changes are never "active" — they are notification-only
// and appear just under Recent.
const DEFAULT_ACTIVE_MS = 24 * 3600000;

function activeUntil(alert: Alert): number {
  const created = new Date(alert.created_at);
  const match = /^\s*(\d{1,2}):(\d{2})/.exec(alert.processed_data.end_time ?? '');
  if (!match) { return created.getTime() + DEFAULT_ACTIVE_MS; }
  const end = new Date(created);
  end.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (end.getTime() < created.getTime()) { end.setDate(end.getDate() + 1); }
  return end.getTime();
}

function isActive(alert: Alert): boolean {
  return alert.source !== 'vt' && activeUntil(alert) > Date.now();
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) { return 'Just now'; }
  if (h < 24) { return `${h}h ago`; }
  return `${Math.floor(h / 24)}d ago`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5)  { return 'Good evening,'; }
  if (h < 12) { return 'Good morning,'; }
  if (h < 18) { return 'Good afternoon,'; }
  return 'Good evening,';
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const {token, hasLocation} = useAuth();
  const mapRef = useRef<AlertMapHandle>(null);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [activeFilter, setActiveFilter] =
    useState<'all' | 'vik' | 'vt' | 'epro' | 'heating' | 'roads'>('all');
  const [feedTab, setFeedTab] = useState<'recent' | 'active'>('recent');

  const sheetAnim = useRef(new Animated.Value(0)).current;

  // ── Fetch alerts from the API ───────────────────────────────────────────────
  const fetchAlerts = useCallback(async () => {
    if (!token) { setLoading(false); return; }
    try {
      const data = await alertsApi.getRecent(token);
      setAlerts(Array.isArray(data) ? data : []);
      setFetchFailed(false);
    } catch {
      // Network error or expired/invalid token — the empty state offers a retry
      setAlerts([]);
      setFetchFailed(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAlerts();
    setRefreshing(false);
  }, [fetchAlerts]);

  // ── Bottom sheet open/close ─────────────────────────────────────────────────
  const openSheet = (alert: Alert) => {
    setSelectedAlert(alert);
    Animated.spring(sheetAnim, {toValue: 1, useNativeDriver: true, tension: 60, friction: 10}).start();
  };

  const closeSheet = () => {
    Animated.timing(sheetAnim, {toValue: 0, duration: 220, useNativeDriver: true}).start(() => {
      setSelectedAlert(null);
    });
  };

  // ── Fly to pin when tapping alert card ─────────────────────────────────────
  // Transport (vt) alerts are notification-only and never on the map, so the
  // card just opens the detail sheet without moving the map.
  const flyToAlert = (alert: Alert) => {
    const loc = alert.processed_data.locations[0];
    if (alert.source !== 'vt' && loc?.lat && loc?.lng) {
      mapRef.current?.flyTo(loc.lat, loc.lng, 14);
    }
    openSheet(alert);
  };

  const recenterMap = () => {
    mapRef.current?.recenter();
  };

  const filteredAlerts = useMemo(
    () => (activeFilter === 'all'
      ? alerts
      : alerts.filter(a => a.source === activeFilter)),
    [alerts, activeFilter],
  );

  // Recent = the last 10 alerts; Active = alerts whose stated time window is
  // still running (never vt — route changes are notification-only).
  const recentAlerts = useMemo(() => filteredAlerts.slice(0, 10), [filteredAlerts]);
  const activeAlerts = useMemo(() => filteredAlerts.filter(isActive), [filteredAlerts]);
  const feedAlerts   = feedTab === 'active' ? activeAlerts : recentAlerts;

  const activeCount   = alerts.filter(isActive).length;
  const criticalCount = alerts.filter(a => a.severity === 'danger').length;
  const warningCount  = alerts.filter(a => a.severity === 'warning').length;

  const sheetTranslate = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [300, 0],
  });

  // ── Map overlays ────────────────────────────────────────────────────────────
  // Memoized: AlertMap re-injects (tears down and rebuilds) every Leaflet
  // marker/polygon in the WebView whenever these identities change, so they
  // must not be rebuilt on unrelated renders (sheet open, refresh spinner, …).
  // Transport (vt) alerts never render on the map — notifications/feed only.
  const mapAlerts = useMemo(
    () => filteredAlerts.filter(a => a.source !== 'vt'),
    [filteredAlerts],
  );

  const alertById = useMemo(
    () => new Map(mapAlerts.map(a => [a.id, a])),
    [mapAlerts],
  );

  const mapMarkers: MapMarker[] = useMemo(
    () => mapAlerts.flatMap(alert =>
      alert.processed_data.locations
        .filter(l => l.lat && l.lng)
        .map((loc, idx): MapMarker => ({
          id: `${alert.id}::${idx}`,
          lat: loc.lat!,
          lng: loc.lng!,
          color: SEVERITY_COLOR[alert.severity],
        }))
    ),
    [mapAlerts],
  );

  const mapPolygons: MapPolygon[] = useMemo(
    () => mapAlerts.flatMap(alert =>
      alert.processed_data.locations
        .filter(l => l.is_polygon && l.polygon_geojson)
        .map((loc, idx): MapPolygon => ({
          id: `poly-${alert.id}-${idx}`,
          coords: loc.polygon_geojson!.coordinates[0].map(
            ([lng, lat]: [number, number]): [number, number] => [lat, lng]
          ),
          color: SEVERITY_COLOR[alert.severity],
        }))
    ),
    [mapAlerts],
  );

  const handleMarkerPress = (markerId: string) => {
    const alert = alertById.get(markerId.split('::')[0]);
    if (alert) { openSheet(alert); }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.surface} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }>

        {/* ── No-location prompt banner ── */}
        {hasLocation === false && (
          <View style={styles.noLocationBanner}>
            <Icon name="map-pin" size={22} color={colors.danger} />
            <View style={styles.noLocationText}>
              <Text style={styles.noLocationTitle}>Location not set</Text>
              <Text style={styles.noLocationSub}>
                Go to Profile → Set My Location to receive alerts for your area.
              </Text>
            </View>
          </View>
        )}

        {/* ── Hero ── */}
        <View style={styles.hero}>
          <View style={styles.heroLeft}>
            <Text style={styles.heroGreeting}>{greeting()}</Text>
            <Text style={styles.heroTitle}>City Monitor</Text>
            <View style={styles.statusBadge}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>System Active</Text>
            </View>
          </View>
          <CityShieldLogo size={54} showWordmark={false} />
        </View>

        {/* ── Stats ── */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{activeCount}</Text>
            <Text style={styles.statLabel}>Active Alerts</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, warningCount > 0 && {color: colors.warning}]}>
              {warningCount}
            </Text>
            <Text style={styles.statLabel}>Warnings</Text>
          </View>
          <View style={[styles.statCard, criticalCount > 0 && styles.statCardDanger]}>
            <Text style={[styles.statValue, criticalCount > 0 && {color: colors.danger}]}>
              {criticalCount}
            </Text>
            <Text style={styles.statLabel}>Critical</Text>
          </View>
        </View>

        {/* ── Map section ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Alert Map</Text>
            <TouchableOpacity
              style={styles.expandBtn}
              onPress={() => setMapExpanded(v => !v)}>
              <Text style={styles.expandBtnText}>
                {mapExpanded ? 'Collapse' : 'Expand'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.mapCard, mapExpanded && styles.mapCardExpanded]}>
            {/* OpenStreetMap via Leaflet in a WebView — no Google SDK, no keys */}
            <AlertMap
              ref={mapRef}
              style={StyleSheet.absoluteFill}
              markers={mapMarkers}
              polygons={mapPolygons}
              onMarkerPress={handleMarkerPress}
            />

            {/* Recenter button */}
            <TouchableOpacity style={styles.recenterBtn} onPress={recenterMap}>
              <Icon name="navigation" size={16} color={colors.primary} />
            </TouchableOpacity>

            {/* Legend overlay */}
            <View style={styles.mapLegend}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, {backgroundColor: colors.danger}]} />
                <Text style={styles.legendText}>Critical</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, {backgroundColor: colors.warning}]} />
                <Text style={styles.legendText}>Warning</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, {backgroundColor: colors.accent}]} />
                <Text style={styles.legendText}>Info</Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── Source filter chips ── */}
        <View style={styles.filterRow}>
          {(['all', 'vik', 'vt', 'epro', 'heating', 'roads'] as const).map(f => (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, activeFilter === f && styles.filterChipActive]}
              onPress={() => setActiveFilter(f)}>
              {f !== 'all' && (
                <Icon
                  name={getCategoryMeta(f).icon}
                  size={13}
                  color={activeFilter === f ? colors.white : colors.textSecondary}
                />
              )}
              <Text style={[
                styles.filterChipText,
                activeFilter === f && styles.filterChipTextActive,
              ]}>
                {f === 'all' ? 'All' : getCategoryMeta(f).label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Alert cards ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Alerts</Text>
            {activeAlerts.length > 0 && (
              <View style={styles.alertBadge}>
                <Text style={styles.alertBadgeText}>{activeAlerts.length} active</Text>
              </View>
            )}
          </View>

          {/* Recent = last 10 alerts; Active = alerts still inside the time
              window stated in the message (vt route changes never count). */}
          <View style={styles.feedTabBar}>
            <TouchableOpacity
              style={[styles.feedTab, feedTab === 'recent' && styles.feedTabActive]}
              onPress={() => setFeedTab('recent')}>
              <Text style={[
                styles.feedTabText,
                feedTab === 'recent' && styles.feedTabTextActive,
              ]}>
                Recent
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.feedTab, feedTab === 'active' && styles.feedTabActive]}
              onPress={() => setFeedTab('active')}>
              <Text style={[
                styles.feedTabText,
                feedTab === 'active' && styles.feedTabTextActive,
              ]}>
                Active{activeAlerts.length > 0 ? ` (${activeAlerts.length})` : ''}
              </Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.loadingText}>Loading alerts…</Text>
            </View>
          ) : feedAlerts.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Icon
                name={fetchFailed ? 'refresh' : 'check'}
                size={30}
                color={fetchFailed ? colors.textMuted : colors.success}
              />
              <Text style={styles.emptyTitle}>
                {fetchFailed ? 'Couldn’t load alerts' : 'All clear'}
              </Text>
              <Text style={styles.emptySub}>
                {fetchFailed
                  ? 'The alert service is unreachable. Pull down to try again.'
                  : feedTab === 'active'
                    ? 'No alerts are active right now. Pull down to refresh.'
                    : 'No recent alerts for Varna. Pull down to refresh.'}
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.sectionSubtitle}>Tap a card to view details</Text>
              {feedAlerts.map(alert => (
                <TouchableOpacity
                  key={alert.id}
                  style={styles.alertCard}
                  onPress={() => flyToAlert(alert)}
                  activeOpacity={0.8}>
                  <View style={[styles.alertAccent, {backgroundColor: SEVERITY_COLOR[alert.severity]}]} />
                  <View style={styles.alertContent}>
                    <View style={styles.alertTop}>
                      <View style={[styles.alertIconWrap, {backgroundColor: `${getCategoryMeta(alert.source).color}18`}]}>
                        <Icon
                          name={getCategoryMeta(alert.source).icon}
                          size={17}
                          color={getCategoryMeta(alert.source).color}
                        />
                      </View>
                      <View style={styles.alertMeta}>
                        <Text style={styles.alertTitle} numberOfLines={1}>
                          {getAlertTitle(alert)}
                        </Text>
                        <Text style={styles.alertTime}>
                          {timeAgo(alert.created_at)}
                          {alert.processed_data.locations[0]?.location_name
                            ? ` · ${alert.processed_data.locations[0].location_name}`
                            : ''}
                        </Text>
                      </View>
                      <View style={[styles.sevBadge, {backgroundColor: SEVERITY_BG[alert.severity]}]}>
                        <View style={[styles.sevDot, {backgroundColor: SEVERITY_COLOR[alert.severity]}]} />
                      </View>
                    </View>
                    <Text style={styles.alertMessage} numberOfLines={2}>
                      {getAlertBody(alert)}
                    </Text>
                    {formatTime(alert) ? (
                      <View style={styles.alertTimeRow}>
                        <Icon name="clock" size={12} color={colors.accent} />
                        <Text style={styles.alertTimeWindow}>{formatTime(alert)}</Text>
                      </View>
                    ) : null}
                  </View>
                </TouchableOpacity>
              ))}
            </>
          )}
        </View>

        {/* ── Info card ── */}
        <View style={styles.infoCard}>
          <Icon name="info" size={20} color={colors.primary} />
          <View style={{flex: 1}}>
            <Text style={styles.infoCardTitle}>How it works</Text>
            <Text style={styles.infoCardText}>
              Alerts from ВиК (water), еПро (power), Веолия (heating) and АПИ
              (roads) are scraped, AI-parsed, and geo-located on the map.
              VarnaTraffic route changes arrive as notifications and show up
              under Recent — pick your bus lines in Notifications → Categories.
            </Text>
          </View>
        </View>

        <View style={{height: spacing.xxl}} />
      </ScrollView>

      {/* ── Alert detail bottom sheet ── */}
      <Modal
        visible={selectedAlert !== null}
        transparent
        animationType="none"
        onRequestClose={closeSheet}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={closeSheet}>
          <Animated.View
            style={[styles.sheet, {transform: [{translateY: sheetTranslate}]}]}
            // Prevent backdrop close when tapping the sheet itself
            onStartShouldSetResponder={() => true}>
            {selectedAlert && (
              <>
                {/* Handle */}
                <View style={styles.sheetHandle} />

                {/* Header */}
                <View style={styles.sheetHeader}>
                  <View style={[styles.sheetSourceBadge, {backgroundColor: SEVERITY_BG[selectedAlert.severity]}]}>
                    <Icon
                      name={getCategoryMeta(selectedAlert.source).icon}
                      size={15}
                      color={SEVERITY_COLOR[selectedAlert.severity]}
                    />
                    <Text style={[styles.sheetSourceLabel, {color: SEVERITY_COLOR[selectedAlert.severity]}]}>
                      {getCategoryMeta(selectedAlert.source).label}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={closeSheet} style={styles.closeBtn}>
                    <Icon name="x" size={15} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.sheetTitle}>{getAlertTitle(selectedAlert)}</Text>
                <Text style={styles.sheetBody}>{getAlertBody(selectedAlert)}</Text>

                {/* Meta row */}
                <View style={styles.sheetMeta}>
                  {formatTime(selectedAlert) ? (
                    <View style={styles.sheetMetaChip}>
                      <Icon name="clock" size={12} color={colors.textSecondary} />
                      <Text style={styles.sheetMetaText}>{formatTime(selectedAlert)}</Text>
                    </View>
                  ) : null}
                  <View style={styles.sheetMetaChip}>
                    <Text style={styles.sheetMetaText}>{timeAgo(selectedAlert.created_at)}</Text>
                  </View>
                  <View style={[styles.sheetMetaChip, {backgroundColor: SEVERITY_BG[selectedAlert.severity]}]}>
                    <Text style={[styles.sheetMetaText, {color: SEVERITY_COLOR[selectedAlert.severity]}]}>
                      {selectedAlert.severity.toUpperCase()}
                    </Text>
                  </View>
                </View>

                {/* Locations */}
                {selectedAlert.processed_data.locations.map((loc, i) => (
                  <View key={i} style={styles.sheetLocRow}>
                    <View style={styles.sheetLocTitleRow}>
                      <Icon name="map-pin" size={14} color={colors.primary} />
                      <Text style={styles.sheetLocName}>{loc.location_name}</Text>
                    </View>
                    {loc.sublocations.length > 0 && (
                      <Text style={styles.sheetSubLocs}>
                        {loc.sublocations.join(' · ')}
                      </Text>
                    )}
                  </View>
                ))}
              </>
            )}
          </Animated.View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.dark},
  noLocationBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: `${colors.danger}15`,
    borderBottomWidth: 1, borderBottomColor: `${colors.danger}44`,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md,
  },
  noLocationText:  {flex: 1},
  noLocationTitle: {color: colors.textPrimary, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
  noLocationSub:   {color: colors.textSecondary, fontSize: font.sizes.xs, marginTop: 2},

  // Hero
  hero: {
    flexDirection: 'row', alignItems: 'center',
    padding: spacing.xl, paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  heroLeft:    {flex: 1},
  heroGreeting:{color: colors.textSecondary, fontSize: font.sizes.sm},
  heroTitle:   {color: colors.textPrimary, fontSize: font.sizes.xxl, fontWeight: font.weights.extrabold, marginTop: 2},
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm,
    backgroundColor: 'rgba(22,163,74,0.1)', paddingHorizontal: spacing.sm,
    paddingVertical: 4, borderRadius: radius.full, alignSelf: 'flex-start',
    borderWidth: 1, borderColor: 'rgba(22,163,74,0.3)',
  },
  statusDot:  {width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success, marginRight: spacing.xs},
  statusText: {color: colors.success, fontSize: font.sizes.xs, fontWeight: font.weights.semibold},

  // Stats
  statsRow: {flexDirection: 'row', padding: spacing.lg, gap: spacing.sm},
  statCard: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  statCardDanger: {borderColor: `${colors.danger}66`, borderWidth: 1.5},
  statValue: {fontSize: font.sizes.xxl, fontWeight: font.weights.extrabold, color: colors.primary},
  statLabel: {fontSize: font.sizes.xs, color: colors.textSecondary, marginTop: 2, textAlign: 'center'},

  // Section
  section:       {paddingHorizontal: spacing.lg, marginBottom: spacing.lg},
  sectionHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm},
  sectionTitle:  {fontSize: font.sizes.lg, fontWeight: font.weights.bold, color: colors.textPrimary, flex: 1},
  sectionSubtitle:{color: colors.textMuted, fontSize: font.sizes.sm, marginBottom: spacing.md},
  alertBadge: {
    backgroundColor: 'rgba(220,38,38,0.1)', borderRadius: radius.full,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderWidth: 1, borderColor: 'rgba(220,38,38,0.3)',
  },
  alertBadgeText: {color: colors.danger, fontSize: font.sizes.xs, fontWeight: font.weights.semibold},

  // Recent / Active feed tabs
  feedTabBar: {flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm},
  feedTab: {
    flex: 1, alignItems: 'center', paddingVertical: spacing.sm,
    borderRadius: radius.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  feedTabActive:     {backgroundColor: `${colors.primary}22`, borderColor: colors.primary},
  feedTabText:       {color: colors.textMuted, fontSize: font.sizes.sm, fontWeight: font.weights.medium},
  feedTabTextActive: {color: colors.primary, fontWeight: font.weights.semibold},

  // Loading / empty states
  loadingWrap: {alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm},
  loadingText: {color: colors.textMuted, fontSize: font.sizes.sm},
  emptyWrap: {
    alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.xl, paddingHorizontal: spacing.lg,
  },
  emptyTitle: {color: colors.textPrimary, fontSize: font.sizes.lg, fontWeight: font.weights.semibold, marginTop: spacing.xs},
  emptySub:   {color: colors.textMuted, fontSize: font.sizes.sm, textAlign: 'center', lineHeight: 19},

  // Map
  mapCard: {
    height: 260, borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  mapCardExpanded: {height: SCREEN_HEIGHT * 0.5},
  expandBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 4,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.primary,
  },
  expandBtnText: {color: colors.primary, fontSize: font.sizes.xs, fontWeight: font.weights.semibold},
  recenterBtn: {
    position: 'absolute', top: 10, right: 10,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.95)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.12, shadowRadius: 4, elevation: 3,
  },
  mapLegend: {
    position: 'absolute', bottom: 10, right: 10,
    backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: radius.md,
    padding: 8, gap: 4, borderWidth: 1, borderColor: colors.border,
  },
  legendItem: {flexDirection: 'row', alignItems: 'center', gap: 5},
  legendDot:  {width: 8, height: 8, borderRadius: 4},
  legendText: {fontSize: 10, color: colors.textSecondary},

  // Filter chips
  filterRow: {
    flexDirection: 'row', paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md, gap: spacing.sm, flexWrap: 'wrap',
  },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: {backgroundColor: colors.primary, borderColor: colors.primary},
  filterChipText:   {fontSize: font.sizes.sm, color: colors.textSecondary, fontWeight: font.weights.medium},
  filterChipTextActive: {color: colors.white},

  // Alert cards
  alertCard: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderRadius: radius.lg, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.05, shadowRadius: 4, elevation: 1,
  },
  alertAccent:  {width: 4},
  alertContent: {flex: 1, padding: spacing.md},
  alertTop: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.xs},
  alertIconWrap: {
    width: 34, height: 34, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm,
  },
  alertMeta:    {flex: 1},
  alertTitle:   {color: colors.textPrimary, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
  alertTime:    {color: colors.textMuted, fontSize: font.sizes.xs, marginTop: 2},
  alertMessage: {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: 18},
  alertTimeRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4},
  alertTimeWindow:{color: colors.accent, fontSize: font.sizes.xs, fontWeight: font.weights.medium},
  sevBadge: {width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  sevDot:   {width: 8, height: 8, borderRadius: 4},

  // Info card
  infoCard: {
    flexDirection: 'row', marginHorizontal: spacing.lg,
    backgroundColor: `${colors.primary}0D`, borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: `${colors.primary}30`, gap: spacing.md,
  },
  infoCardTitle: {color: colors.primary, fontWeight: font.weights.semibold, marginBottom: spacing.xs},
  infoCardText:  {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: 18},

  // Bottom sheet
  sheetBackdrop: {
    flex: 1, backgroundColor: 'rgba(13,33,69,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.xl, paddingTop: spacing.md,
    borderTopWidth: 1, borderColor: colors.border,
    maxHeight: SCREEN_HEIGHT * 0.65,
  },
  sheetHandle: {
    width: 40, height: 4, backgroundColor: colors.border,
    borderRadius: 2, alignSelf: 'center', marginBottom: spacing.md,
  },
  sheetHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md},
  sheetSourceBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.sm, paddingVertical: 5,
    borderRadius: radius.full, flex: 1,
  },
  sheetSourceLabel: {fontSize: font.sizes.sm, fontWeight: font.weights.semibold},
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.dark, alignItems: 'center', justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: font.sizes.xl, fontWeight: font.weights.bold,
    color: colors.textPrimary, marginBottom: spacing.sm,
  },
  sheetBody: {
    fontSize: font.sizes.md, color: colors.textSecondary,
    lineHeight: 22, marginBottom: spacing.md,
  },
  sheetMeta: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md},
  sheetMetaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    backgroundColor: colors.dark, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
  },
  sheetMetaText: {fontSize: font.sizes.xs, color: colors.textSecondary, fontWeight: font.weights.medium},
  sheetLocRow:   {marginBottom: spacing.sm},
  sheetLocTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  sheetLocName:  {fontSize: font.sizes.md, color: colors.textPrimary, fontWeight: font.weights.semibold},
  sheetSubLocs:  {fontSize: font.sizes.sm, color: colors.textSecondary, marginTop: 2, marginLeft: 20},
});
