// globals.cpp
// Definitions for the queue handles and shared flags declared in types.h.
// Kept out of main.cpp so the bench build (which has its own setup()) can
// reuse them.

#include "types.h"
#include "config.h"

QueueHandle_t g_sensor_queue = nullptr;
QueueHandle_t g_drive_queue = nullptr;
QueueHandle_t g_command_queue = nullptr;
QueueHandle_t g_telemetry_queue = nullptr;
QueueHandle_t g_event_queue = nullptr;

volatile bool g_obstacle_front_flag = false;
volatile bool g_obstacle_rear_flag = false;
volatile bool g_motor_kill_flag = false;
volatile bool g_mqtt_connected = false;
volatile uint32_t g_last_command_ms = 0;

bool create_queues() {
  g_sensor_queue = xQueueCreate(SENSOR_QUEUE_LEN, sizeof(SensorData));
  g_drive_queue = xQueueCreate(DRIVE_QUEUE_LEN, sizeof(DriveCommand));
  g_command_queue = xQueueCreate(COMMAND_QUEUE_LEN, sizeof(Command));
  g_telemetry_queue = xQueueCreate(TELEMETRY_QUEUE_LEN, sizeof(TelemetryMsg));
  g_event_queue = xQueueCreate(EVENT_QUEUE_LEN, sizeof(RobotEventMsg));
  return g_sensor_queue && g_drive_queue && g_command_queue &&
         g_telemetry_queue && g_event_queue;
}
