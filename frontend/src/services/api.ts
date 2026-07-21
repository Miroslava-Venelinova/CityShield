// ─── src/services/api.ts ──────────────────────────────────────────────────────
import {API_BASE_URL as BASE_URL} from '../config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoginRequest    { email: string; password: string; }
// Register no longer takes regionId / streetId — location is set separately
export interface RegisterRequest { email: string; password: string; }
/**
 * `token` is the 60-minute access token; `refreshToken` outlives it and is
 * traded for a new pair by `POST /api/auth/refresh` (see the session hook
 * below).
 */
export interface LoginResponse   { token: string; refreshToken: string; }

export interface UserDTO {
  email:         string;
  latitude:      number | null;
  longitude:     number | null;
  hasLocation:   boolean;
  regionName:    string | null;
  streetName:    string | null;
  /** False until the address is confirmed via the mailed link. */
  emailVerified: boolean;
  createdOnUTC:  string;
  updatedOnUTC:  string;
}

export interface UpdateLocationRequest {
  latitude:  number;
  longitude: number;
}

/** Everything GET /api/auth/me/export returns — GDPR Art. 20 portability. */
export interface DataExportDTO {
  profile: {
    email:              string;
    emailVerified:      boolean;
    latitude:           number | null;
    longitude:          number | null;
    regionName:         string | null;
    streetName:         string | null;
    receivesAllAlerts:  boolean;
    subscribedBusLines: string[];
    createdOnUTC:       string;
    updatedOnUTC:       string;
  };
  notificationPreferences: {category: string; isEnabled: boolean}[];
  devices: {
    platform:   string | null;
    deviceName: string | null;
    createdAt:  string;
    lastSeenAt: string;
  }[];
}

export interface RegisterTokenRequest {
  token:       string;
  platform?:   string;
  deviceName?: string;
}
export interface UnregisterTokenRequest { token: string; }

export interface NotificationPreferenceDTO {
  category:  string;
  label:     string;
  isEnabled: boolean;
}

// Bus-line filter for Traffic (vt) alerts. Empty `selected` = no filter,
// the user receives alerts for every line.
export interface BusLineSubscriptionDTO {
  available: string[];
  selected:  string[];
}

// ── Core fetch ────────────────────────────────────────────────────────────────

/**
 * An API call that failed. Carries the HTTP status so callers can react to
 * specific cases (429 cooldowns, 401 re-auth) instead of pattern-matching on
 * message strings.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Raw response body — for logging, never for display. */
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** True when the server rate-limited this request. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Raised when the request never reached the server at all. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

// ── Session renewal ───────────────────────────────────────────────────────────
//
// Access tokens expire after an hour. Nothing here used to notice: screens held
// whatever token was in storage, every call started coming back 401, and each
// screen swallowed it into its own "couldn't load" state — so the app read as
// permanently offline until it was reinstalled.
//
// So `request` renews once on a 401 and replays the call. AuthContext owns the
// tokens and installs the renewer below; this module stays unaware of storage
// and of navigation, and screens keep passing the token they already have.

/** Returns a fresh access token, or null when the session is truly over. */
type Renewer = () => Promise<string | null>;

let renewSession: Renewer | null = null;

/**
 * Installed once by AuthProvider. Without it (tests, the login screen) a 401 is
 * just a 401 — which is correct: there is no session to renew yet.
 */
export function setSessionRenewer(renewer: Renewer | null): void {
  renewSession = renewer;
}

// A screen that fans out several calls gets several simultaneous 401s. They
// must not each rotate the refresh token — rotation invalidates the previous
// one, so the second rotation would race the first and one caller would end up
// signed out. Everyone waits on the same in-flight renewal instead.
let inFlightRenewal: Promise<string | null> | null = null;

