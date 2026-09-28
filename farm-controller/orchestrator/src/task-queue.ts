import { type FarmTask, TaskPriority, TaskStatus } from "@farm/shared";

const PRIORITY_RANK: Record<TaskPriority, number> = {
  [TaskPriority.CRITICAL]: 0,
  [TaskPriority.HIGH]: 1,
  [TaskPriority.NORMAL]: 2,
  [TaskPriority.LOW]: 3,
};

export class TaskQueue {
  private tasks: FarmTask[] = [];

  push(task: FarmTask) {
    task.status = TaskStatus.PENDING;
    this.tasks.push(task);
    this.tasks.sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.created_at - b.created_at
    );
  }

  pop(): FarmTask | null {
    return this.tasks.shift() ?? null;
  }

  peek(): FarmTask | null {
    return this.tasks[0] ?? null;
  }

  /** Put an interrupted task back at the front of its priority band */
  requeue(task: FarmTask) {
    task.status = TaskStatus.PENDING;
    task.assigned_robot = undefined;
    task.assigned_at = undefined;
    this.push(task);
  }

  remove(taskId: string): FarmTask | null {
    const idx = this.tasks.findIndex((t) => t.task_id === taskId);
    if (idx === -1) return null;
    return this.tasks.splice(idx, 1)[0];
  }

  get length(): number {
    return this.tasks.length;
  }

  all(): readonly FarmTask[] {
    return this.tasks;
  }
}
