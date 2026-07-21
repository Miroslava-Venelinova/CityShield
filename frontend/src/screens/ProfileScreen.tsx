// ─── src/screens/ProfileScreen.tsx ────────────────────────────────────────────
import React, {useState, useEffect} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, Alert, Switch,
  ActivityIndicator, Modal, Linking, Share,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useAuth} from '../context/AuthContext';
import {useI18n} from '../context/LanguageContext';
import {authApi} from '../services/api';
import {API_BASE_URL} from '../config';
import {errorMessageKey} from '../services/errors';
import {hasPushPermission, requestPushPermission} from '../services/push';
import {colors, spacing, radius, font} from '../theme';
import Icon, {IconName} from '../components/icons';
import LocationPickerMap from '../components/LocationPickerMap';

// ── TODO: for real GPS, install react-native-geolocation-service:
//   npm install react-native-geolocation-service
//   Then import Geolocation from 'react-native-geolocation-service'
//   and add ACCESS_FINE_LOCATION to AndroidManifest.xml

// The policy is served by the Worker itself (PLAN.MD §1.10), so it always
// matches the API the app is pointed at — dev, staging or production.
const PRIVACY_POLICY_URL = `${API_BASE_URL}/privacy`;
const OSM_PRIVACY_URL = 'https://osmfoundation.org/wiki/Privacy_Policy';

// ── JWT decode ────────────────────────────────────────────────────────────────
const EMAIL_CLAIM =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';

// Hermes has no global atob, so decode base64 manually
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Decode(input: string): string {
  const str = input.replace(/=+$/, '');
  let output = '';
  for (let bc = 0, bs = 0, i = 0; i < str.length; i++) {
    const idx = B64.indexOf(str.charAt(i));
    if (idx === -1) { continue; }
    bs = bc % 4 ? bs * 64 + idx : idx;
    if (bc++ % 4) { output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))); }
  }
  return output;
}

