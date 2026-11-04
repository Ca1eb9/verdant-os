"use client";

import { useEffect, useRef, useState } from "react";
import { useBackupNav } from "@/hooks/useBackupNav";
import { useFarmLive } from "@/hooks/useFarmLive";
import { resolveNode, type NavGraph } from "@/lib/farm/navigation";
import { isStale, statusLabel, type RobotView } from "@/lib/farm/robots";
import type { CommandType, RobotStatus } from "@/lib/farm/types";
import styles from "@/components/backup-nav/BackupNavPanel.module.css";

/**
 * Same as CONFIRM_NAV_MIN_MS on the robot: it ignores a tap this soon after
 * it set off for a node, so the button waits this long after each one.
 */
const TAP_COOLDOWN_MS = 1_000;
/** A tap the robot took moves its node at once; none by then and it ignored it */
const TAP_ANSWER_MS = 2_500;
/** Where the robot takes a tap (nav/confirm_nav on the robot) */
const TAPPABLE: RobotStatus[] = ["initializing", "en_route", "returning_to_dock", "stopped", "error", "manual"];

type Feedback = { tone: "ok" | "error" | "wait"; text: string };

/**
 * The node after the robot's current one on the orchestrator's planned path.
 * A ride over several levels is one edge on the robot: it drives off at the last.
 */
function nextNode(graph: NavGraph, robot: RobotView, currentId: string | undefined) {
  const path = robot.expectedPath ?? [];
  let i = currentId ? path.indexOf(currentId) : -1;
  if (i < 0 || i + 1 >= path.length) return undefined;
  const elevator = (id: string | undefined) => (id ? graph.nodes.get(id)?.type === "elevator" : false);
  if (elevator(path[i]) && elevator(path[i + 1])) {
    while (i + 2 < path.length && elevator(path[i + 2])) i++;
  }
  return path[i + 1];
}

/** At the bottom of Settings, only where useBackupNav() says so: nothing otherwise */
export function BackupNavPanel() {
  return useBackupNav() ? <BackupNavControls /> : null;
}

function BackupNavControls() {
  const { source, graph, robots, now } = useFarmLive();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // The tap waiting for the robot's answer: its node when tapped
  const pending = useRef<{ robotId: string; node: string | null; timer: number } | null>(null);

  // The first robot seen until one is picked, so a robot appearing later
  // can't take the taps over
  useEffect(() => {
    if (!pickedId && robots[0]) setPickedId(robots[0].id);
  }, [pickedId, robots]);
  const robot = robots.find((r) => r.id === pickedId) ?? (pickedId ? undefined : robots[0]);
  const online = Boolean(robot && !isStale(robot, now) && robot.status !== "lost");
  const current = robot ? resolveNode(graph, robot.currentNode) : undefined;
  const next = robot ? nextNode(graph, robot, current?.id) : undefined;
  const status = robot?.status;

  // The robot's answer to a tap: its node moved, or not by TAP_ANSWER_MS
  useEffect(() => {
    const wait = pending.current;
    if (!wait || !robot || robot.id !== wait.robotId || robot.currentNode === wait.node) return;
    window.clearTimeout(wait.timer);
    pending.current = null;
    setFeedback({ tone: "ok", text: `Got it: at ${current?.id ?? robot.currentNode}.` });
  }, [robot, current]);

  useEffect(
    () => () => {
      if (pending.current) window.clearTimeout(pending.current.timer);
    },
    [],
  );

  const send = async (command: CommandType) => {
    if (!robot) return false;
    try {
      await source.sendCommand({ robot_id: robot.id, command: { command, priority: "critical", immediate: true } }, "");
      return true;
    } catch (err) {
      setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not send the command." });
      return false;
    }
  };

  const tap = async () => {
    if (!robot || cooling || busy) return;
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    setCooling(true);
    window.setTimeout(() => setCooling(false), TAP_COOLDOWN_MS);
    const robotId = robot.id;
    const node = robot.currentNode;
    setBusy(true);
    const sent = await send("node_reached");
    setBusy(false);
    if (!sent) return;
    setFeedback({ tone: "wait", text: "Sent…" });
    const timer = window.setTimeout(() => {
      pending.current = null;
      setFeedback({
        tone: "error",
        text: "The robot didn't move on. It ignores a tap within a second of setting off, during the elevator ride, and with nothing to drive to.",
      });
    }, TAP_ANSWER_MS);
    pending.current = { robotId, node, timer };
  };

  const stop = async () => {
    if (await send("stop")) setFeedback({ tone: "ok", text: "Stop sent." });
  };
  const resume = async () => {
    if (await send("resume")) setFeedback({ tone: "ok", text: "Resume sent." });
  };

  const canTap = online && Boolean(status && TAPPABLE.includes(status));
  const reaching = status === "initializing" ? "the dock (it starts there)" : next ?? "the next node";

  return (
    <div className={`glassPanel ${styles.card}`}>
      <h2 className={styles.title}>Backup navigation</h2>
      <p className={styles.muted}>
        For a robot set up to navigate without tags: tap the moment it reaches each node.
      </p>
      {(robots.length > 1 || (!robot && robots.length > 0)) && (
        <div className="segmented" role="group" aria-label="Robot">
          {robots.map((r) => (
            <button
              key={r.id}
              type="button"
              className="segment"
              aria-pressed={r.id === robot?.id}
              onClick={() => {
                setPickedId(r.id);
                setFeedback(null);
                if (pending.current) window.clearTimeout(pending.current.timer);
                pending.current = null;
              }}
            >
              {r.id}
            </button>
          ))}
        </div>
      )}

      {!robot ? (
        <p className={styles.muted}>Waiting for robot telemetry.</p>
      ) : (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>{robot.id}</dt>
              <dd>{online ? statusLabel(robot.status) : "Offline"}</dd>
            </div>
            <div>
              <dt>At</dt>
              <dd>{current?.id ?? robot.currentNode ?? "No node yet"}</dd>
            </div>
            <div className={styles.wide}>
              <dt>Driving to</dt>
              <dd className={styles.next}>{canTap ? reaching : "Nothing right now"}</dd>
            </div>
          </dl>

          <button
            type="button"
            className={styles.reached}
            onClick={() => void tap()}
            disabled={!canTap || cooling || busy}
          >
            Reached next node
          </button>

          <p className={`${styles.feedback} ${feedback ? styles[feedback.tone] : ""}`} role="status" aria-live="polite">
            {feedback?.text ?? (online ? "" : "The robot is offline.")}
          </p>

          <div className={styles.row}>
            <button type="button" className={styles.stop} onClick={() => void stop()}>
              Stop
            </button>
            <button type="button" className={styles.resume} onClick={() => void resume()}>
              Resume
            </button>
          </div>
        </>
      )}
    </div>
  );
}
