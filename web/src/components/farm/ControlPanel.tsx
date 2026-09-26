"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandError, type CommandRecord, type CommandRequest, type FarmDataSource } from "@/lib/farm/data-source";
import type { Scene } from "@/lib/farm/map/layout";
import { resolveNode, type NavGraph } from "@/lib/farm/navigation";
import { isStale, statusLabel, type RobotView } from "@/lib/farm/robots";
import type { ActionAtTarget, FarmTopology, GraphNode, NodeType, RobotCommand } from "@/lib/farm/types";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import styles from "@/components/farm/ControlPanel.module.css";

const POLL_MS = 5_000;

const ACTIONS: Record<NodeType, ActionAtTarget[]> = {
  water: ["water", "idle"],
  checkpoint: ["grow", "harvest", "idle"],
  dock: ["charge"],
  elevator: [],
};

const ACTION_LABEL: Record<ActionAtTarget, string> = {
  water: "Water",
  grow: "Grow (lights)",
  harvest: "Harvest",
  charge: "Charge",
  idle: "Wait",
};

const COMMAND_LABEL: Record<RobotCommand["command"], string> = {
  navigate: "Go to",
  return_to_dock: "Return to dock",
  stop: "Stop",
  resume: "Resume",
};

export interface ControlPanelProps {
  source: FarmDataSource;
  topology: FarmTopology;
  graph: NavGraph;
  scene: Scene;
  robots: RobotView[];
  now: number;
  selectedRobotId: string | null;
  onSelectRobot: (robotId: string) => void;
  targetNodeId: string | null;
  onTargetChange: (nodeId: string | null) => void;
  /** Called after a command that moves the robot is accepted */
  onRouteStart: (robot: RobotView, targetNodeId: string) => void;
  onRouteClear: (robotId: string) => void;
}

