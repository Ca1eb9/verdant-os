// log.h
// Tiny serial logger shared by all tasks: "[  12345] comms  message".
// HardwareSerial on the ESP32 is internally locked, so tasks can log freely.

#pragma once

#include <Arduino.h>

#define LOG(tag, fmt, ...) \
  Serial.printf("[%7lu] %-6s " fmt "\n", (unsigned long)millis(), tag, ##__VA_ARGS__)
