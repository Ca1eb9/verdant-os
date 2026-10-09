export type ConnectionState = "online" | "offline";
export type LiveStatus = "live" | "stale" | "waiting";
export type HistoryRange = "24h" | "72h" | "7d";
export type FloatSensorState = 0 | 1;
export type AlertSeverity = "warning" | "critical";
export type AlertMetric =
  | "connection"
  | "air.temperature"
  | "air.humidity"
  | "water.temperature"
  | "water.ph"
  | "water.level";

/** A row of Supabase's farms table (or the Pi's own farm on FarmNet) */
export interface FarmIdentity {
  id: string;
  name: string;
}

/** A farm's latest environment reading. Null where the farm has no such sensor or it didn't read. */
export interface SensorReading {
  timestamp: string;
  device: string | null;
  airTemperature: number | null;
  humidity: number | null;
  waterTemperature: number | null;
  ph: number | null;
  /** False when the reservoir is below the level sensor */
  waterLevelOk: boolean | null;
  lightLux: number | null;
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
  };
  water: {
    temperature: number;
    ph: number;
    levelFloat: FloatSensorState;
  };
  light: {
    lux: number;
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
  };
  water: {
    t_c: number;
    ph: number;
  };
  light: {
    lux: number;
  };
  level: {
    float: FloatSensorState;
  };
}
