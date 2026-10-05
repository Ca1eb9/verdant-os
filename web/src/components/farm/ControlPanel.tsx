"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CommandError, type CommandRecord, type CommandRequest, type FarmDataSource } from "@/lib/farm/data-source";
import type { Scene } from "@/lib/farm/map/layout";
import { resolveNode, type NavGraph } from "@/lib/farm/navigation";
import { describeTask, isStale, statusLabel, type RobotView } from "@/lib/farm/robots";
import type {
  ActionAtTarget,
  FarmTopology,
  GraphNode,
  JogDirection,
  NodeType,
  RobotCommand,
  RobotStatus,
} from "@/lib/farm/types";
import { usePreferences } from "@/components/preferences/PreferencesProvider";
import styles from "@/components/farm/ControlPanel.module.css";

const KEY_STORAGE = "verdantos:operator-key";
const POLL_MS = 5_000;
/** Resend while a jog button is held; under the robot's 500 ms pulse so it drives smoothly */
const JOG_REPEAT_MS = 400;
/** Same as MANUAL_TIMEOUT_MS on the robot: a session ends after this long without a jog */
const MANUAL_TIMEOUT_S = 5;
/** States the robot accepts a jog in */
const JOGGABLE: RobotStatus[] = ["idle", "en_route", "working", "stopped", "error", "manual"];

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
  cancel: "Cancel task",
  jog: "Jog",
};

