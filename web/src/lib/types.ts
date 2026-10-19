export type LiveStatus = "live" | "stale" | "waiting";
export type FloatSensorState = 0 | 1;

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
  timestamp: string;
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

/** One point of a history chart: the average of the readings in its time bucket, null where none read */
export interface HistoryPoint {
  timestamp: string;
  air: { temperature: number | null; humidity: number | null };
  water: { temperature: number | null; ph: number | null };
  light: { lux: number | null };
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
