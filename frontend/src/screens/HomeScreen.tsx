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
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {colors, spacing, radius, font, elevation} from '../theme';
import CityShieldLogo from '../components/CityShieldLogo';
import AlertMap, {AlertMapHandle, MapMarker, MapPolygon} from '../components/AlertMap';
import Icon from '../components/icons';
import {alertsApi, Alert, AlertLocation} from '../services/api';
import {getCategoryMeta, getCategoryLabelKey} from '../services/notifications';
import {useAuth} from '../context/AuthContext';
import {useI18n} from '../context/LanguageContext';
import {TranslationKey} from '../i18n/translations';

const {height: SCREEN_HEIGHT} = Dimensions.get('window');

// ─── Severity / source helpers ────────────────────────────────────────────────
const SEVERITY_COLOR: Record<string, string> = {
  warning: colors.warning,
  info:    colors.accent,
  danger:  colors.danger,
};

const SEVERITY_BG: Record<string, string> = {
  warning: colors.warningSoft,
  info:    colors.infoSoft,
  danger:  colors.dangerSoft,
};

// Per-category icon/color/label come from the shared registry in
// services/notifications.ts (CATEGORIES) so map pins, filter chips and the
// notification inbox can never drift apart.

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Display helpers take the i18n `t` so their output follows the app language.
type T = (key: TranslationKey) => string;

function getAlertTitle(alert: Alert, t: T): string {
  return alert.original_message.title
    ?? alert.original_message.header
    ?? t('home.defaultAlertTitle');
}

function getAlertBody(alert: Alert): string {
  return alert.original_message.content
    ?? alert.original_message.body
    ?? '';
}

function formatTime(alert: Alert, t: T): string {
  const {start_time, end_time} = alert.processed_data;
  if (start_time && end_time) { return `${start_time} – ${end_time}`; }
  if (start_time) { return `${t('common.from')} ${start_time}`; }
  return '';
}

// ── Untrusted map geometry ────────────────────────────────────────────────────
// Alert geometry originates from scraped pages, is shaped by an LLM and is
// stored as opaque JSON, so its runtime shape is not guaranteed by the DTO
// types. `polygon_geojson.coordinates[0].map(...)` therefore threw a
// TypeError on any malformed polygon — inside a `useMemo` during render, which
// took down the whole Home screen rather than dropping one bad shape.

/** Locations array for an alert, tolerating a malformed `processed_data`. */
function locationsOf(alert: Alert): AlertLocation[] {
  const locations = alert.processed_data?.locations;
  return Array.isArray(locations) ? locations : [];
}

/**
 * Outer ring of a GeoJSON polygon as Leaflet [lat, lng] pairs, or null if the
 * geometry is unusable. Accepts a bare Polygon geometry (what the API
 * normalizes to) and reads the first ring of a MultiPolygon.
 */
function polygonRing(geojson: unknown): [number, number][] | null {
  const geom = geojson as {type?: string; coordinates?: unknown} | null;
  if (!geom || typeof geom !== 'object' || !Array.isArray(geom.coordinates)) {
    return null;
  }

  const ring = geom.type === 'MultiPolygon'
    ? (geom.coordinates as unknown[][])[0]?.[0]
    : (geom.coordinates as unknown[])[0];
  if (!Array.isArray(ring)) { return null; }

  const coords: [number, number][] = [];
  for (const pair of ring) {
    // GeoJSON is [lng, lat]; Leaflet wants [lat, lng].
    if (
      Array.isArray(pair) && pair.length >= 2 &&
      Number.isFinite(pair[0]) && Number.isFinite(pair[1])
    ) {
      coords.push([pair[1] as number, pair[0] as number]);
    }
  }
  // Fewer than 3 vertices is not a renderable ring.
  return coords.length >= 3 ? coords : null;
}

function severityLabel(severity: string, t: T): string {
  if (severity === 'danger' || severity === 'warning' || severity === 'info') {
    return t(`severity.${severity}`);
  }
  return severity.toUpperCase();
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

function timeAgo(iso: string, t: T): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) { return t('home.justNow'); }
  if (h < 24) { return t('home.hoursAgo').replace('{n}', String(h)); }
  return t('home.daysAgo').replace('{n}', String(Math.floor(h / 24)));
}

