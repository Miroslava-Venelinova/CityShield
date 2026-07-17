// ─── src/screens/ProfileScreen.tsx ────────────────────────────────────────────
import React, {useState, useEffect} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, Alert, Switch, Platform, PermissionsAndroid,
  ActivityIndicator, Modal, Linking,
} from 'react-native';
import {useAuth} from '../context/AuthContext';
import {tokensApi, authApi} from '../services/api';
import {PRIVACY_POLICY_URL} from '../config';
import {getFCMToken, registerTokenRefreshHandler} from '../services/fcm';
import {colors, spacing, radius, font} from '../theme';
import Icon, {IconName} from '../components/icons';
import LocationPickerMap from '../components/LocationPickerMap';

// ── TODO: for real GPS, install react-native-geolocation-service:
//   npm install react-native-geolocation-service
//   Then import Geolocation from 'react-native-geolocation-service'
//   and add ACCESS_FINE_LOCATION to AndroidManifest.xml

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

// ── Request POST_NOTIFICATIONS (Android 13+) ───────────────────────────────────
async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if ((Platform.Version as number) < 33) return true;
  const already = await PermissionsAndroid.check(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  if (already) return true;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    {title: 'CityShield Notifications',
     message: 'CityShield needs permission to send you real-time alerts.',
     buttonPositive: 'Allow', buttonNegative: 'Deny'});
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const {token, hasLocation, regionName, streetName, setHasLocation, logout, refreshProfile} = useAuth();

  const [alertsEnabled,    setAlertsEnabled]    = useState(false);
  const [fcmToken,         setFcmToken]          = useState<string | null>(null);
  const [fcmLoading,       setFcmLoading]        = useState(false);
  const [deviceRegistered, setDeviceRegistered]  = useState(false);
  const [locationLoading,  setLocationLoading]   = useState(false);
  const [coordModalVisible, setCoordModalVisible] = useState(false);
  const [pickedCoords, setPickedCoords] =
    useState<{lat: number; lon: number} | null>(null);

  const payload = token ? decodeJwt(token) : {};
  const email   = payload[EMAIL_CLAIM] ?? payload['email'] ?? 'Unknown';

  const permissionSubtext = alertsEnabled
    ? 'Push notifications are enabled'
    : 'Tap to enable notifications';

  const fcmDisplay = fcmToken
    ? fcmToken.slice(0, 14) + '…' + fcmToken.slice(-6)
    : '—';

  // ── Mount ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      if (Platform.OS !== 'android' || (Platform.Version as number) < 33) {
        setAlertsEnabled(true);
      } else {
        const granted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        setAlertsEnabled(granted);
      }
      await refreshFcmToken();
    })();

    const unsubRefresh = registerTokenRefreshHandler(async newToken => {
      setFcmToken(newToken);
      if (token) {
        try {
          await tokensApi.register(
            {token: newToken, platform: Platform.OS,
             deviceName: `${Platform.OS} Device`}, token);
        } catch { /* best-effort */ }
      }
    });

    return () => { unsubRefresh(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshFcmToken = async () => {
    setFcmLoading(true);
    try {
      const t = await getFCMToken();
      setFcmToken(t);
    } catch {
      setFcmToken(null);
    } finally {
      setFcmLoading(false);
    }
  };

  const handleAlertsToggle = async (value: boolean) => {
    if (value) {
      const granted = await requestNotificationPermission();
      setAlertsEnabled(granted);
      if (!granted) {
        Alert.alert('Permission denied',
          'Enable notifications in device Settings to receive alerts.');
      }
    } else {
      setAlertsEnabled(false);
    }
  };

  const handleRegisterDevice = async () => {
    if (!fcmToken || !token) return;
    setFcmLoading(true);
    try {
      await tokensApi.register(
        {token: fcmToken, platform: Platform.OS,
         deviceName: `${Platform.OS} Device`}, token);
      setDeviceRegistered(true);
      Alert.alert('Device registered',
        'This device will now receive CityShield push notifications.');
    } catch (err: any) {
      Alert.alert('Registration Failed', err.message);
    } finally {
      setFcmLoading(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Sign Out', style: 'destructive',
       onPress: () => logout(fcmToken ?? undefined)},
    ]);
  };

  const handleOpenPrivacyPolicy = () => {
    Linking.openURL(PRIVACY_POLICY_URL).catch(() =>
      Alert.alert('Could not open link', PRIVACY_POLICY_URL));
  };

  // GDPR Art. 17 / Google Play account deletion: permanently removes the
  // account server-side (tokens, preferences, subscriptions cascade), then
  // clears local state, which returns the app to the login screen.
  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This permanently deletes your account, saved location, and ' +
      'notification settings. This cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete Forever', style: 'destructive', onPress: async () => {
          try {
            await authApi.deleteAccount(token!);
            // Server data is gone; skip token unregistration and just clear
            // local state — this navigates back to the login screen.
            await logout();
            Alert.alert('Account deleted',
              'Your account and all associated data have been removed.');
          } catch (err: any) {
            Alert.alert('Deletion Failed', err.message);
          }
        }},
      ],
    );
  };

  // ── Open the map picker modal ─────────────────────────────────────────────
  const handleSetLocation = () => {
    setPickedCoords(null);
    setCoordModalVisible(true);
  };

  // ── Submit the picked pin to the backend ─────────────────────────────────
  const handleSubmitCoords = async () => {
    if (!pickedCoords) {
      Alert.alert('No pin placed', 'Tap the map to place a pin on your location.');
      return;
    }
    const {lat, lon} = pickedCoords;

    setLocationLoading(true);
    setCoordModalVisible(false);
    try {
      await authApi.updateLocation({latitude: lat, longitude: lon}, token!);
      setHasLocation(true);
      await refreshProfile();
      Alert.alert('Location updated',
        'Your area has been set. You will now receive local alerts.');
    } catch (err: any) {
      Alert.alert('Update Failed', err.message);
    } finally {
      setLocationLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.dark} />
      <ScrollView contentContainerStyle={styles.scroll}>

        {/* ── No-location banner ── */}
        {hasLocation === false && (
          <View style={styles.locationBanner}>
            <Icon name="map-pin" size={22} color={colors.warning} />
            <View style={styles.bannerText}>
              <Text style={styles.bannerTitle}>Location not set</Text>
              <Text style={styles.bannerSub}>
                Set your location to start receiving alerts for your area.
              </Text>
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
            <Text style={styles.activeText}>Active Member</Text>
          </View>
        </View>

        {/* ── Location ── */}
        <Section title="Location">
          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleSetLocation}
            disabled={locationLoading}
            activeOpacity={0.7}>
            <RowIcon name="map-pin" />
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>
                {hasLocation ? 'Update My Location' : 'Set My Location'}
              </Text>
              <Text style={styles.actionSub}>
                {hasLocation
                  ? 'Coordinates are matched to your area via Nominatim'
                  : 'Required to receive neighbourhood alerts'}
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
              <Text style={styles.infoLabel}>Location Status</Text>
              <Text style={[styles.infoValue,
                {color: hasLocation ? colors.success : colors.danger}]}>
                {hasLocation === null ? 'Loading…'
                  : hasLocation ? 'Location set'
                  : 'Not set — no alerts will be sent'}
              </Text>
            </View>
          </View>
          {hasLocation && (
            <>
              <Divider />
              <View style={styles.infoRow}>
                <RowIcon name="home" />
                <View style={styles.infoTextGroup}>
                  <Text style={styles.infoLabel}>Neighbourhood / Region</Text>
                  <Text style={styles.infoValue}>
                    {regionName ?? '—'}
                  </Text>
                </View>
              </View>
              <Divider />
              <View style={styles.infoRow}>
                <RowIcon name="navigation" />
                <View style={styles.infoTextGroup}>
                  <Text style={styles.infoLabel}>Street</Text>
                  <Text style={styles.infoValue}>
                    {streetName ?? 'No street match found'}
                  </Text>
                </View>
              </View>
            </>
          )}
        </Section>

        {/* ── Notifications ── */}
        <Section title="Notifications">
          <SwitchRow
            icon="bell"
            label="Push Alerts"
            sub={permissionSubtext}
            value={alertsEnabled}
            onChange={handleAlertsToggle}
          />
        </Section>

        {/* ── Device ── */}
        <Section title="Device">
          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleRegisterDevice}
            activeOpacity={0.7}
            disabled={deviceRegistered || fcmLoading}>
            <RowIcon name="smartphone" />
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>
                {deviceRegistered ? 'Device Registered' : 'Register This Device'}
              </Text>
              <Text style={styles.actionSub}>
                {deviceRegistered
                  ? 'Push notifications are enabled'
                  : 'Send your FCM token to the backend'}
              </Text>
            </View>
            {fcmLoading
              ? <ActivityIndicator size="small" color={colors.primaryLight} />
              : deviceRegistered
                ? <Icon name="check" size={18} color={colors.success} />
                : <Icon name="chevron-right" size={18} color={colors.textMuted} />}
          </TouchableOpacity>
          <Divider />
          <View style={styles.infoRow}>
            <RowIcon name="key" />
            <View style={styles.infoTextGroup}>
              <Text style={styles.infoLabel}>FCM Token</Text>
              <Text style={styles.infoValue} numberOfLines={1}>{fcmDisplay}</Text>
            </View>
          </View>
        </Section>

        {/* ── Account & About ── */}
        <Section title="About">
          <Row icon="mail" label="Email" value={email} />
          <Divider />
          <Row icon="shield" label="CityShield" value="v1.0.0" />
          <Divider />
          <Row icon="map" label="Map data" value="© OpenStreetMap" />
          <Divider />
          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleOpenPrivacyPolicy}
            activeOpacity={0.7}>
            <RowIcon name="shield" />
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>Privacy Policy</Text>
              <Text style={styles.actionSub}>
                How your data is used, stored, and deleted
              </Text>
            </View>
            <Icon name="chevron-right" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </Section>

        {/* ── Logout ── */}
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={handleLogout}
          activeOpacity={0.85}>
          <Icon name="log-out" size={18} color={colors.danger} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* ── Delete account (GDPR / Play requirement) ── */}
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={handleDeleteAccount}
          activeOpacity={0.85}>
          <Text style={styles.deleteText}>Delete Account</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>CityShield · Protecting Your Community</Text>
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
              <Text style={styles.modalTitle}>Set Location</Text>
            </View>
            <Text style={styles.modalSub}>
              Tap the map to place a pin on your location. Nominatim will
              detect your region and street.
            </Text>

            <View style={styles.mapWrap}>
              <LocationPickerMap
                style={styles.map}
                onPick={(lat, lng) => setPickedCoords({lat, lon: lng})}
              />
            </View>

            <Text style={styles.coordHint}>
              {pickedCoords
                ? `Pin: ${pickedCoords.lat.toFixed(5)}, ${pickedCoords.lon.toFixed(5)}`
                : 'No pin placed yet — tap the map'}
            </Text>

            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setCoordModalVisible(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirmBtn, !pickedCoords && styles.modalConfirmDisabled]}
                onPress={handleSubmitCoords}
                disabled={!pickedCoords}>
                <Text style={styles.modalConfirmText}>Set Location</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
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
  container:     {flex: 1, backgroundColor: colors.navy},
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

  profileHeader: {alignItems: 'center', paddingTop: spacing.xl, paddingBottom: spacing.xl, backgroundColor: colors.dark, borderBottomWidth: 1, borderBottomColor: colors.border},
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
  deleteBtn:     {alignItems: 'center', marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.sm},
  deleteText:    {color: colors.textMuted, fontSize: font.sizes.sm, textDecorationLine: 'underline'},
  footer:        {textAlign: 'center', color: colors.textMuted, fontSize: font.sizes.xs, marginTop: spacing.xl},

  // ── Map pin-picker modal ──
  modalOverlay:  {flex: 1, backgroundColor: 'rgba(13,33,69,0.5)', justifyContent: 'center', alignItems: 'center', padding: spacing.lg},
  modalCard:     {backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.xl, width: '100%', borderWidth: 1, borderColor: colors.border, gap: spacing.md},
  modalTitleRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  modalTitle:    {color: colors.textPrimary, fontSize: font.sizes.xl, fontWeight: font.weights.bold},
  modalSub:      {color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: 20},
  mapWrap:       {height: 320, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border},
  map:           {flex: 1},
  coordHint:     {backgroundColor: `${colors.primary}15`, borderRadius: radius.md, padding: spacing.sm, color: colors.textMuted, fontSize: font.sizes.xs, borderLeftWidth: 3, borderLeftColor: colors.primary},
  modalBtns:     {flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs},
  modalCancelBtn:{flex: 1, height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center'},
  modalCancelText:{color: colors.textSecondary, fontSize: font.sizes.md},
  modalConfirmBtn:{flex: 2, height: 48, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'},
  modalConfirmDisabled:{opacity: 0.5},
  modalConfirmText:{color: colors.white, fontSize: font.sizes.md, fontWeight: font.weights.semibold},
});
