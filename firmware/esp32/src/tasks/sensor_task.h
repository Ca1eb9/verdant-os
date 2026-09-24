// sensor_task.h
// Sensor task: RFID position, obstacle distance, battery voltage.
//
//   -> g_sensor_queue (SensorData) for the nav task, on every new tag and
//      at least every SENSOR_REPORT_MS
//   -> g_obstacle_flag, set the instant an obstacle is inside
//      OBSTACLE_STOP_CM. The motor task checks it every cycle.
//
// Priority PRIO_SENSOR on core 1. Runs every SENSOR_PERIOD_MS.

#pragma once

void sensor_task(void* param);