function decodeJwt(token: string): Record<string, string> {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded  = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(base64Decode(padded));
  } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const {token, hasLocation, regionName, streetName, emailVerified,
         setHasLocation, logout, refreshProfile} = useAuth();
  const {language, setLanguage, t} = useI18n();

  const [alertsEnabled,    setAlertsEnabled]    = useState(false);
  const [locationLoading,  setLocationLoading]   = useState(false);
  const [coordModalVisible, setCoordModalVisible] = useState(false);
  const [pickedCoords, setPickedCoords] =
    useState<{lat: number; lon: number} | null>(null);
  // One flag for the whole privacy section: export, clear-location and delete
  // all hit the same account and must not run concurrently.
  const [privacyBusy, setPrivacyBusy] = useState<
    'export' | 'clear' | 'delete' | null>(null);
  const [resendBusy, setResendBusy] = useState(false);

  const payload = token ? decodeJwt(token) : {};
  const email   = payload[EMAIL_CLAIM] ?? payload['email'] ?? 'Unknown';

  const permissionSubtext = alertsEnabled
    ? t('profile.pushEnabled')
    : t('profile.pushTapToEnable');

  // ── Mount ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setAlertsEnabled(hasPushPermission());
      // Picks up a verification that happened in the browser since last load.
      await refreshProfile();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAlertsToggle = async (value: boolean) => {
    if (value) {
      // OneSignal drives the Android 13+ POST_NOTIFICATIONS prompt so its SDK
      // stays in step with the OS permission — there is no separate device
      // registration step anymore, the subscription is created for us.
      const granted = await requestPushPermission();
      setAlertsEnabled(granted);
      if (!granted) {
        Alert.alert(t('profile.permDeniedTitle'), t('profile.permDeniedMsg'));
      }
    } else {
      setAlertsEnabled(false);
    }
  };

  const handleLogout = () => {
    Alert.alert(t('profile.signOut'), t('profile.signOutConfirm'), [
      {text: t('common.cancel'), style: 'cancel'},
      {text: t('profile.signOut'), style: 'destructive',
       onPress: () => logout()},
    ]);
  };

  const handleResendVerification = async () => {
    if (!token || resendBusy) return;
    setResendBusy(true);
    try {
      await authApi.resendVerification(token);
      Alert.alert(t('profile.verifySentTitle'), t('profile.verifySentMsg'));
    } catch (err: unknown) {
      Alert.alert(t('common.error'), t(errorMessageKey(err)));
    } finally {
      setResendBusy(false);
    }
  };

  // ── GDPR actions (PLAN.MD §1.10 / §2.3) ───────────────────────────────────

  const handleOpenPrivacyPolicy = async () => {
    try {
      await Linking.openURL(PRIVACY_POLICY_URL);
    } catch {
      Alert.alert(t('common.error'), t('profile.privacyPolicyFailed'));
    }
  };

  // Art. 20 portability. The export is small (one profile + a handful of
  // preferences and devices), so handing it to the share sheet as text lets
  // the user route it anywhere without a filesystem dependency.
  const handleExportData = async () => {
    if (!token || privacyBusy) return;
    setPrivacyBusy('export');
    try {
      const data = await authApi.exportData(token);
      await Share.share({
        title: t('profile.exportTitle'),
        message: JSON.stringify(data, null, 2),
      });
    } catch (err: unknown) {
      Alert.alert(t('profile.exportFailed'), t(errorMessageKey(err)));
    } finally {
      setPrivacyBusy(null);
    }
  };

  // Withdrawing location consent (Art. 7(3)) must be as easy as giving it,
  // hence a single confirm rather than the two-step the deletion flow uses.
  const handleClearLocation = () => {
    Alert.alert(t('profile.clearLocation'), t('profile.clearLocationConfirm'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('profile.clearLocation'),
        style: 'destructive',
        onPress: async () => {
          if (!token) return;
          setPrivacyBusy('clear');
          try {
            await authApi.clearLocation(token);
            setHasLocation(false);
            await refreshProfile();
            Alert.alert(t('profile.clearLocationDone'),
              t('profile.clearLocationDoneMsg'));
          } catch (err: unknown) {
            Alert.alert(t('profile.clearLocationFailed'), t(errorMessageKey(err)));
          } finally {
            setPrivacyBusy(null);
          }
        },
      },
    ]);
  };

  // Art. 17 erasure — also a Google Play requirement for accounts created
  // in-app. Two confirmations because it is immediate and irreversible.
  const handleDeleteAccount = () => {
    Alert.alert(t('profile.deleteAccount'), t('profile.deleteConfirm1'), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('profile.deleteContinue'),
        style: 'destructive',
        onPress: () =>
          Alert.alert(t('profile.deleteConfirm2Title'), t('profile.deleteConfirm2'), [
            {text: t('common.cancel'), style: 'cancel'},
            {
              text: t('profile.deleteConfirmBtn'),
              style: 'destructive',
              onPress: async () => {
                if (!token) return;
                setPrivacyBusy('delete');
                try {
                  await authApi.deleteAccount(token);
                  Alert.alert(t('profile.deleteDone'), t('profile.deleteDoneMsg'));
                  // The account is gone, so the token can no longer unregister
                  // this device — logout() without one just clears local state.
                  await logout();
                } catch (err: unknown) {
                  Alert.alert(t('profile.deleteFailed'), t(errorMessageKey(err)));
                } finally {
                  setPrivacyBusy(null);
                }
              },
            },
          ]),
      },
    ]);
  };

  // ── Open the map picker modal ─────────────────────────────────────────────
  const handleSetLocation = () => {
    setPickedCoords(null);
    setCoordModalVisible(true);
  };

  // ── Submit the picked pin to the backend ─────────────────────────────────
  const handleSubmitCoords = async () => {
    if (!pickedCoords) {
      Alert.alert(t('profile.noPinTitle'), t('profile.noPinMsg'));
      return;
    }
    const {lat, lon} = pickedCoords;

    setLocationLoading(true);
    setCoordModalVisible(false);
    try {
      await authApi.updateLocation({latitude: lat, longitude: lon}, token!);
      setHasLocation(true);
      await refreshProfile();
      Alert.alert(t('profile.locationUpdatedTitle'),
        t('profile.locationUpdatedMsg'));
    } catch (err: unknown) {
      // A 429 here is the per-user geocoding limiter, which protects our
      // Nominatim usage-policy commitment — the message tells users to wait.
      Alert.alert(t('profile.updateFailedTitle'), t(errorMessageKey(err)));
    } finally {
      setLocationLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="dark-content" translucent />
      <ScrollView contentContainerStyle={styles.scroll}>

        {/* ── No-location banner ── */}
        {hasLocation === false && (
          <View style={styles.locationBanner}>
            <Icon name="map-pin" size={22} color={colors.warning} />
            <View style={styles.bannerText}>
              <Text style={styles.bannerTitle}>{t('profile.bannerTitle')}</Text>
              <Text style={styles.bannerSub}>{t('profile.bannerSub')}</Text>
            </View>
          </View>
        )}

        {/* ── Profile header ── */}
        <View style={styles.profileHeader}>
          <View style={styles.avatarRing}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {email !== 'Unknown' ? email[0].toUpperCase() : '?'}
              </Text>
            </View>
          </View>
          <Text style={styles.emailText} numberOfLines={1}>{email}</Text>
          <View style={styles.activeBadge}>
            <View style={styles.activeDot} />
            <Text style={styles.activeText}>{t('profile.activeMember')}</Text>
          </View>
        </View>

        {/* ── Language ── */}
        <Section title={t('profile.sectionLanguage')}>
          <LanguageRow
            label={t('profile.languageBulgarian')}
            selected={language === 'bg'}
            onPress={() => setLanguage('bg')}
          />
          <Divider />
          <LanguageRow
            label={t('profile.languageEnglish')}
            selected={language === 'en'}
            onPress={() => setLanguage('en')}
          />
        </Section>

        {/* ── Location ── */}
        <Section title={t('profile.sectionLocation')}>
          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleSetLocation}
            disabled={locationLoading}
            activeOpacity={0.7}>
            <RowIcon name="map-pin" />
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>
                {hasLocation ? t('profile.updateLocation') : t('profile.setLocation')}
              </Text>
              <Text style={styles.actionSub}>
                {hasLocation
                  ? t('profile.locationSetSub')
                  : t('profile.locationUnsetSub')}
              </Text>
            </View>
            {locationLoading
              ? <ActivityIndicator size="small" color={colors.primaryLight} />
              : <Icon name="chevron-right" size={18} color={colors.textMuted} />}
          </TouchableOpacity>
          <Divider />
          <View style={styles.infoRow}>
            <RowIcon name="map" />
            <View style={styles.infoTextGroup}>
              <Text style={styles.infoLabel}>{t('profile.locationStatus')}</Text>
              <Text style={[styles.infoValue,
                {color: hasLocation ? colors.success : colors.danger}]}>
                {hasLocation === null ? t('common.loading')
                  : hasLocation ? t('profile.locationSet')
                  : t('profile.locationNotSet')}
              </Text>
            </View>
          </View>
          {hasLocation && (
            <>
              <Divider />
              <View style={styles.infoRow}>
                <RowIcon name="home" />
                <View style={styles.infoTextGroup}>
                  <Text style={styles.infoLabel}>{t('profile.region')}</Text>
                  <Text style={styles.infoValue}>
                    {regionName ?? '—'}
                  </Text>
                </View>
              </View>
              <Divider />
              <View style={styles.infoRow}>
                <RowIcon name="navigation" />
                <View style={styles.infoTextGroup}>
                  <Text style={styles.infoLabel}>{t('profile.street')}</Text>
                  <Text style={styles.infoValue}>
                    {streetName ?? t('profile.noStreet')}
                  </Text>
                </View>
              </View>
            </>
          )}
        </Section>

        {/* ── Notifications ── */}
        <Section title={t('profile.sectionNotifications')}>
          <SwitchRow
            icon="bell"
            label={t('profile.pushAlerts')}
            sub={permissionSubtext}
            value={alertsEnabled}
            onChange={handleAlertsToggle}
          />
        </Section>

        {/* ── Account & About ── */}
        <Section title={t('profile.sectionAbout')}>
          <Row icon="mail" label={t('profile.email')} value={email} />
          <Divider />
          {/* `null` means the profile fetch failed — say nothing rather than
              accusing a verified address of being unverified. */}
          {emailVerified === false ? (
            <>
              <ActionRow
                icon="check"
                label={t('profile.verifyPending')}
                sub={t('profile.verifyPendingSub')}
                loading={resendBusy}
                disabled={resendBusy}
                onPress={handleResendVerification}
              />
              <Divider />
            </>
          ) : emailVerified === true ? (
            <>
              <View style={styles.infoRow}>
                <RowIcon name="check" />
                <View style={styles.infoTextGroup}>
                  <Text style={styles.infoLabel}>{t('profile.emailStatus')}</Text>
                  <Text style={[styles.infoValue, {color: colors.success}]}>
                    {t('profile.emailVerified')}
                  </Text>
                </View>
              </View>
              <Divider />
            </>
          ) : null}
          <Row icon="shield" label="CityShield" value="v1.0.0" />
          <Divider />
          <Row icon="map" label={t('profile.mapData')} value="© OpenStreetMap" />
        </Section>

        {/* ── Privacy & data (GDPR, §1.10) ── */}
        <Section title={t('profile.sectionPrivacy')}>
          <ActionRow
            icon="shield"
            label={t('profile.privacyPolicy')}
            sub={t('profile.privacyPolicySub')}
            onPress={handleOpenPrivacyPolicy}
          />
          <Divider />
          <ActionRow
            icon="inbox"
            label={t('profile.exportData')}
            sub={t('profile.exportDataSub')}
            loading={privacyBusy === 'export'}
            disabled={privacyBusy !== null}
            onPress={handleExportData}
          />
          {hasLocation && (
            <>
              <Divider />
              <ActionRow
                icon="map-pin"
                label={t('profile.clearLocation')}
                sub={t('profile.clearLocationSub')}
                loading={privacyBusy === 'clear'}
                disabled={privacyBusy !== null}
                onPress={handleClearLocation}
              />
            </>
          )}
          <Divider />
          <ActionRow
            icon="trash"
            label={t('profile.deleteAccount')}
            sub={t('profile.deleteAccountSub')}
            loading={privacyBusy === 'delete'}
            disabled={privacyBusy !== null}
            danger
            onPress={handleDeleteAccount}
          />
        </Section>

        {/* ── Logout ── */}
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={handleLogout}
          activeOpacity={0.85}>
          <Icon name="log-out" size={18} color={colors.danger} />
          <Text style={styles.logoutText}>{t('profile.signOut')}</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>{t('profile.footer')}</Text>
        <View style={{height: spacing.xxl}} />
      </ScrollView>

      {/* ── Map pin-picker modal ── */}
      <Modal
        visible={coordModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCoordModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalTitleRow}>
              <Icon name="map-pin" size={20} color={colors.primary} />
              <Text style={styles.modalTitle}>{t('profile.modalTitle')}</Text>
            </View>
            <Text style={styles.modalSub}>{t('profile.modalSub')}</Text>

            <View style={styles.mapWrap}>
              <LocationPickerMap
                style={styles.map}
                onPick={(lat, lng) => setPickedCoords({lat, lon: lng})}
              />
            </View>

            <Text style={styles.coordHint}>
              {pickedCoords
                ? `${t('profile.modalPin')}: ${pickedCoords.lat.toFixed(5)}, ${pickedCoords.lon.toFixed(5)}`
                : t('profile.modalNoPin')}
            </Text>

            {/* Location is collected on consent (§2.1), and the coordinates
                leave for OSMF's Nominatim — both are disclosed here, before
                the user can confirm. */}
            <Text style={styles.consentText}>
              {t('profile.modalConsent')}{' '}
              <Text
                style={styles.consentLink}
                onPress={() => Linking.openURL(OSM_PRIVACY_URL).catch(() => {})}>
                {t('profile.modalConsentLink')}
              </Text>
            </Text>

            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setCoordModalVisible(false)}>
                <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirmBtn, !pickedCoords && styles.modalConfirmDisabled]}
                onPress={handleSubmitCoords}
                disabled={!pickedCoords}>
                <Text style={styles.modalConfirmText}>{t('profile.modalConfirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={sec.wrap}>
      <Text style={sec.title}>{title}</Text>
      <View style={sec.card}>{children}</View>
    </View>
  );
}