export function ControlPanel({
  source,
  topology,
  graph,
  scene,
  robots,
  now,
  selectedRobotId,
  onSelectRobot,
  targetNodeId,
  onTargetChange,
  onRouteStart,
  onRouteClear,
}: ControlPanelProps) {
  const { fmt } = usePreferences();
  const robot = robots.find((r) => r.id === selectedRobotId);
  const online = Boolean(robot && !isStale(robot, now));
  const node = robot ? resolveNode(graph, robot.currentNode) : undefined;
  const target = targetNodeId ? graph.nodes.get(targetNodeId) : undefined;

  const [quickImmediate, setQuickImmediate] = useState(false);
  const [action, setAction] = useState<ActionAtTarget | "">("");
  const [durationMin, setDurationMin] = useState("");
  const [goImmediate, setGoImmediate] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [recent, setRecent] = useState<CommandRecord[]>([]);

  // action list follows the target's node type
  const actions = target ? ACTIONS[target.type] : [];
  useEffect(() => {
    setAction(actions[0] ?? "");
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetNodeId]);

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await source.listRecentCommands(selectedRobotId ?? undefined));
    } catch {
      setRecent([]);
    }
  }, [selectedRobotId, source]);

  useEffect(() => {
    void refreshRecent();
    const id = window.setInterval(refreshRecent, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshRecent]);

  // targets grouped by aisle and level, in rail order
  const targetGroups = useMemo(() => {
    const groups: { label: string; nodes: GraphNode[] }[] = [];
    for (const aisle of scene.aisles) {
      scene.levels.forEach((level) => {
        const nodes = topology.nodes
          .filter((n) => n.y === aisle.y && n.z === level.z && ACTIONS[n.type].length)
          .sort((a, b) => a.x - b.x);
        if (nodes.length) groups.push({ label: `Aisle ${aisle.name} · L${level.id}`, nodes });
      });
    }
    return groups;
  }, [scene, topology]);

  const dockNode = useMemo(() => topology.nodes.find((n) => n.type === "dock"), [topology]);

  const send = async (request: CommandRequest, after?: () => void) => {
    if (!robot) return;
    setBusy(true);
    setMessage(null);
    try {
      await source.sendCommand(request);
      const target = request.command.target_node;
      setMessage({
        tone: "ok",
        text: target
          ? `Sent ${robot.id} to ${target}.`
          : `${COMMAND_LABEL[request.command.command]} sent to ${robot.id}.`,
      });
      after?.();
      void refreshRecent();
    } catch (err) {
      const text =
        err instanceof CommandError && err.status === 401
          ? "Your session expired. Sign in again to send commands."
          : err instanceof Error
            ? err.message
            : "Could not send the command.";
      setMessage({ tone: "error", text });
    } finally {
      setBusy(false);
    }
  };

  const status = robot?.status;
  const canStop = online;
  const canDock = online && status !== "docking" && status !== "charging" && Boolean(dockNode);
  const canResume = online && (status === "manual" || status === "idle");
  const canGo = online && Boolean(target) && target?.id !== node?.id && Boolean(action);

  const sendStop = () =>
    robot &&
    send({ robot_id: robot.id, command: { command: "stop", priority: "critical", immediate: quickImmediate } }, () =>
      onRouteClear(robot.id),
    );

  const sendDock = () =>
    robot &&
    send(
      { robot_id: robot.id, command: { command: "return_to_dock", priority: "critical", immediate: quickImmediate } },
      () => dockNode && onRouteStart(robot, dockNode.id),
    );

  const sendResume = () =>
    robot && send({ robot_id: robot.id, command: { command: "resume", priority: "critical", immediate: true } });

  const sendGo = () => {
    if (!robot || !target || !action) return;
    if (goImmediate && !confirming) {
      setConfirming(true);
      return;
    }
    const minutes = Number(durationMin);
    const command: CommandRequest["command"] = {
      command: "navigate",
      target_node: target.id,
      action_at_target: action,
      priority: goImmediate ? "high" : "normal",
      immediate: goImmediate,
    };
    if (durationMin && Number.isFinite(minutes) && minutes > 0) command.duration_ms = Math.round(minutes * 60_000);
    setConfirming(false);
    void send({ robot_id: robot.id, command }, () => {
      onRouteStart(robot, target.id);
      onTargetChange(null);
    });
  };

  const levelOf = (n: GraphNode | undefined) => (n ? scene.levels.findIndex((lv) => lv.z === n.z) + 1 : 0);
  const aisleOf = (n: GraphNode | undefined) => (n ? scene.aisles.find((a) => a.y === n.y)?.name : undefined);

  return (
    <aside className={`glassPanel ${styles.panel}`} aria-label="Robot control">
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className="eyebrow">Robot</span>
          <span className={styles.count}>{robots.length} connected</span>
        </div>
        <select
          id="robot-select"
          className="controlSelect"
          value={robot?.id ?? ""}
          disabled={!robots.length}
          onChange={(event) => event.target.value && onSelectRobot(event.target.value)}
          aria-label="Robot"
        >
          {robots.length ? (
            robots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {isStale(r, now) ? "Offline" : statusLabel(r.status)}
              </option>
            ))
          ) : (
            <option value="">No robots online</option>
          )}
        </select>

        <dl className={styles.facts}>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`${styles.pill} ${online ? styles[`st_${status}`] ?? "" : styles.offline}`}>
                {robot ? (online ? statusLabel(robot.status) : "Offline") : "—"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Battery</dt>
            <dd>{robot ? `${Math.round(robot.batteryPct)}%` : "—"}</dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd>{node ? `${node.id} · Aisle ${aisleOf(node)} L${levelOf(node)}` : robot ? "Unknown" : "—"}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{robot ? fmt.time(robot.lastSeen) : "—"}</dd>
          </div>
          {robot?.taskLabel ? (
            <div className={styles.wide}>
              <dt>Task</dt>
              <dd>{robot.taskLabel}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className={styles.section}>
        <span className="eyebrow">Quick actions</span>
        <button type="button" className={`${styles.btn} ${styles.stop}`} disabled={!canStop || busy} onClick={sendStop}>
          Stop
        </button>
        <div className={styles.pair}>
          <button type="button" className={styles.btn} disabled={!canResume || busy} onClick={sendResume}>
            Resume
          </button>
          <button type="button" className={styles.btn} disabled={!canDock || busy} onClick={sendDock}>
            Return to dock
          </button>
        </div>
        <label className={styles.check}>
          <input
            id="quick-immediate"
            type="checkbox"
            checked={quickImmediate}
            onChange={(event) => setQuickImmediate(event.target.checked)}
          />
          <span>
            Send Stop and Return to dock as <strong>immediate</strong>
            <small>Off: added to the robot&apos;s task queue at critical priority. Resume is always immediate.</small>
          </span>
        </label>
      </section>

      <section className={styles.section}>
        <span className="eyebrow">Send to node</span>
        <label className={styles.field}>
          <span>Target</span>
          <select
            id="target-node"
            className="controlSelect"
            value={targetNodeId ?? ""}
            onChange={(event) => onTargetChange(event.target.value || null)}
          >
            <option value="">Pick on the map or choose…</option>
            {targetGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id} ({n.type})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className={styles.pair}>
          <label className={styles.field}>
            <span>Action at target</span>
            <select
              id="target-action"
              className="controlSelect"
              value={action}
              disabled={!actions.length}
              onChange={(event) => setAction(event.target.value as ActionAtTarget)}
            >
              {actions.length ? (
                actions.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </option>
                ))
              ) : (
                <option value="">—</option>
              )}
            </select>
          </label>
          <label className={styles.field}>
            <span>Duration (min)</span>
            <input
              id="target-duration"
              className="controlSelect"
              type="number"
              min={1}
              max={1440}
              step={1}
              inputMode="numeric"
              placeholder="Default"
              value={durationMin}
              onChange={(event) => setDurationMin(event.target.value)}
            />
          </label>
        </div>

        <label className={styles.check}>
          <input
            id="go-immediate"
            type="checkbox"
            checked={goImmediate}
            onChange={(event) => {
              setGoImmediate(event.target.checked);
              setConfirming(false);
            }}
          />
          <span>
            Immediate
            <small>Interrupts the robot&apos;s current task instead of queueing behind it.</small>
          </span>
        </label>

        <button
          type="button"
          className={`${styles.btn} ${confirming ? styles.confirm : styles.primary}`}
          disabled={!canGo || busy}
          onClick={sendGo}
        >
          {confirming ? "Confirm: interrupt current task" : target ? `Send ${robot?.id ?? "robot"} to ${target.id}` : "Send to node"}
        </button>
        {confirming ? (
          <button type="button" className={styles.linkBtn} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        ) : null}
      </section>

      {message ? (
        <p className={`${styles.message} ${message.tone === "error" ? styles.messageError : ""}`} role="status">
          {message.text}
        </p>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className="eyebrow">Recent commands</span>
        </div>
        {recent.length ? (
          <ol className={styles.log}>
            {recent.map((cmd) => (
              <li key={cmd.id}>
                <span className={`${styles.pill} ${styles[`cmd_${cmd.status}`]}`}>{cmd.status}</span>
                <span className={styles.logText}>
                  {COMMAND_LABEL[cmd.command.command] ?? cmd.command.command}
                  {cmd.command.target_node ? ` ${cmd.command.target_node}` : ""}
                  {cmd.command.immediate ? " · immediate" : ""}
                </span>
                <time>{fmt.time(cmd.issued_at, { date: false })}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.muted}>No commands yet.</p>
        )}
      </section>

    </aside>
  );
}
