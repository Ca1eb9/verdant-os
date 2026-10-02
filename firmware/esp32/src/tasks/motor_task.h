// motor_task.h
// Motor task: drives the motors from g_drive_queue (DriveCommand, see
// types.h for the contract).
//
// Every cycle, before anything else, it stops the motors if
// g_motor_kill_flag is set, or if the obstacle flag on the side it's driving
// toward is set. A timed Drive stops by itself; a finished Turn or timed
// Drive sets g_drive_done_seq.
//
// Highest priority, core 1.
//
// PLACEHOLDER until the motor control card: no motor driver yet, so it only
// logs each command and the motors stay off.

#pragma once

void motor_task(void* param);
