// main.cpp
// Shelf sensor node: reads the air and reservoir sensors and prints one JSON
// line per report over USB serial. The Pi's shelf-bridge adds the shelf id,
// pH conversion and timestamp. Lines starting with '#' are logs the bridge
// ignores. A failed sensor prints null; the others keep reporting.

#include <Arduino.h>
#include <BH1750.h>
#include <DHT.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Wire.h>
#include <avr/wdt.h>
#include <math.h>

#include "config.h"

static DHT dht(PIN_DHT, DHT11);
static BH1750 lightMeter;
static OneWire oneWire(PIN_WATER_TEMP);
static DallasTemperature waterProbe(&oneWire);

static bool lightReady = false;
static uint32_t seq = 0;
static uint32_t lastReportMs = 0;

// Last known health per sensor, so failures log once instead of every report
static bool airOk = true;
static bool lightOk = true;
static bool waterTempOk = true;

static void noteHealth(const __FlashStringHelper* name, bool ok, bool& wasOk) {
  if (ok == wasOk) return;
  wasOk = ok;
  Serial.print(F("# "));
  Serial.print(name);
  Serial.println(ok ? F(" ok") : F(" failed"));
}

static float readLight() {
  if (!lightReady) lightReady = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  if (!lightReady) return NAN;
  float lux = lightMeter.readLightLevel();
  if (lux < 0) {
    // Bus error: configure it again on the next report
    lightReady = false;
    return NAN;
  }
  // A BH1750 that browns out restarts powered down and keeps answering with
  // a stale value; re-sending the mode each report recovers it by the next one
  lightReady = lightMeter.configure(BH1750::CONTINUOUS_HIGH_RES_MODE);
  return lux;
}

// Reads the conversion started at the previous report, then starts the next
// one, so the 750 ms conversion never blocks the loop.
static float readWaterTemp() {
  float c = waterProbe.getTempCByIndex(0);
  waterProbe.requestTemperatures();
  if (c == DEVICE_DISCONNECTED_C || c == WATER_TEMP_POWER_ON_C) return NAN;
  return c;
}

// Median rejects the spikes the high-impedance pH board picks up
static uint16_t readPhMv() {
  uint16_t s[PH_SAMPLES];
  for (uint8_t i = 0; i < PH_SAMPLES; i++) {
    s[i] = analogRead(PIN_PH);
    delay(PH_SAMPLE_GAP_MS);
  }
  for (uint8_t i = 1; i < PH_SAMPLES; i++) {
    uint16_t v = s[i];
    uint8_t j = i;
    for (; j > 0 && s[j - 1] > v; j--) s[j] = s[j - 1];
    s[j] = v;
  }
  return (uint32_t)s[PH_SAMPLES / 2] * ADC_REF_MV / ADC_MAX;
}

static void printField(const __FlashStringHelper* key, float v, uint8_t decimals) {
  Serial.print(F(",\""));
  Serial.print(key);
  Serial.print(F("\":"));
  // Serial.print renders inf as "inf", which would break the JSON line
  if (isnan(v) || isinf(v)) Serial.print(F("null"));
  else Serial.print(v, decimals);
}

static void report() {
  float airC = dht.readTemperature();
  float rh = dht.readHumidity();
  float lux = readLight();
  float waterC = readWaterTemp();
  bool levelOk = digitalRead(PIN_WATER_LEVEL) == WATER_LEVEL_OK_STATE;
  uint16_t phMv = readPhMv();

  noteHealth(F("dht11"), !isnan(airC) && !isnan(rh), airOk);
  noteHealth(F("bh1750"), !isnan(lux), lightOk);
  noteHealth(F("ds18b20"), !isnan(waterC), waterTempOk);

  // Field names match ShelfSensorData in @farm/shared where they overlap
  Serial.print(F("{\"seq\":"));
  Serial.print(seq++);
  printField(F("temperature_c"), airC, 1);
  printField(F("humidity_pct"), rh, 0);
  printField(F("light_lux"), lux, 0);
  printField(F("water_temp_c"), waterC, 2);
  Serial.print(F(",\"water_level_ok\":"));
  Serial.print(levelOk ? F("true") : F("false"));
  Serial.print(F(",\"ph_mv\":"));
  Serial.print(phMv);
  Serial.println('}');
}

void setup() {
  // A set WDRF keeps the watchdog armed after a watchdog reset; clear it
  // before the slow sensor setup below
  MCUSR = 0;
  wdt_disable();

  Serial.begin(SERIAL_BAUD);
  Serial.println(F("# shelf-sensor boot"));

  pinMode(PIN_WATER_LEVEL, INPUT);
  dht.begin();
  Wire.begin();
  Wire.setWireTimeout(I2C_TIMEOUT_US, true);
  waterProbe.begin();
  waterProbe.setWaitForConversion(false);
  waterProbe.requestTemperatures();

  wdt_enable(WDTO_8S);
}

void loop() {
  wdt_reset();
  uint32_t now = millis();
  if (now - lastReportMs < REPORT_INTERVAL_MS) return;
  lastReportMs = now;
  report();
}