function LanguageRow({label, selected, onPress}: {
  label: string; selected: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={row.wrap} onPress={onPress} activeOpacity={0.7}>
      <RowIcon name="globe" />
      <Text style={row.label}>{label}</Text>
      {selected && <Icon name="check" size={18} color={colors.primary} />}
    </TouchableOpacity>
  );
}

/** Tappable row with a subtitle and a trailing chevron / spinner. */
function ActionRow({icon, label, sub, onPress, loading = false, disabled = false, danger = false}: {
  icon: IconName; label: string; sub: string; onPress: () => void;
  loading?: boolean; disabled?: boolean; danger?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionRow, disabled && !loading && {opacity: 0.5}]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}>
      <View style={row.iconWrap}>
        <Icon name={icon} size={17}
          color={danger ? colors.danger : colors.textSecondary} />
      </View>
      <View style={styles.actionText}>
        <Text style={[styles.actionLabel, danger && {color: colors.danger}]}>{label}</Text>
        <Text style={styles.actionSub}>{sub}</Text>
      </View>
      {loading
        ? <ActivityIndicator size="small" color={colors.primaryLight} />
        : <Icon name="chevron-right" size={18} color={colors.textMuted} />}
    </TouchableOpacity>
  );
}

function RowIcon({name}: {name: IconName}) {
  return (
    <View style={row.iconWrap}>
      <Icon name={name} size={17} color={colors.textSecondary} />
    </View>
  );
}

