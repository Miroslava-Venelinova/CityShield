// ─── src/context/AuthContext.tsx ──────────────────────────────────────────────
import React, {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {authApi, tokensApi} from '../services/api';

interface AuthContextType {
  token:       string | null;
  hasLocation: boolean | null;   // null = not yet loaded
  regionName:  string | null;
  streetName:  string | null;
  isLoading:   boolean;
  login:       (token: string) => Promise<void>;
  logout:      (fcmToken?: string) => Promise<void>;
  setHasLocation: (value: boolean) => void;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  token:          null,
  hasLocation:    null,
  regionName:     null,
  streetName:     null,
  isLoading:      true,
  login:          async () => {},
  logout:         async () => {},
  setHasLocation: () => {},
  refreshProfile: async () => {},
});

export const AuthProvider = ({children}: {children: ReactNode}) => {
  const [token,       setToken]       = useState<string | null>(null);
  const [hasLocation, setHasLocation] = useState<boolean | null>(null);
  const [regionName,  setRegionName]  = useState<string | null>(null);
  const [streetName,  setStreetName]  = useState<string | null>(null);
  const [isLoading,   setIsLoading]   = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem('auth_token');
        if (stored) {
          setToken(stored);
          await fetchProfile(stored);
        }
      } catch {
        // Storage unavailable
      } finally {
        setIsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchProfile(authToken: string) {
    try {
      const user = await authApi.me(authToken);
      setHasLocation(user.hasLocation);
      setRegionName(user.regionName);
      setStreetName(user.streetName);
    } catch {
      setHasLocation(false);
      setRegionName(null);
      setStreetName(null);
    }
  }

  const login = async (newToken: string) => {
    await AsyncStorage.setItem('auth_token', newToken);
    setToken(newToken);
    await fetchProfile(newToken);
  };

  const logout = async (fcmToken?: string) => {
    if (token && fcmToken) {
      try { await tokensApi.unregister({token: fcmToken}, token); }
      catch { /* best-effort */ }
    }
    await AsyncStorage.removeItem('auth_token');
    setToken(null);
    setHasLocation(null);
    setRegionName(null);
    setStreetName(null);
  };

  const refreshProfile = useCallback(async () => {
    if (token) await fetchProfile(token);
  }, [token]);

  return (
    <AuthContext.Provider value={{
      token, hasLocation, regionName, streetName, isLoading,
      login, logout, setHasLocation, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