function greeting(t: T): string {
  const h = new Date().getHours();
  if (h < 5)  { return t('home.goodEvening'); }
  if (h < 12) { return t('home.goodMorning'); }
  if (h < 18) { return t('home.goodAfternoon'); }
  return t('home.goodEvening');
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const {token, hasLocation} = useAuth();
  const {t} = useI18n();
  const insets = useSafeAreaInsets();
  const mapRef = useRef<AlertMapHandle>(null);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [activeFilter, setActiveFilter] =
    useState<'all' | 'vik' | 'vt' | 'epro' | 'heating'>('all');
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
      locationsOf(alert)
        // `Number.isFinite`, not truthiness: a coordinate of exactly 0 is
        // valid and was previously dropped.
        .map((loc, idx) => ({loc, idx}))
        .filter(({loc}) => Number.isFinite(loc.lat) && Number.isFinite(loc.lng))
        .map(({loc, idx}): MapMarker => ({
          id: `${alert.id}::${idx}`,
          lat: loc.lat!,
          lng: loc.lng!,
          color: SEVERITY_COLOR[alert.severity] ?? colors.textMuted,
        }))
    ),
    [mapAlerts],
  );

  const mapPolygons: MapPolygon[] = useMemo(
    () => mapAlerts.flatMap(alert =>
      locationsOf(alert)
        .map((loc, idx) => ({ring: loc.is_polygon ? polygonRing(loc.polygon_geojson) : null, idx}))
        // Unusable geometry drops that one shape; the rest of the map renders.
        .filter((entry): entry is {ring: [number, number][]; idx: number} => entry.ring !== null)
        .map(({ring, idx}): MapPolygon => ({
          id: `poly-${alert.id}-${idx}`,
          coords: ring,
          color: SEVERITY_COLOR[alert.severity] ?? colors.textMuted,
        }))
    ),
    [mapAlerts],
  );

  const handleMarkerPress = (markerId: string) => {
    const alert = alertById.get(markerId.split('::')[0]);
    if (alert) { openSheet(alert); }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="dark-content" translucent />

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
              <Text style={styles.noLocationTitle}>{t('home.noLocationTitle')}</Text>
              <Text style={styles.noLocationSub}>{t('home.noLocationSub')}</Text>
            </View>
          </View>
        )}

        {/* ── Hero ── */}
        <View style={styles.hero}>
          <View style={styles.heroLeft}>
            <Text style={styles.heroGreeting}>{greeting(t)}</Text>
            <Text style={styles.heroTitle}>{t('home.title')}</Text>
            <View style={styles.statusBadge}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>{t('home.systemActive')}</Text>
            </View>
          </View>
          <CityShieldLogo size={54} showWordmark={false} />
        </View>

        {/* ── Stats ── */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{activeCount}</Text>
            <Text style={styles.statLabel}>{t('home.statActive')}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, warningCount > 0 && {color: colors.warning}]}>
              {warningCount}
            </Text>
            <Text style={styles.statLabel}>{t('home.statWarnings')}</Text>
          </View>
          <View style={[styles.statCard, criticalCount > 0 && styles.statCardDanger]}>
            <Text style={[styles.statValue, criticalCount > 0 && {color: colors.danger}]}>
              {criticalCount}
            </Text>
            <Text style={styles.statLabel}>{t('home.statCritical')}</Text>
          </View>
        </View>

        {/* ── Map section ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('home.alertMap')}</Text>
            <TouchableOpacity
              style={styles.expandBtn}
              onPress={() => setMapExpanded(v => !v)}>
              <Text style={styles.expandBtnText}>
                {mapExpanded ? t('home.collapse') : t('home.expand')}
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
                <Text style={styles.legendText}>{t('home.legendCritical')}</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, {backgroundColor: colors.warning}]} />
                <Text style={styles.legendText}>{t('home.legendWarning')}</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, {backgroundColor: colors.accent}]} />
                <Text style={styles.legendText}>{t('home.legendInfo')}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── Source filter chips ── */}
        <View style={styles.filterRow}>
          {(['all', 'vik', 'vt', 'epro', 'heating'] as const).map(f => (
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
                {f === 'all' ? t('home.filterAll') : t(getCategoryLabelKey(f))}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Alert cards ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{t('home.alerts')}</Text>
            {activeAlerts.length > 0 && (
              <View style={styles.alertBadge}>
                <Text style={styles.alertBadgeText}>
                  {activeAlerts.length} {t('home.activeSuffix')}
                </Text>
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
                {t('home.tabRecent')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.feedTab, feedTab === 'active' && styles.feedTabActive]}
              onPress={() => setFeedTab('active')}>
              <Text style={[
                styles.feedTabText,
                feedTab === 'active' && styles.feedTabTextActive,
              ]}>
                {t('home.tabActive')}{activeAlerts.length > 0 ? ` (${activeAlerts.length})` : ''}
              </Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.loadingText}>{t('home.loadingAlerts')}</Text>
            </View>
          ) : feedAlerts.length === 0 ? (
            <View style={styles.emptyWrap}>
              {/* Tinted disc behind the glyph — gives the empty state a focal
                  point instead of a bare icon floating in whitespace. */}
              <View style={[
                styles.emptyIconDisc,
                {backgroundColor: fetchFailed ? colors.card : colors.successSoft},
              ]}>
                <Icon
                  name={fetchFailed ? 'refresh' : 'check'}
                  size={28}
                  color={fetchFailed ? colors.textSecondary : colors.success}
                />
              </View>
              <Text style={styles.emptyTitle}>
                {fetchFailed ? t('home.loadFailedTitle') : t('home.allClear')}
              </Text>
              <Text style={styles.emptySub}>
                {fetchFailed
                  ? t('home.loadFailedSub')
                  : feedTab === 'active'
                    ? t('home.emptyActiveSub')
                    : t('home.emptyRecentSub')}
              </Text>
              {/* The failure state previously showed a refresh *icon* with no
                  way to act on it — pull-to-refresh was the only recovery. */}
              {fetchFailed && (
                <TouchableOpacity
                  style={styles.emptyRetryBtn}
                  onPress={onRefresh}
                  activeOpacity={0.85}>
                  <Icon name="refresh" size={15} color={colors.primary} />
                  <Text style={styles.emptyRetryText}>{t('common.retry')}</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <>
              <Text style={styles.sectionSubtitle}>{t('home.tapCard')}</Text>
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
                          {getAlertTitle(alert, t)}
                        </Text>
                        <Text style={styles.alertTime}>
                          {timeAgo(alert.created_at, t)}
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
                    {formatTime(alert, t) ? (
                      <View style={styles.alertTimeRow}>
                        <Icon name="clock" size={12} color={colors.accent} />
                        <Text style={styles.alertTimeWindow}>{formatTime(alert, t)}</Text>
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
            <Text style={styles.infoCardTitle}>{t('home.howItWorks')}</Text>
            <Text style={styles.infoCardText}>{t('home.howItWorksText')}</Text>
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
            style={[
              styles.sheet,
              // Modals sit outside the screen's SafeAreaView, so the sheet has
              // to clear the gesture bar itself.
              {paddingBottom: spacing.xl + insets.bottom},
              {transform: [{translateY: sheetTranslate}]},
            ]}
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
                      {t(getCategoryLabelKey(selectedAlert.source))}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={closeSheet} style={styles.closeBtn}>
                    <Icon name="x" size={15} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.sheetTitle}>{getAlertTitle(selectedAlert, t)}</Text>
                <Text style={styles.sheetBody}>{getAlertBody(selectedAlert)}</Text>

                {/* Meta row */}
                <View style={styles.sheetMeta}>
                  {formatTime(selectedAlert, t) ? (
                    <View style={styles.sheetMetaChip}>
                      <Icon name="clock" size={12} color={colors.textSecondary} />
                      <Text style={styles.sheetMetaText}>{formatTime(selectedAlert, t)}</Text>
                    </View>
                  ) : null}
                  <View style={styles.sheetMetaChip}>
                    <Text style={styles.sheetMetaText}>{timeAgo(selectedAlert.created_at, t)}</Text>
                  </View>
                  <View style={[styles.sheetMetaChip, {backgroundColor: SEVERITY_BG[selectedAlert.severity]}]}>
                    <Text style={[styles.sheetMetaText, {color: SEVERITY_COLOR[selectedAlert.severity]}]}>
                      {severityLabel(selectedAlert.severity, t)}
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
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.background},
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
  emptyIconDisc: {
    width: 56, height: 56, borderRadius: radius.full,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: {color: colors.textPrimary, fontSize: font.sizes.lg, fontWeight: font.weights.semibold, marginTop: spacing.xs},
  emptySub: {
    color: colors.textMuted, fontSize: font.sizes.sm,
    textAlign: 'center', lineHeight: font.lineHeights.sm,
    maxWidth: 280,
  },
  emptyRetryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    marginTop: spacing.md,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
    borderRadius: radius.full,
    borderWidth: 1.5, borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  emptyRetryText: {
    color: colors.primary, fontSize: font.sizes.sm,
    fontWeight: font.weights.semibold,
  },

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
    ...elevation.md,
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
    ...elevation.sm,
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
  alertMessage: {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: font.lineHeights.sm},
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
  infoCardText:  {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: font.lineHeights.sm},

  // Bottom sheet
  sheetBackdrop: {
    flex: 1, backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: spacing.xl, paddingTop: spacing.md,
    borderTopWidth: 1, borderColor: colors.border,
    maxHeight: SCREEN_HEIGHT * 0.65,
    ...elevation.lg,
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
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: font.sizes.xl, fontWeight: font.weights.bold,
    color: colors.textPrimary, marginBottom: spacing.sm,
  },
  sheetBody: {
    fontSize: font.sizes.md, color: colors.textSecondary,
    lineHeight: font.lineHeights.md, marginBottom: spacing.md,
  },
  sheetMeta: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md},
  sheetMetaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    backgroundColor: colors.background, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
  },
  sheetMetaText: {fontSize: font.sizes.xs, color: colors.textSecondary, fontWeight: font.weights.medium},
  sheetLocRow:   {marginBottom: spacing.sm},
  sheetLocTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  sheetLocName:  {fontSize: font.sizes.md, color: colors.textPrimary, fontWeight: font.weights.semibold},
  sheetSubLocs:  {fontSize: font.sizes.sm, color: colors.textSecondary, marginTop: 2, marginLeft: 20},
});
