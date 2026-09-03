export type ConnectionState = "online" | "offline";
export type LiveStatus = "live" | "stale";
export type HistoryRange = "24h" | "72h" | "7d";
export type FloatSensorState = 0 | 1;
export type AlertSeverity = "warning" | "critical";
export type AlertMetric =
  | "connection"
  | "air.temperature"
  | "air.humidity"
  | "water.temperature"
  | "water.ph"
  | "water.level"
  | "light.ppfd";

export interface FarmIdentity {
  id: string;
  name: string;
  zone: string;
  deviceLabel: string;
  deviceCount: number;
  cultivarFocus: string;
  connectionState: ConnectionState;
}

export interface TelemetrySnapshot {
  farmId: string;
  deviceId: string;
  sequence: number;
  timestamp: string;
  connectionState: ConnectionState;
  rawEvent: SensorEventPayload;
  air: {
    temperature: number;
    humidity: number;
    pressure: number;
  };
  water: {
    temperature: number;
    ph: number;
    ec: number;
    level: number;
    levelFloat: FloatSensorState;
    levelText?: string;
  };
  light: {
    lux: number;
    ppfd: number;
  };
}

export interface SensorEventRecord {
  id?: string;
  created_at?: string;
  device: string | null;
  source: string | null;
  ts: string | null;
  air_temp_c: number | null;
  air_temp_f: number | null;
  humidity_pct: number | null;
  water_temp_c: number | null;
  water_temp_f: number | null;
  water_level_ok: boolean | null;
  water_level_text: string | null;
  ph_voltage: number | null;
  ph: number | null;
  light_lux: number | null;
  light_ppfd: number | null;
  raw_text: string | null;
}

export interface HistoryPoint extends TelemetrySnapshot {
  index: number;
}

export interface TelemetryAlert {
  id: string;
  farmId: string;
  farmName: string;
  metric: AlertMetric;
  severity: AlertSeverity;
  title: string;
  message: string;
  detectedAt: string;
  value?: string;
  threshold?: string;
}

export interface SensorEventPayload {
  type: "sensor";
  ts: string;
  device: string;
  seq: number;
  air: {
    t_c: number;
    rh_pct: number;
    p_hpa: number;
  };
  water: {
    t_c: number;
    ph: number;
    ec_ms_cm: number;
  };
  light: {
    lux: number;
    ppfd: number;
  };
  level: {
    float: FloatSensorState;
  };
}
