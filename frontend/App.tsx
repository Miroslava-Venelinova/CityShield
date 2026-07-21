// ─── App.tsx ──────────────────────────────────────────────────────────────────
import React, {useEffect} from 'react';
import {AppState, StyleSheet} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {ErrorBoundary} from './src/components/ErrorBoundary';
import {AuthProvider, useAuth} from './src/context/AuthContext';
import {LanguageProvider} from './src/context/LanguageContext';
import {ThemeProvider} from './src/context/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import {registerNotificationHandlers} from './src/services/push';
import {syncFromRecentAlerts} from './src/services/notifications';

/**
 * Keeps the stored notification list in step with the server feed. Renders
 * nothing; lives inside AuthProvider because it needs the access token.
 *
 * A push is only a cue to re-sync — its payload is never persisted directly,
 * since OneSignal has no headless Android hook for notifications that arrive
 * while the app is killed. Coming back to the foreground re-syncs for exactly
 * that case.
 */
function PushSync() {
  const {token} = useAuth();

  useEffect(() => {
    if (!token) return;

    const sync = () => { syncFromRecentAlerts(token); };
    sync();

    const unsubscribeNotifications = registerNotificationHandlers(sync);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') sync();
    });

    return () => {
      unsubscribeNotifications();
      subscription.remove();
    };
  }, [token]);

  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <ThemeProvider>
            <LanguageProvider>
              <AuthProvider>
                <PushSync />
                <AppNavigator />
              </AuthProvider>
            </LanguageProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
});
