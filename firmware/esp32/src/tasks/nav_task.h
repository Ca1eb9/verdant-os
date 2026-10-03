// nav_task.h
// Navigation task: runs the robot state machine (nav/nav_core) on FreeRTOS.
//
//   g_sensor_queue  (SensorData)   -> tag UID -> node (flash graph), battery
//   g_command_queue (Command)      -> state machine
//   state machine                  -> g_event_queue (RobotEventMsg)
//                                  -> g_telemetry_queue (TelemetryMsg), every
//                                     TELEMETRY_PERIOD_MS and right away on a
//                                     status or node change
//                                  -> g_drive_queue (DriveCommand)
//
// Events are queued before the telemetry that reflects them, and comms
// publishes events first, so the Pi never sees a status ahead of its event.
//
// Priority PRIO_NAV on core 1. Runs every NAV_LOOP_MS.
//
// nav/survival runs first in every loop: battery thresholds, obstacle events,
// and g_motor_kill_flag at the motor cutoff. nav/motion turns the motion hooks
// into DriveCommands and reports missed tags to the state machine. Docking is
// a placeholder (logged, motors stopped) until the dock sequence card fills
// it in.

#pragma once

void nav_task(void* param);
