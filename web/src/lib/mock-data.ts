import type {
  FarmIdentity,
  FloatSensorState,
  HistoryPoint,
  HistoryRange,
  SensorEventPayload,
  TelemetrySnapshot,
} from "@/lib/types";
import { calibrateLightPpfd } from "@/lib/light-calibration";

export const HISTORY_RANGE_HOURS: Record<HistoryRange, number> = {
  "24h": 24,
  "72h": 72,
  "7d": 168,
};

export const FARMS: FarmIdentity[] = [
  {
    id: "atlas-north",
    name: "Arduino Uno R3 Farm",
    zone: "USB Serial Bench",
    deviceLabel: "Arduino Uno R3",
    deviceCount: 1,
    cultivarFocus: "Live sensor monitoring",
    connectionState: "online",
  },
  {
    id: "delta-east",
    name: "Delta Array East",
    zone: "Queens Corridor B",
    deviceLabel: "Serial Sensor B4",
    deviceCount: 9,
    cultivarFocus: "Basil + Mint",
    connectionState: "online",
  },
  {
    id: "nova-west",
    name: "Nova Grow West",
    zone: "Jersey Module C",
    deviceLabel: "Serial Sensor C2",
    deviceCount: 11,
    cultivarFocus: "Romaine + Arugula",
    connectionState: "online",
  },
];

function round(value: number, precision = 1) {
  return Number(value.toFixed(precision));
}

function hashSeed(value: string) {
  return Array.from(value).reduce((seed, char, index) => {
    return seed + char.charCodeAt(0) * (index + 1);
  }, 0);
}

function createSeededRandom(seed: number) {
  let state = seed % 2147483647;

  if (state <= 0) {
    state += 2147483646;
  }

  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function randomBetween(nextRandom: () => number, min: number, max: number, precision = 2) {
  return round(min + (max - min) * nextRandom(), precision);
}

function randomInteger(nextRandom: () => number, min: number, max: number) {
  return Math.round(min + (max - min) * nextRandom());
}

function toIsoWithOffset(date: Date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const offsetRemainingMinutes = String(absoluteMinutes % 60).padStart(2, "0");

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${sign}${offsetHours}:${offsetRemainingMinutes}`;
}

function mapDeviceId(farmId: string) {
  return farmId === "atlas-north" ? "arduino-uno-r3-1" : `${farmId}-sensor-1`;
}

function buildReservoirPercent(levelFloat: FloatSensorState, nextRandom: () => number) {
  return levelFloat === 1
    ? round(68 + nextRandom() * 24, 0)
    : round(14 + nextRandom() * 26, 0);
}

export class MockSensorGenerator {
  private readonly deviceId: string;
  private sequence = 0;

  constructor(deviceId = "farm-esp32-1") {
    this.deviceId = deviceId;
  }

  generate(timestamp: Date): SensorEventPayload {
    this.sequence += 1;
    const eventSeed = hashSeed(`${this.deviceId}:${this.sequence}:${timestamp.getTime()}`);
    const nextRandom = createSeededRandom(eventSeed);
    const lux = randomInteger(nextRandom, 18_000, 26_500);
    const ppfd = calibrateLightPpfd(lux);

    return {
      type: "sensor",
      ts: toIsoWithOffset(timestamp),
      device: this.deviceId,
      seq: this.sequence,
      air: {
        t_c: randomBetween(nextRandom, 22.0, 26.0, 2),
        rh_pct: randomBetween(nextRandom, 45.0, 65.0, 2),
        p_hpa: randomBetween(nextRandom, 1000.0, 1015.0, 2),
      },
      water: {
        t_c: randomBetween(nextRandom, 18.0, 22.0, 2),
        ph: randomBetween(nextRandom, 5.8, 6.8, 2),
        ec_ms_cm: randomBetween(nextRandom, 1.0, 1.8, 2),
      },
      light: {
        lux,
        ppfd: round(ppfd, 1),
      },
      level: {
        float: nextRandom() > 0.24 ? 1 : 0,
      },
    };
  }
}

function mapEventToTelemetrySnapshot(
  farmId: string,
  event: SensorEventPayload,
  nextRandom: () => number,
): TelemetrySnapshot {
  const lightPpfd = event.light.ppfd || round(calibrateLightPpfd(event.light.lux), 1);

  return {
    farmId,
    deviceId: event.device,
    sequence: event.seq,
    timestamp: event.ts,
    connectionState: "online",
    rawEvent: event,
    air: {
      temperature: event.air.t_c,
      humidity: event.air.rh_pct,
      pressure: event.air.p_hpa,
    },
    water: {
      temperature: event.water.t_c,
      ph: event.water.ph,
      ec: event.water.ec_ms_cm,
      level: buildReservoirPercent(event.level.float, nextRandom),
      levelFloat: event.level.float,
    },
    light: {
      lux: event.light.lux,
      ppfd: lightPpfd,
    },
  };
}

export function buildHistoricalSeries(farmId: string, hours = 168): HistoryPoint[] {
  const now = Date.now();
  const rawEvents = buildHistoricalSensorEvents(farmId, hours, now);

  return rawEvents.map((event, index) => ({
    index,
    ...mapEventToTelemetrySnapshot(
      farmId,
      event,
      createSeededRandom(hashSeed(`${farmId}:${event.seq}:reservoir`)),
    ),
  }));
}

export function buildLiveTelemetry(farmId: string, frames = 30): TelemetrySnapshot[] {
  return buildLiveSensorEvents(farmId, frames).map((event) =>
    mapEventToTelemetrySnapshot(
      farmId,
      event,
      createSeededRandom(hashSeed(`${farmId}:${event.seq}:reservoir`)),
    ),
  );
}

export function buildHistoricalSensorEvents(farmId: string, hours = 168, now = Date.now()) {
  const generator = new MockSensorGenerator(mapDeviceId(farmId));

  return Array.from({ length: hours }, (_, index) => {
    const hoursBack = hours - index - 1;
    const timestamp = new Date(now - hoursBack * 60 * 60 * 1000);
    return generator.generate(timestamp);
  });
}

export function buildLiveSensorEvents(farmId: string, frames = 30, now = Date.now()) {
  const generator = new MockSensorGenerator(mapDeviceId(farmId));

  return Array.from({ length: frames }, (_, index) => {
    const minutesBack = frames - index - 1;
    const timestamp = new Date(now - minutesBack * 4 * 60 * 1000);
    return generator.generate(timestamp);
  });
}

export function getFarmById(farmId: string) {
  return FARMS.find((farm) => farm.id === farmId) ?? FARMS[0];
}
