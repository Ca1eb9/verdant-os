// main.cpp
// setup() and loop() — creates queues, flags, and tasks

#include <Arduino.h>

#include "config.h"
#include "log.h"
#include "tasks/comms_task.h"
#include "tasks/motor_task.h"
#include "tasks/nav_task.h"
#include "tasks/pad_task.h"
#include "tasks/sensor_task.h"
#include "types.h"

static void start_task(TaskFunction_t fn, const char* name, uint32_t stack, uint8_t prio,
                       int core) {
  if (xTaskCreatePinnedToCore(fn, name, stack, nullptr, prio, nullptr, core) != pdPASS) {
    LOG("main", "can't create the %s task (out of memory)", name);
  }
}

void setup() {
#if ARDUINO_USB_CDC_ON_BOOT
  // With the write timeout at 0 below, a burst bigger than the default
  // 256-byte buffer (boot, a busy moment) would be cut short on the monitor.
  Serial.setTxBufferSize(SERIAL_TX_BUFFER_BYTES);
#endif
  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  // Native USB (ESP32-S3): never let a log call block a task when no
  // computer is reading the port.
  Serial.setTxTimeoutMs(0);
  // Wait up to 3 s for the serial monitor so the boot messages aren't lost.
  // setup() only, before any tasks exist.
  for (uint32_t t0 = millis(); !Serial && millis() - t0 < 3000;) delay(10);
#else
  delay(200);  // let the USB serial settle; setup() only, before any tasks
#endif
  LOG("main", "=== robot '%s' ===", ROBOT_ID);
  // Bench settings that turn off a protection: easy to forget before a real run.
  if (!OBSTACLE_FAILSAFE) LOG("main", "WARNING: OBSTACLE_FAILSAFE off: a dead ToF sensor won't stop the motor");
  if (!BATTERY_FAILSAFE) LOG("main", "WARNING: BATTERY_FAILSAFE off: no motor cutoff at low battery");
  if (!BOOT_CREEP) LOG("main", "BOOT_CREEP off: waiting in place for the first tag");
  if (CHARGE_SENSE_ALWAYS) LOG("main", "CHARGE_SENSE_ALWAYS on: charge contact read in every status, charges in idle or stopped");

  if (!create_queues()) {
    // Nothing can run without them; no task exists, so the motors stay off.
    LOG("main", "queue allocation failed");
    for (;;) vTaskDelay(portMAX_DELAY);
  }

  // Motor first, so it is waiting before anything can queue a drive command.
  start_task(motor_task, "motor", STACK_MOTOR, PRIO_MOTOR, CORE_REALTIME);
  start_task(sensor_task, "sensor", STACK_SENSOR, PRIO_SENSOR, CORE_REALTIME);
  start_task(nav_task, "nav", STACK_NAV, PRIO_NAV, CORE_REALTIME);
  start_task(comms_task, "comms", STACK_COMMS, PRIO_COMMS, CORE_NETWORK);
  start_task(pad_task, "pad", STACK_PAD, PRIO_PAD, CORE_NETWORK);
}

void loop() { vTaskDelete(nullptr); }  // all work happens in tasks
