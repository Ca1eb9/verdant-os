// motor_task.h
// Motor task: drives the motor from g_drive_queue (DriveCommand, see
// types.h for the contract).
//
// Every cycle, before anything else, it stops the motor if
// g_motor_kill_flag is set, or if the obstacle flag on the side it's driving
// toward is set. A timed Drive stops by itself and sets g_drive_done_seq.
// Reversing slows to 0 over REVERSE_RAMP_MS first (types.h).
//
// The rules live in motor/motor_core (host-tested); the H-bridge is
// drivers/motor_driver. Highest priority, core 1.

#pragma once

void motor_task(void* param);