function Row({icon, label, value}: {icon: IconName; label: string; value: string}) {
  return (
    <View style={row.wrap}>
      <RowIcon name={icon} />
      <Text style={row.label}>{label}</Text>
      <Text style={row.value} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function SwitchRow({icon, label, sub, value, onChange}: {
  icon: IconName; label: string; sub: string;
  value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <View style={row.switchWrap}>
      <RowIcon name={icon} />
      <View style={row.switchText}>
        <Text style={row.label}>{label}</Text>
        <Text style={row.sub}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{false: colors.border, true: colors.primaryLight}}
        thumbColor={value ? colors.primary : colors.textMuted}
      />
    </View>
  );
}

function Divider() {
  return <View style={{height: 1, backgroundColor: colors.border, marginLeft: 44}} />;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const row = StyleSheet.create({
  wrap:       {flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.md},
  switchWrap: {flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.md, gap: spacing.sm},
  iconWrap:   {width: 28, alignItems: 'flex-start'},
  label:      {flex: 1, color: colors.textPrimary, fontSize: font.sizes.md},
  value:      {color: colors.textSecondary, fontSize: font.sizes.sm, maxWidth: 180},
  switchText: {flex: 1},
  sub:        {color: colors.textMuted, fontSize: font.sizes.xs, marginTop: 2},
});

const sec = StyleSheet.create({
  wrap:  {paddingHorizontal: spacing.lg, marginTop: spacing.lg},
  title: {color: colors.textMuted, fontSize: font.sizes.xs, fontWeight: font.weights.semibold, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: spacing.sm},
  card:  {backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden'},
});

const styles = StyleSheet.create({
  container:     {flex: 1, backgroundColor: colors.surface},
  scroll:        {flexGrow: 1},

  locationBanner:{
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: `${colors.warning}18`,
    borderBottomWidth: 1, borderBottomColor: `${colors.warning}44`,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md,
  },
  bannerText:    {flex: 1},
  bannerTitle:   {color: colors.textPrimary, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
  bannerSub:     {color: colors.textSecondary, fontSize: font.sizes.xs, marginTop: 2},

  profileHeader: {alignItems: 'center', paddingTop: spacing.xl, paddingBottom: spacing.xl, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border},
  avatarRing:    {width: 90, height: 90, borderRadius: 45, borderWidth: 2.5, borderColor: colors.primary, padding: 3, marginBottom: spacing.md},
  avatar:        {flex: 1, borderRadius: 42, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'},
  avatarText:    {fontSize: font.sizes.xxl, fontWeight: font.weights.bold, color: colors.white},
  emailText:     {color: colors.textPrimary, fontSize: font.sizes.lg, fontWeight: font.weights.semibold, marginBottom: spacing.xs, maxWidth: 280},
  activeBadge:   {flexDirection: 'row', alignItems: 'center', backgroundColor: `${colors.success}22`, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.full, borderWidth: 1, borderColor: `${colors.success}44`},
  activeDot:     {width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success, marginRight: spacing.xs},
  activeText:    {color: colors.success, fontSize: font.sizes.xs, fontWeight: font.weights.medium},
  actionRow:     {flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.md, gap: spacing.sm},
  actionText:    {flex: 1},
  actionLabel:   {color: colors.textPrimary, fontSize: font.sizes.md},
  actionSub:     {color: colors.textMuted, fontSize: font.sizes.xs, marginTop: 2},
  infoRow:       {flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.md, gap: spacing.sm},
  infoTextGroup: {flex: 1},
  infoLabel:     {color: colors.textSecondary, fontSize: font.sizes.xs},
  infoValue:     {color: colors.textPrimary, fontSize: font.sizes.md, fontWeight: font.weights.medium},
  logoutBtn:     {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: spacing.lg, marginTop: spacing.xl, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.danger, gap: spacing.sm, backgroundColor: `${colors.danger}11`},
  logoutText:    {color: colors.danger, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
  footer:        {textAlign: 'center', color: colors.textMuted, fontSize: font.sizes.xs, marginTop: spacing.xl},

  // ── Map pin-picker modal ──
  modalOverlay:  {flex: 1, backgroundColor: 'rgba(13,33,69,0.5)', justifyContent: 'center', alignItems: 'center', padding: spacing.lg},
  modalCard:     {backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.xl, width: '100%', borderWidth: 1, borderColor: colors.border, gap: spacing.md},
  modalTitleRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  modalTitle:    {color: colors.textPrimary, fontSize: font.sizes.xl, fontWeight: font.weights.bold},
  modalSub:      {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: font.lineHeights.sm},
  // 260 rather than 320: the consent block below it has to fit on small
  // phones without the card scrolling (the map swallows nested scrolls).
  mapWrap:       {height: 260, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border},
  map:           {flex: 1},
  consentText:   {color: colors.textMuted, fontSize: font.sizes.xs, lineHeight: font.lineHeights.sm},
  consentLink:   {color: colors.primary, textDecorationLine: 'underline'},
  coordHint:     {backgroundColor: `${colors.primary}15`, borderRadius: radius.md, padding: spacing.sm, color: colors.textMuted, fontSize: font.sizes.xs, borderLeftWidth: 3, borderLeftColor: colors.primary},
  modalBtns:     {flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs},
  modalCancelBtn:{flex: 1, height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center'},
  modalCancelText:{color: colors.textSecondary, fontSize: font.sizes.md},
  modalConfirmBtn:{flex: 2, height: 48, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'},
  modalConfirmDisabled:{opacity: 0.5},
  modalConfirmText:{color: colors.white, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
});
