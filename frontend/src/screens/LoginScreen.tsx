// ─── src/screens/LoginScreen.tsx ─────────────────────────────────────────────
import React, {useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
} from 'react-native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {authApi} from '../services/api';
import {errorMessageKey} from '../services/errors';
import {useAuth} from '../context/AuthContext';
import {useI18n} from '../context/LanguageContext';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {colors, spacing, radius, font, elevation} from '../theme';
import {AuthStackParamList} from '../navigation/types';
import CityShieldLogo from '../components/CityShieldLogo';
import Icon from '../components/icons';

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
};

export default function LoginScreen({navigation}: Props) {
  const {login} = useAuth();
  const {t} = useI18n();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert(t('register.validationTitle'), t('login.errRequired'));
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.login({email: email.trim(), password});
      await login(res.token);
    } catch (err: unknown) {
      // On this screen a 401 means bad credentials, not an expired session.
      Alert.alert(t('login.failedTitle'), t(errorMessageKey(err, 'login.failedMsg')));
    } finally {
      setLoading(false);
    }
  };

  // Reuses whatever is already typed in the email field — asking for it twice
  // on a screen that has the box right there would be busywork.
  const handleForgotPassword = () => {
    const address = email.trim();
    if (!address) {
      Alert.alert(t('login.forgotTitle'), t('login.forgotNeedEmail'));
      return;
    }
    Alert.alert(t('login.forgotTitle'), t('login.forgotConfirm').replace('{email}', address), [
      {text: t('common.cancel'), style: 'cancel'},
      {
        text: t('login.forgotSend'),
        onPress: async () => {
          setResetting(true);
          try {
            await authApi.forgotPassword(address);
          } catch (err: unknown) {
            // Only transport/limiter failures can land here — the endpoint
            // answers 204 even for addresses that do not exist.
            Alert.alert(t('common.error'), t(errorMessageKey(err)));
            return;
          } finally {
            setResetting(false);
          }
          // Same wording regardless of whether an account existed, so this
          // screen cannot be used to find out which addresses are registered.
          Alert.alert(t('login.forgotSentTitle'), t('login.forgotSentMsg'));
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      // Auth screens render outside the tab navigator and the app draws
      // edge-to-edge, so both the status bar and the gesture bar overlap the
      // scroll content unless we inset it here.
      style={[styles.flex, {paddingTop: insets.top, paddingBottom: insets.bottom}]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="dark-content" translucent />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">

        {/* Logo */}
        <View style={styles.logoSection}>
          <CityShieldLogo size={80} showWordmark={true} />
          <Text style={styles.tagline}>{t('login.tagline')}</Text>
        </View>

        {/* Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('login.welcome')}</Text>
          <Text style={styles.cardSubtitle}>{t('login.subtitle')}</Text>

          {/* Email */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('login.emailLabel')}</Text>
            <View style={styles.inputWrapper}>
              <View style={styles.inputIcon}>
                <Icon name="mail" size={16} color={colors.textMuted} />
              </View>
              <TextInput
                style={styles.input}
                placeholder={t('register.emailPlaceholder')}
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          {/* Password */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('login.passwordLabel')}</Text>
            <View style={styles.inputWrapper}>
              <View style={styles.inputIcon}>
                <Icon name="lock" size={16} color={colors.textMuted} />
              </View>
              <TextInput
                style={[styles.input, {flex: 1}]}
                placeholder={t('login.passwordPlaceholder')}
                placeholderTextColor={colors.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={styles.eyeBtn}>
                <Icon
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={18}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Login Button */}
          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}>
            {loading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryBtnText}>{t('login.signIn')}</Text>
            )}
          </TouchableOpacity>

          {/* Forgot password */}
          <TouchableOpacity
            style={styles.forgotBtn}
            onPress={handleForgotPassword}
            disabled={resetting}
            activeOpacity={0.7}>
            {resetting
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Text style={styles.forgotText}>{t('login.forgotLink')}</Text>}
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('login.or')}</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Register link */}
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => navigation.navigate('Register')}
            activeOpacity={0.85}>
            <Text style={styles.secondaryBtnText}>{t('login.createAccount')}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>{t('login.footer')}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: colors.background},
  scroll: {
    flexGrow: 1,
    padding: spacing.lg,
    justifyContent: 'center',
    paddingTop: spacing.xxl,
  },

  // Logo
  logoSection: {alignItems: 'center', marginBottom: spacing.xl},
  tagline: {
    fontSize: font.sizes.sm,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    letterSpacing: 0.5,
  },

  // Card
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.md,
  },
  cardTitle: {
    fontSize: font.sizes.xxl,
    fontWeight: font.weights.bold,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  cardSubtitle: {
    fontSize: font.sizes.md,
    color: colors.textSecondary,
    marginBottom: spacing.xl,
  },

  // Inputs
  inputGroup: {marginBottom: spacing.md},
  label: {
    fontSize: font.sizes.sm,
    fontWeight: font.weights.semibold,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  inputIcon: {marginRight: spacing.sm},
  input: {
    flex: 1,
    height: 50,
    color: colors.textPrimary,
    fontSize: font.sizes.md,
  },
  eyeBtn: {padding: spacing.xs},

  // Buttons
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    ...elevation.accent,
  },
  btnDisabled: {opacity: 0.6},
  primaryBtnText: {
    color: colors.white,
    fontSize: font.sizes.lg,
    fontWeight: font.weights.bold,
    letterSpacing: 0.5,
  },
  secondaryBtn: {
    borderRadius: radius.md,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}0D`,
  },
  secondaryBtnText: {
    color: colors.primary,
    fontSize: font.sizes.md,
    fontWeight: font.weights.semibold,
  },

  forgotBtn: {alignSelf: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.sm},
  forgotText: {
    color: colors.primary,
    fontSize: font.sizes.sm,
    fontWeight: font.weights.medium,
  },

  // Divider
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.lg,
  },
  dividerLine: {flex: 1, height: 1, backgroundColor: colors.border},
  dividerText: {
    color: colors.textMuted,
    fontSize: font.sizes.sm,
    marginHorizontal: spacing.md,
  },

  footer: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: font.sizes.xs,
    marginTop: spacing.xl,
  },
});
