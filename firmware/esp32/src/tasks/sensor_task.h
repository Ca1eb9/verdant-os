// sensor_task.h
// Sensor task: RFID position, obstacle distance, battery voltage.
//
//   -> g_sensor_queue (SensorData) for the nav task, on every new tag and
//      at least every SENSOR_REPORT_MS
//   -> g_obstacle_front_flag / g_obstacle_rear_flag, set the instant an
//      obstacle is inside that side's stop distance (g_obstacle_*_stop_cm:
//      OBSTACLE_STOP_CM, lowered by nav for a dock or elevator approach).
//      The motor task checks the flag for the direction it's driving every
//      cycle.
//
// Priority PRIO_SENSOR on core 1. Runs every SENSOR_PERIOD_MS.

#pragma once

void sensor_task(void* param);
