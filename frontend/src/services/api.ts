// ─── src/services/api.ts ──────────────────────────────────────────────────────
import {API_BASE_URL as BASE_URL} from '../config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoginRequest    { email: string; password: string; }
// Register no longer takes regionId / streetId — location is set separately
export interface RegisterRequest { email: string; password: string; }
export interface LoginResponse   { token: string; }

export interface UserDTO {
  email:        string;
  latitude:     number | null;
  longitude:    number | null;
  hasLocation:  boolean;
  regionName:   string | null;
  streetName:   string | null;
  createdOnUTC: string;
  updatedOnUTC: string;
}

export interface UpdateLocationRequest {
  latitude:  number;
  longitude: number;
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

async function request<T>(
  path: string,
  options: RequestInit = {},
  authToken?: string,
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
    throw new Error(
      `Network error reaching ${url}\n` +
      `Cause: ${networkErr?.message ?? String(networkErr)}\n\n` +
      `Check:\n` +
      `1. BASE_URL port matches your ASP.NET launchSettings.json\n` +
      `2. API is running with UseUrls("http://0.0.0.0:<port>")\n` +
      `3. android/app/src/main/res/xml/network_security_config.xml exists`,
    );
  }

  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);

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

  me: (authToken: string): Promise<UserDTO> =>
    request<UserDTO>('/api/auth/me', {method: 'GET'}, authToken),

  updateLocation: (body: UpdateLocationRequest, authToken: string): Promise<void> =>
    request<void>('/api/auth/location',
      {method: 'PUT', body: JSON.stringify(body)}, authToken),
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

export type AlertSource = 'vik' | 'vt' | 'epro' | 'heating' | 'roads';

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
