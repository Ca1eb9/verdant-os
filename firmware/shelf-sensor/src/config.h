// config.h
// Pin assignments and timing for the shelf sensor node (Arduino Uno R3).
// Nothing tunable should be hardcoded anywhere else. Shelf id, level and pH
// calibration live on the Pi (shelf-bridge config), so every node runs the
// same build.

#pragma once

#include <Arduino.h>

// ---- Serial -------------------------------------------------------------------

constexpr uint32_t SERIAL_BAUD = 115200;

// ---- Pins (Uno R3) ----------------------------------------------------------------
// BH1750 uses the hardware I2C pins: SDA = A4, SCL = A5.

constexpr uint8_t PIN_DHT = 2;          // DHT11 module "S" pin
constexpr uint8_t PIN_WATER_TEMP = 3;   // DS18B20 data, 4.7k pull-up to 5V
constexpr uint8_t PIN_WATER_LEVEL = 4;  // XKC-Y25 output; 10k pull-down so unplugged reads LOW
constexpr uint8_t PIN_PH = A0;          // pH board "Po" output

// XKC-Y25-V drives its output HIGH when it senses water through the wall
constexpr uint8_t WATER_LEVEL_OK_STATE = HIGH;

// ---- Timing ---------------------------------------------------------------------

constexpr uint32_t REPORT_INTERVAL_MS = 5000;   // one JSON line this often (DHT11 needs >= 1 s)
constexpr uint32_t I2C_TIMEOUT_US = 25000;      // a stuck bus aborts instead of hanging

// ---- Analog (pH) ------------------------------------------------------------------

constexpr uint16_t ADC_REF_MV = 5000;           // Uno ADC reference = USB 5V
constexpr uint16_t ADC_MAX = 1023;
constexpr uint8_t PH_SAMPLES = 11;              // median of this many (odd)
constexpr uint8_t PH_SAMPLE_GAP_MS = 10;

// ---- Sensor sanity ----------------------------------------------------------------

// DS18B20 reports 85.0 C from its power-on register when a conversion was missed
constexpr float WATER_TEMP_POWER_ON_C = 85.0f;
