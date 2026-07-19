// ─── src/navigation/AppNavigator.tsx ─────────────────────────────────────────
import React from 'react';
import {View, Text, StyleSheet, ActivityIndicator} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';

import {useAuth} from '../context/AuthContext';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import HomeScreen from '../screens/HomeScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import CityShieldLogo from '../components/CityShieldLogo';
import Icon, {IconName} from '../components/icons';
import {colors, font, spacing} from '../theme';
import {AuthStackParamList, AppStackParamList, AppTabParamList} from './types';

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack  = createNativeStackNavigator<AppStackParamList>();
const Tab       = createBottomTabNavigator<AppTabParamList>();

// ─── Tab icon ─────────────────────────────────────────────────────────────────

function TabIcon({
  icon,
  label,
  focused,
}: {
  icon: IconName;
  label: string;
  focused: boolean;
}) {
  return (
    <View style={tab.wrapper}>
      <View style={[tab.pill, focused && tab.pillActive]}>
        <Icon
          name={icon}
          size={20}
          color={focused ? colors.primary : colors.textMuted}
          strokeWidth={focused ? 2.4 : 2}
        />
      </View>
      <Text style={[tab.label, focused && tab.labelActive]}>{label}</Text>
    </View>
  );
}

const tab = StyleSheet.create({
  wrapper: {alignItems: 'center', paddingTop: spacing.xs},
  pill: {
    width: 44,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {backgroundColor: `${colors.primary}1A`},
  label: {
    fontSize: font.sizes.xs,
    color: colors.textMuted,
    marginTop: 2,
    fontWeight: font.weights.medium,
    width: 64,
    textAlign: 'center',
  },
  labelActive: {color: colors.primary, fontWeight: font.weights.semibold},
});

// ─── Tab navigator (shown when logged in) ────────────────────────────────────

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 68,
          paddingBottom: 8,
        },
        tabBarShowLabel: false,
      }}>
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({focused}) => (
            <TabIcon icon="home" label="Home" focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{
          tabBarIcon: ({focused}) => (
            <TabIcon icon="bell" label="Alerts" focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({focused}) => (
            <TabIcon icon="user" label="Profile" focused={focused} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// ─── Authenticated app stack ──────────────────────────────────────────────────

function AuthenticatedApp() {
  return (
    <AppStack.Navigator screenOptions={{headerShown: false}}>
      <AppStack.Screen name="MainTabs" component={MainTabs} />
    </AppStack.Navigator>
  );
}

// ─── Unauthenticated stack ────────────────────────────────────────────────────

function UnauthenticatedApp() {
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: {backgroundColor: colors.navy},
      }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
    </AuthStack.Navigator>
  );
}

// ─── Root navigator ───────────────────────────────────────────────────────────

export default function AppNavigator() {
  const {token, isLoading} = useAuth();

  if (isLoading) {
    return (
      <View style={splash.container}>
        <CityShieldLogo size={96} showWordmark={true} />
        <ActivityIndicator
          color={colors.primary}
          size="large"
          style={{marginTop: spacing.xl}}
        />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {token ? <AuthenticatedApp /> : <UnauthenticatedApp />}
    </NavigationContainer>
  );
}

const splash = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
