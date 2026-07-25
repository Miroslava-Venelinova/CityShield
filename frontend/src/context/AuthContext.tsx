// ─── src/context/AuthContext.tsx ──────────────────────────────────────────────
import React, {
  createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {ApiError, authApi, setSessionRenewer} from '../services/api';
import {clearUser, identifyUser} from '../services/push';

// Both tokens live in AsyncStorage, which is NOT encrypted — it is a plain file
// in the app's private data directory.
//
// Considered and deliberately not done: moving the refresh token to
// react-native-keychain / EncryptedSharedPreferences. The paths that would let
// another party read this file are already closed — app-private storage is
// unreadable by other apps, and `android:allowBackup="false"` in the manifest
// blocks `adb backup` and Google backup from carrying it off the device. What
// remains is a rooted or otherwise compromised device, and there the Keystore
// buys less than it looks like: an attacker running as the app's own UID can
// ask it to decrypt. So the trade was a native dependency and a native rebuild
// against a partial mitigation for a threat that already owns the device.
//
// Revisit if any of that changes — in particular if allowBackup is ever turned
// back on, which would make this a real exfiltration path rather than a
// theoretical one.
const ACCESS_KEY  = 'auth_token';
const REFRESH_KEY = 'refresh_token';

interface AuthContextType {
  token:         string | null;
  hasLocation:   boolean | null;   // null = not yet loaded
  regionName:    string | null;
  streetName:    string | null;
  emailVerified: boolean | null;   // null = not yet loaded
  isLoading:     boolean;
  login:       (token: string, refreshToken: string) => Promise<void>;
  logout:      () => Promise<void>;
  setHasLocation: (value: boolean) => void;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  token:          null,
  hasLocation:    null,
  regionName:     null,
  streetName:     null,
  emailVerified:  null,
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
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [isLoading,   setIsLoading]   = useState(true);

  // The refresh token is never rendered, and the renewer must always see the
  // newest one (rotation replaces it on every use), so it lives in a ref rather
  // than in state where a stale closure could capture a spent value.
  const refreshTokenRef = useRef<string | null>(null);

  /** Wipe the session locally. Dropping `token` sends the navigator to Login. */
  const clearSession = useCallback(async () => {
    // Unbind this device from the account first, so alerts for a signed-out
    // user stop arriving even if the rest of the teardown fails.
    clearUser();
    refreshTokenRef.current = null;
    await AsyncStorage.multiRemove([ACCESS_KEY, REFRESH_KEY]).catch(() => {});
    setToken(null);
    setHasLocation(null);
    setRegionName(null);
    setStreetName(null);
    setEmailVerified(null);
  }, []);

  // Teach the API layer how to renew an expired access token. Registered before
  // the boot effect below (effects run in declaration order), so the very first
  // /me call after a cold start can already be retried — that call is the one
  // most likely to carry an hours-old token.
  useEffect(() => {
    setSessionRenewer(async () => {
      const refreshToken = refreshTokenRef.current;
      if (!refreshToken) { return null; }
      try {
        const res = await authApi.refresh(refreshToken);
        refreshTokenRef.current = res.refreshToken;
        await AsyncStorage.multiSet([
          [ACCESS_KEY, res.token],
          [REFRESH_KEY, res.refreshToken],
        ]).catch(() => {});
        setToken(res.token);
        return res.token;
      } catch (err) {
        // Only a 401 means the session is actually over — the refresh token is
        // spent, expired or revoked, and nothing but a password will fix it.
        //
        // Everything else is transient and must NOT sign the user out. The
        // window this protects is narrow but entirely ordinary: the app wakes
        // with an hours-old access token, the first call 401s, and renewal is
        // the request that goes out while the phone is still on a dead
        // connection (or lands on a 429/5xx). Clearing here made that moment
        // cost the user their password, for a session the server had not
        // revoked. Returning null instead leaves the tokens in place, surfaces
        // the failure to the screen as any other error, and lets the next call
        // renew normally once the network is back.
        if (err instanceof ApiError && err.status === 401) {
          await clearSession();
        }
        return null;
      }
    });
    return () => setSessionRenewer(null);
  }, [clearSession]);

  useEffect(() => {
    (async () => {
      try {
        const [[, stored], [, storedRefresh]] =
          await AsyncStorage.multiGet([ACCESS_KEY, REFRESH_KEY]);
        refreshTokenRef.current = storedRefresh ?? null;
        if (stored) {
          setToken(stored);
          // May well be expired after a night on the shelf; the renewer above
          // handles that transparently.
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
      // Bind the device to this account for push targeting. Done on every
      // profile fetch, not just at login, so a cold start re-establishes it.
      identifyUser(user.userId);
      setHasLocation(user.hasLocation);
      setRegionName(user.regionName);
      setStreetName(user.streetName);
      setEmailVerified(user.emailVerified);
    } catch {
      setHasLocation(false);
      setRegionName(null);
      setStreetName(null);
      // Unknown, not unverified — a failed profile fetch must not make the app
      // nag a user whose address is fine.
      setEmailVerified(null);
    }
  }

  const login = async (newToken: string, newRefreshToken: string) => {
    refreshTokenRef.current = newRefreshToken;
    await AsyncStorage.multiSet([
      [ACCESS_KEY, newToken],
      [REFRESH_KEY, newRefreshToken],
    ]);
    setToken(newToken);
    await fetchProfile(newToken);
  };

  const logout = async () => {
    // Revoke server-side too, so the 90-day refresh token dies with the session
    // rather than lingering in the database until it expires on its own.
    const refreshToken = refreshTokenRef.current;
    if (refreshToken) {
      try { await authApi.logout(refreshToken); }
      catch { /* best-effort — signing out locally is what matters */ }
    }
    await clearSession();
  };

  const refreshProfile = useCallback(async () => {
    if (token) await fetchProfile(token);
  }, [token]);

  return (
    <AuthContext.Provider value={{
      token, hasLocation, regionName, streetName, emailVerified, isLoading,
      login, logout, setHasLocation, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