function readKey() {
  try {
    return window.localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function storeKey(value: string) {
  try {
    if (value) window.localStorage.setItem(KEY_STORAGE, value);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage blocked: the key lasts for this page view only
  }
}

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

  const [operatorKey, setOperatorKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [quickImmediate, setQuickImmediate] = useState(false);
  const [action, setAction] = useState<ActionAtTarget | "">("");
  const [durationMin, setDurationMin] = useState("");
  const [goImmediate, setGoImmediate] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [confirmingManual, setConfirmingManual] = useState(false);
  const [manualArmed, setManualArmed] = useState(false);
  const [jogging, setJogging] = useState<JogDirection | null>(null);
  const jogTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [recent, setRecent] = useState<CommandRecord[]>([]);
  // On FarmNet commands go straight to the broker, which only the farm network reaches
  const localMode = source.mode === "local";
  const needsKey = !localMode && !operatorKey;

  useEffect(() => setOperatorKey(readKey()), []);

  // action list follows the target's node type
  const actions = target ? ACTIONS[target.type] : [];
  useEffect(() => {
    setAction(actions[0] ?? "");
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetNodeId]);

  const task = robot?.task ?? null;
  const taskText = task ? robot?.taskLabel ?? describeTask(task) : null;
  // a new robot or task needs a fresh confirmation
  useEffect(() => setConfirmingCancel(false), [selectedRobotId, task?.id]);

  const refreshRecent = useCallback(async () => {
    try {
      // jogs repeat while held; they'd flood the log
      const commands = await source.listRecentCommands(selectedRobotId ?? undefined);
      setRecent(commands.filter((cmd) => cmd.command.command !== "jog"));
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
    if (needsKey) {
      setShowKey(true);
      setMessage({ tone: "error", text: "Enter the operator key to send commands." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await source.sendCommand(request, operatorKey);
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
      const text = err instanceof Error ? err.message : "Could not send the command.";
      if (err instanceof CommandError && err.status === 401) setShowKey(true);
      setMessage({ tone: "error", text });
    } finally {
      setBusy(false);
    }
  };

  const status = robot?.status;
  const canStop = online;
  const canDock = online && status !== "docking" && status !== "charging" && Boolean(dockNode);
  const canResume = online && (status === "stopped" || status === "manual" || status === "idle");
  // Cancel works offline too: the orchestrator resends it when the robot reconnects.
  // A stop can't be cancelled; Resume releases the robot instead.
  const stopActive = task?.type === "stop";
  const canCancel = Boolean(task) && !stopActive;
  const cancelTitle = !task
    ? "This robot has no task to cancel."
    : stopActive
      ? "A stop is in progress and can't be cancelled. Use Resume to release the robot."
      : online
        ? `Cancels "${taskText}". The robot drops it right away.`
        : `Cancels "${taskText}". The robot is offline and drops it when it reconnects.`;
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

  // --- Manual control (farm network only) ---
  const inManual = status === "manual";
  const canJog = localMode && online && Boolean(status && JOGGABLE.includes(status));
  const manualTitle = !online
    ? "The robot is offline."
    : canJog
      ? "Drive the robot with Forward and Back until you press Resume."
      : `Not available while the robot is ${statusLabel(status ?? "idle").toLowerCase()}.`;

  const stopJog = useCallback(() => {
    if (jogTimer.current !== null) {
      window.clearInterval(jogTimer.current);
      jogTimer.current = null;
    }
    setJogging(null);
  }, []);

  const sendJog = (robotId: string, direction: JogDirection) =>
    source
      .sendCommand({ robot_id: robotId, command: { command: "jog", direction, priority: "critical", immediate: true } }, operatorKey)
      .catch((err) => {
        stopJog();
        setMessage({ tone: "error", text: err instanceof Error ? err.message : "Could not send the command." });
      });

  const startJog = (direction: JogDirection) => {
    if (!robot || !canJog || jogTimer.current !== null) return;
    setMessage(null);
    const robotId = robot.id;
    void sendJog(robotId, direction);
    jogTimer.current = window.setInterval(() => void sendJog(robotId, direction), JOG_REPEAT_MS);
    setJogging(direction);
  };

  // stop sending when the robot changes, can't be jogged, or the window loses focus
  useEffect(() => {
    stopJog();
    setManualArmed(false);
    setConfirmingManual(false);
  }, [selectedRobotId, stopJog]);
  useEffect(() => {
    if (!canJog) stopJog();
  }, [canJog, stopJog]);
  useEffect(() => {
    window.addEventListener("blur", stopJog);
    return () => {
      window.removeEventListener("blur", stopJog);
      stopJog();
    };
  }, [stopJog]);

  // once the robot leaves manual, the next session needs a fresh confirmation
  const wasManual = useRef(false);
  useEffect(() => {
    if (wasManual.current && !inManual) setManualArmed(false);
    wasManual.current = inManual;
  }, [inManual]);

  const holdProps = (direction: JogDirection) => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      startJog(direction);
    },
    onPointerUp: stopJog,
    onPointerCancel: stopJog,
    onLostPointerCapture: stopJog,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) {
        event.preventDefault();
        startJog(direction);
      }
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " || event.key === "Enter") stopJog();
    },
    onBlur: stopJog,
    onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
  });

  const sendCancel = () => {
    if (!robot || !task || !canCancel) return;
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      return;
    }
    setConfirmingCancel(false);
    void send(
      { robot_id: robot.id, command: { command: "cancel", task_id: task.id, priority: "critical", immediate: true } },
      () => onRouteClear(robot.id),
    );
  };

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

  const saveKey = () => {
    const value = keyDraft.trim();
    storeKey(value);
    setOperatorKey(value);
    setKeyDraft("");
    setShowKey(false);
    setMessage(value ? { tone: "ok", text: "Operator key saved on this device." } : null);
  };

  const levelOf = (n: GraphNode | undefined) => (n ? scene.levels.findIndex((lv) => lv.z === n.z) + 1 : 0);
  const aisleOf = (n: GraphNode | undefined) => (n ? scene.aisles.find((a) => a.y === n.y)?.name : undefined);

  return (
    <aside className={`glassPanel ${styles.panel}`} aria-label="Robot control" data-keep-target>
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
        <div className={styles.sectionHead}>
          <span className="eyebrow">Current task</span>
          {task ? <span className={styles.count}>{task.id.slice(0, 8)}</span> : null}
        </div>
        <p className={task ? styles.taskText : styles.muted}>{robot ? taskText ?? "No task" : "—"}</p>
        {/* the wrapper carries the tooltip, since disabled buttons don't get hover events everywhere */}
        <span className={styles.tip} title={cancelTitle}>
          <button
            type="button"
            className={`${styles.btn} ${confirmingCancel ? styles.confirm : styles.caution}`}
            disabled={!canCancel || busy}
            onClick={sendCancel}
          >
            {confirmingCancel ? "Confirm: cancel current task" : "Cancel task"}
          </button>
        </span>
        {stopActive ? <p className={styles.muted}>Stop in progress. Use Resume to release the robot.</p> : null}
        {confirmingCancel ? (
          <button type="button" className={styles.linkBtn} onClick={() => setConfirmingCancel(false)}>
            Keep task
          </button>
        ) : null}
      </section>

      {localMode ? (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className="eyebrow">Manual control</span>
            {inManual ? <span className={`${styles.pill} ${styles.st_manual}`}>Manual</span> : null}
          </div>
          {inManual || manualArmed ? (
            <>
              <div className={styles.pair}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.jog} ${jogging === "backward" ? styles.jogActive : ""}`}
                  disabled={!canJog}
                  aria-pressed={jogging === "backward"}
                  {...holdProps("backward")}
                >
                  ◀ Back
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.jog} ${jogging === "forward" ? styles.jogActive : ""}`}
                  disabled={!canJog}
                  aria-pressed={jogging === "forward"}
                  {...holdProps("forward")}
                >
                  Forward ▶
                </button>
              </div>
              <p className={styles.muted}>
                Hold to drive; the robot stops within half a second of letting go. After {MANUAL_TIMEOUT_S} s without
                input, or on Resume, it takes back control{task ? ` and continues ${taskText}` : ""}.
              </p>
            </>
          ) : confirmingManual ? (
            <>
              <button
                type="button"
                className={`${styles.btn} ${styles.confirm}`}
                disabled={!canJog}
                onClick={() => {
                  setManualArmed(true);
                  setConfirmingManual(false);
                }}
              >
                Confirm: take manual control
              </button>
              <p className={styles.muted}>
                {task
                  ? `Pauses ${taskText} while you drive. It continues ${MANUAL_TIMEOUT_S} s after your last input, or on Resume.`
                  : `The robot stays in manual until ${MANUAL_TIMEOUT_S} s after your last input, or until Resume.`}
              </p>
              <button type="button" className={styles.linkBtn} onClick={() => setConfirmingManual(false)}>
                Not now
              </button>
            </>
          ) : (
            <span className={styles.tip} title={manualTitle}>
              <button
                type="button"
                className={`${styles.btn} ${styles.caution}`}
                disabled={!canJog}
                onClick={() => setConfirmingManual(true)}
              >
                Take manual control
              </button>
            </span>
          )}
        </section>
      ) : null}

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
                  {cmd.command.command === "cancel" && cmd.command.task_id ? ` ${cmd.command.task_id.slice(0, 8)}` : ""}
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

      {localMode ? null : (
        <section className={styles.keyRow}>
          {showKey ? (
            <form
              className={styles.keyForm}
              onSubmit={(event) => {
                event.preventDefault();
                saveKey();
              }}
            >
              <input
                id="operator-key"
                className="controlSelect"
                type="password"
                autoComplete="off"
                placeholder="Operator key"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
              <button type="submit" className={styles.btn}>
                Save
              </button>
            </form>
          ) : (
            <button type="button" className={styles.linkBtn} onClick={() => setShowKey(true)}>
              {operatorKey ? "Change operator key" : "Set operator key"}
            </button>
          )}
        </section>
      )}
    </aside>
  );
}
