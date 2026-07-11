// ─── App.tsx ──────────────────────────────────────────────────────────────────
import React, {useEffect} from 'react';
import {StyleSheet} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {ErrorBoundary} from './src/components/ErrorBoundary';
import {AuthProvider} from './src/context/AuthContext';
import AppNavigator from './src/navigation/AppNavigator';
import {
  registerForegroundHandler,
  handleInitialNotification,
} from './src/services/fcm';

export default function App() {
  useEffect(() => {
    // Show an Alert for messages received while the app is open
    const unsubscribeForeground = registerForegroundHandler();

    // Persist the notification that opened the app (cold start), if any
    handleInitialNotification();

    return () => {
      unsubscribeForeground();
    };
  }, []);

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider>
          <AuthProvider>
            <AppNavigator />
          </AuthProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
});