function renewOnce(): Promise<string | null> {
  if (!inFlightRenewal) {
    inFlightRenewal = (renewSession ?? (async () => null))()
      .catch(() => null)
      .finally(() => { inFlightRenewal = null; });
  }
  return inFlightRenewal;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  authToken?: string,
  /** Set on the replay after a renewal, so one failure cannot loop. */
  isRetry = false,
): Promise<T> {
  const url = `${BASE_URL}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {...options, headers});
  } catch (networkErr: any) {
    // Diagnostics go to the log; the thrown message is shown to users, so it
    // must not carry the API URL or backend setup instructions. (The previous
    // message walked the user through ASP.NET launch settings — a backend that
    // no longer exists.)
    console.warn(
      `Network error reaching ${url}: ${networkErr?.message ?? String(networkErr)}`,
    );
    throw new NetworkError(`Request to ${path} never reached the server`);
  }

  // An expired access token on an authenticated call: renew and replay once.
  // Unauthenticated calls (login, /password/forgot) are excluded — a 401 there
  // means bad credentials and is the caller's answer, not a stale session.
  if (response.status === 401 && authToken && !isRetry && renewSession) {
    const renewed = await renewOnce();
    if (renewed) {
      return request<T>(path, options, renewed, true);
    }
  }

  const text = await response.text();
  if (!response.ok) {
    // Server error bodies can echo back request content and are not localized,
    // so they are kept on the error object for logging rather than displayed.
    console.warn(`API ${options.method ?? 'GET'} ${path} → ${response.status}`);
    throw new ApiError(
      response.status,
      text,
      // Developer-facing only. Users see the localized string that screens
      // resolve via `errorMessageKey` in services/errors.ts.
      `${options.method ?? 'GET'} ${path} failed with ${response.status}`,
    );
  }

  try { return JSON.parse(text) as T; }
  catch { return text as unknown as T; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (body: LoginRequest): Promise<LoginResponse> =>
    request<LoginResponse>('/api/auth/login',
      {method: 'POST', body: JSON.stringify(body)}),

  register: (body: RegisterRequest): Promise<string> =>
    request<string>('/api/auth/register',
      {method: 'POST', body: JSON.stringify(body)}),

  /**
   * Trade a refresh token for a new pair. Called only by AuthContext's renewer;
   * screens never touch it. Deliberately not sent with an Authorization header
   * — the whole point is that the access token is expired.
   */
  refresh: (refreshToken: string): Promise<LoginResponse> =>
    request<LoginResponse>('/api/auth/refresh',
      {method: 'POST', body: JSON.stringify({refreshToken})}),

  /** Drop this device's session server-side. Best-effort; never throws to the UI. */
  logout: (refreshToken: string): Promise<void> =>
    request<void>('/api/auth/logout',
      {method: 'POST', body: JSON.stringify({refreshToken})}),

  me: (authToken: string): Promise<UserDTO> =>
    request<UserDTO>('/api/auth/me', {method: 'GET'}, authToken),

  /** Re-send the confirmation link. Always succeeds, even if already verified. */
  resendVerification: (authToken: string): Promise<void> =>
    request<void>('/api/auth/verify/resend', {method: 'POST'}, authToken),

  /**
   * Start a password reset. Deliberately returns 204 whether or not the address
   * is registered, so the caller cannot use it to test for accounts — screens
   * must show the same "check your inbox" message either way.
   */
  forgotPassword: (email: string): Promise<void> =>
    request<void>('/api/auth/password/forgot',
      {method: 'POST', body: JSON.stringify({email})}),

  updateLocation: (body: UpdateLocationRequest, authToken: string): Promise<void> =>
    request<void>('/api/auth/location',
      {method: 'PUT', body: JSON.stringify(body)}, authToken),

  // ── GDPR (PLAN.MD §1.10 / §2.3) ────────────────────────────────────────────

  /** Art. 17 erasure. Cascades to device tokens and preferences server-side. */
  deleteAccount: (authToken: string): Promise<void> =>
    request<void>('/api/auth/me', {method: 'DELETE'}, authToken),

  /** Art. 20 portability: every stored personal datum as JSON. */
  exportData: (authToken: string): Promise<DataExportDTO> =>
    request<DataExportDTO>('/api/auth/me/export', {method: 'GET'}, authToken),

  /** Withdraw location consent: clears lat/lng + region/street. */
  clearLocation: (authToken: string): Promise<void> =>
    request<void>('/api/auth/location', {method: 'DELETE'}, authToken),
};

// ── Device tokens ─────────────────────────────────────────────────────────────

export const tokensApi = {
  register: (body: RegisterTokenRequest, authToken: string): Promise<void> =>
    request<void>('/api/tokens',
      {method: 'POST', body: JSON.stringify(body)}, authToken),

  unregister: (body: UnregisterTokenRequest, authToken: string): Promise<void> =>
    request<void>('/api/tokens',
      {method: 'DELETE', body: JSON.stringify(body)}, authToken),
};

// ── Notification preferences ──────────────────────────────────────────────────

export const preferencesApi = {
  getAll: (authToken: string): Promise<NotificationPreferenceDTO[]> =>
    request<NotificationPreferenceDTO[]>(
      '/api/preferences', {method: 'GET'}, authToken),

  set: (category: string, isEnabled: boolean, authToken: string): Promise<void> =>
    request<void>(
      `/api/preferences/${category}`,
      {method: 'PUT', body: JSON.stringify({isEnabled})},
      authToken,
    ),

  getBusLines: (authToken: string): Promise<BusLineSubscriptionDTO> =>
    request<BusLineSubscriptionDTO>(
      '/api/preferences/bus-lines', {method: 'GET'}, authToken),

  setBusLines: (busLines: string[], authToken: string): Promise<void> =>
    request<void>(
      '/api/preferences/bus-lines',
      {method: 'PUT', body: JSON.stringify({busLines})},
      authToken,
    ),
};

// ── Alert types (used in HomeScreen) ─────────────────────────────────────────

export interface AlertLocation {
  location_name: string;
  sublocations:  string[];
  is_polygon:    boolean;
  polygon_geojson?: any;
  lat?: number;
  lng?: number;
}

export interface ProcessedData {
  locations:  AlertLocation[];
  start_time: string | null;
  end_time:   string | null;
}

export type AlertSource = 'vik' | 'vt' | 'epro' | 'heating';

export interface Alert {
  id: string;
  original_message: {
    title:      string;
    content?:   string;
    header?:    string;
    body?:      string;
    date?:      string;
    info_time?: string;
  };
  processed_data: ProcessedData;
  source:   AlertSource;
  severity: 'warning' | 'info' | 'danger';
  created_at: string;
}

// ── Alerts ────────────────────────────────────────────────────────────────────
// GET /api/alerts/recent returns alerts from the last 48h, newest first,
// with per-location lat/lng (geocoded server-side) and polygon geometries.

export const alertsApi = {
  getRecent: (authToken: string): Promise<Alert[]> =>
    request<Alert[]>('/api/alerts/recent', {method: 'GET'}, authToken),
};
