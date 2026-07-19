// ─── src/screens/RegisterScreen.tsx ──────────────────────────────────────────
// Simplified: only email + password. Location is set after login via ProfileScreen.
import React, {useState} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView,
  Platform, StatusBar,
} from 'react-native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {authApi} from '../services/api';
import {colors, spacing, radius, font} from '../theme';
import {AuthStackParamList} from '../navigation/types';
import CityShieldLogo from '../components/CityShieldLogo';
import Icon from '../components/icons';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Register'>;
};

export default function RegisterScreen({navigation}: Props) {
  const [email,           setEmail]           = useState('');
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading,         setLoading]         = useState(false);
  const [showPassword,    setShowPassword]    = useState(false);

  const handleRegister = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Validation', 'Email and password are required.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Validation', 'Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Validation', 'Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      await authApi.register({email: email.trim(), password});
      Alert.alert(
        'Account created',
        'Sign in and then set your location to start receiving alerts.',
        [{text: 'Sign In', onPress: () => navigation.navigate('Login')}],
      );
    } catch (err: any) {
      Alert.alert('Registration Failed', err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.dark} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <Icon name="chevron-left" size={20} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <CityShieldLogo size={36} showWordmark={false} />
          </View>
          <View style={styles.headerTitleGroup}>
            <Text style={styles.headerTitle}>Create Account</Text>
            <Text style={styles.headerSubtitle}>Join your city's protection network</Text>
          </View>
        </View>

        {/* Progress */}
        <View style={styles.progressRow}>
          <View style={[styles.progressStep, styles.progressActive]}>
            <Text style={styles.progressNum}>1</Text>
          </View>
          <View style={styles.progressLine} />
          <View style={styles.progressStep}>
            <Text style={styles.progressNumInactive}>2</Text>
          </View>
        </View>
        <Text style={styles.progressLabel}>Account Details · Set Location</Text>

        {/* Form Card */}
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionDot} />
            <Text style={styles.sectionTitle}>Account Details</Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Email Address *</Text>
            <View style={styles.inputWrapper}>
              <View style={styles.inputIcon}>
                <Icon name="mail" size={15} color={colors.textMuted} />
              </View>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password * (min. 8 characters)</Text>
            <View style={styles.inputWrapper}>
              <View style={styles.inputIcon}>
                <Icon name="lock" size={15} color={colors.textMuted} />
              </View>
              <TextInput
                style={[styles.input, {flex: 1}]}
                placeholder="Create a strong password"
                placeholderTextColor={colors.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={styles.eyeBtn}>
                <Icon
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={17}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Confirm Password *</Text>
            <View style={[
              styles.inputWrapper,
              passwordsMatch   ? styles.inputValid   : null,
              passwordsMismatch ? styles.inputInvalid : null,
            ]}>
              <View style={styles.inputIcon}>
                <Icon name="lock" size={15} color={colors.textMuted} />
              </View>
              <TextInput
                style={styles.input}
                placeholder="Re-enter your password"
                placeholderTextColor={colors.textMuted}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry={!showPassword}
              />
              {confirmPassword.length > 0 && (
                <Icon
                  name={passwordsMatch ? 'check' : 'x'}
                  size={17}
                  color={passwordsMatch ? colors.success : colors.danger}
                />
              )}
            </View>
          </View>

          {/* Location hint */}
          <View style={styles.infoBox}>
            <View style={styles.infoBoxIcon}>
              <Icon name="map-pin" size={16} color={colors.accent} />
            </View>
            <Text style={styles.infoText}>
              After creating your account, you'll be prompted to set your location.
              This lets CityShield send you alerts relevant to your area.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={handleRegister}
            disabled={loading}
            activeOpacity={0.85}>
            {loading
              ? <ActivityIndicator color={colors.white} />
              : <Text style={styles.primaryBtnText}>Create Account →</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkBtn} onPress={() => navigation.navigate('Login')}>
            <Text style={styles.linkBtnText}>
              Already have an account?{' '}
              <Text style={styles.linkBtnHighlight}>Sign In</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex:   {flex: 1, backgroundColor: colors.dark},
  scroll: {flexGrow: 1, padding: spacing.lg, paddingTop: spacing.xl},

  header:          {flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl},
  backBtn:         {width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginRight: spacing.md},
  headerCenter:    {marginRight: spacing.md},
  headerTitleGroup:{flex: 1},
  headerTitle:     {fontSize: font.sizes.xxl, fontWeight: font.weights.bold, color: colors.textPrimary},
  headerSubtitle:  {fontSize: font.sizes.sm, color: colors.textSecondary, marginTop: 2},

  progressRow:        {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs},
  progressStep:       {width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center'},
  progressActive:     {backgroundColor: colors.primary, borderColor: colors.primaryLight},
  progressLine:       {width: 64, height: 2, backgroundColor: colors.border, marginHorizontal: spacing.xs},
  progressNum:        {fontSize: font.sizes.sm, fontWeight: font.weights.bold, color: colors.white},
  progressNumInactive:{fontSize: font.sizes.sm, color: colors.textMuted},
  progressLabel:      {textAlign: 'center', color: colors.textMuted, fontSize: font.sizes.xs, marginBottom: spacing.lg},

  card: {backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.xl, borderWidth: 1, borderColor: colors.border, shadowColor: colors.primary, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.08, shadowRadius: 16, elevation: 3},

  sectionHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md},
  sectionDot:    {width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent, marginRight: spacing.sm},
  sectionTitle:  {fontSize: font.sizes.sm, fontWeight: font.weights.semibold, color: colors.accent, textTransform: 'uppercase', letterSpacing: 1},

  inputGroup:   {marginBottom: spacing.md},
  label:        {fontSize: font.sizes.xs, fontWeight: font.weights.semibold, color: colors.textSecondary, marginBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 0.5},
  inputWrapper: {flexDirection: 'row', alignItems: 'center', backgroundColor: colors.dark, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: spacing.md},
  inputValid:   {borderColor: colors.success},
  inputInvalid: {borderColor: colors.danger},
  inputIcon:    {marginRight: spacing.sm},
  input:        {flex: 1, height: 50, color: colors.textPrimary, fontSize: font.sizes.md},
  eyeBtn:       {padding: spacing.xs},

  infoBox:     {flexDirection: 'row', backgroundColor: `${colors.accent}15`, borderRadius: radius.md, padding: spacing.md, borderLeftWidth: 3, borderLeftColor: colors.accent, marginBottom: spacing.md, marginTop: spacing.sm, gap: spacing.sm},
  infoBoxIcon: {marginTop: 1},
  infoText:    {flex: 1, color: colors.textSecondary, fontSize: font.sizes.sm, lineHeight: 20},

  primaryBtn:     {backgroundColor: colors.primary, borderRadius: radius.md, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md, shadowColor: colors.primary, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.3, shadowRadius: 10, elevation: 6},
  btnDisabled:    {opacity: 0.6},
  primaryBtnText: {color: colors.white, fontSize: font.sizes.lg, fontWeight: font.weights.bold},
  linkBtn:        {alignItems: 'center', marginTop: spacing.lg},
  linkBtnText:    {color: colors.textSecondary, fontSize: font.sizes.sm},
  linkBtnHighlight:{color: colors.primary, fontWeight: font.weights.semibold},
});
