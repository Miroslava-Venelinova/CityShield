// ─── src/components/ErrorBoundary.tsx ────────────────────────────────────────
// Catches any JS crash during render and shows the error on screen instead
// of a silent black screen. Remove this in production.
import React from 'react';
import {View, Text, ScrollView, StyleSheet} from 'react-native';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  {children: React.ReactNode},
  State
> {
  state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>App Crashed</Text>
          <Text style={styles.subtitle}>
            {this.state.error.message}
          </Text>
          <ScrollView style={styles.scroll}>
            <Text style={styles.stack}>
              {this.state.error.stack}
            </Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a0000',
    padding: 20,
    paddingTop: 60,
  },
  title: {
    color: '#ff4444',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  subtitle: {
    color: '#ffaaaa',
    fontSize: 15,
    marginBottom: 16,
  },
  scroll: {flex: 1},
  stack: {
    color: '#ff8888',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
});
