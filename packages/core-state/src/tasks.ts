/**
 * Task registry — the human-directed task lifecycle with approvals
 * (V2 Phase 2; Req 2.1–2.3; idea.md §6 Task management & Direction/Control).
 *
 * The {@link TaskRegistry} is the pure, in-memory authority for shared Tasks.
 * Like the other core-state registries it is dependency-free (no I/O, no clocks):
 * the caller assigns the authoritative `eventRevision` and the registry records
 * it verbatim so ordering follows the per-session Event_Revision total order.
 *
 * ## Lifecycle (Req 2.1–2.3)
 * ```
 * assign            → proposed
 * proposed + accept → accepted        (assignee only)
 * proposed + reject → rejected        (assignee only)
 * accepted|in_progress + progress(in_progress) → in_progress   (assignee only)
 * accepted|in_progress + progress(done)        → done          (assignee only)
 * proposed|accepted|in_progress + withdraw     → withdrawn      (assigner or assignee)
 * ```
 * A `rejected`, `done`, or `withdrawn` task is terminal. Illegal transitions and
 * unauthorized actors are rejected without mutating state.
 *
 * ## Authorization (Req 2.2)
 * - Only the **assignee** may `respond` (accept/reject) or report `progress`.
 * - Only the **assigner or assignee** may `withdraw`.
 * A disallowed actor yields `AUTH_NOT_AUTHORIZED`; an unknown task yields
 * `NOT_FOUND`; an illegal transition for the current status yields `FORMAT_ERROR`.
 *
 * ## Task_List projection (Req 2.1)
 * A member's Task_List is the set of tasks assigned to it that it has accepted
 * (`accepted`/`in_progress`/`done`). A `proposed` task is an *incoming approval*
 * (see {@link TaskRegistry.incomingProposalsFor}), not yet in the list.
 */

import type { ErrorCode, MemberRef, SessionId, TaskDto } from "@cfls/protocol";

import { sessionKey } from "./session";

/** Assign a new task (proposed). `eventRevision` is assigned by the caller. */
export interface AssignTaskRequest {
  session: SessionId;
  /** Globally unique task id (typically the originating Event_ID). */
  taskId: string;
  title: string;
  description: string;
  /** The member whose Task_List the task targets. */
  assignee: MemberRef;
  /** The member (human or Luna) assigning the task. */
  assigner: MemberRef;
  eventRevision: number;
}

/** Assignee approves or rejects a proposed task (Req 2.2). */
export interface RespondTaskRequest {
  session: SessionId;
  taskId: string;
  requester: MemberRef;
  /** True to accept (→ accepted); false to reject (→ rejected). */
  accept: boolean;
  eventRevision: number;
}

/** Assignee advances an accepted task (Req 2.3). */
export interface ProgressTaskRequest {
  session: SessionId;
  taskId: string;
  requester: MemberRef;
  status: "in_progress" | "done";
  eventRevision: number;
}

/** Assigner or assignee withdraws a task (Req 2.2). */
export interface WithdrawTaskRequest {
  session: SessionId;
  taskId: string;
  requester: MemberRef;
  eventRevision: number;
}

/** Result of a task mutation: the updated task, or a typed rejection. */
export type TaskResult =
  | { ok: true; task: TaskDto }
  | { ok: false; code: ErrorCode; reason: string };

/** Pure in-memory registry of the human-directed task lifecycle (Req 2.1–2.3). */
export class TaskRegistry {
  /** `session_key` → (`taskId` → task). */
  private readonly sessions = new Map<string, Map<string, TaskDto>>();

  private tasksFor(session: SessionId): Map<string, TaskDto> {
    const key = sessionKey(session);
    let tasks = this.sessions.get(key);
    if (tasks === undefined) {
      tasks = new Map<string, TaskDto>();
      this.sessions.set(key, tasks);
    }
    return tasks;
  }

  /**
   * Assign a new task in `proposed` status (Req 2.2). Idempotent on `taskId`: a
   * duplicate assignment returns the existing task unchanged.
   */
  assign(request: AssignTaskRequest): TaskResult {
    const tasks = this.tasksFor(request.session);
    const existing = tasks.get(request.taskId);
    if (existing !== undefined) {
      return { ok: true, task: existing };
    }
    const task: TaskDto = {
      taskId: request.taskId,
      title: request.title,
      description: request.description,
      assignee: { ...request.assignee },
      assigner: { ...request.assigner },
      status: "proposed",
      eventRevision: request.eventRevision,
    };
    tasks.set(task.taskId, task);
    return { ok: true, task };
  }

  /** Assignee approves/rejects a proposed task (Req 2.2). */
  respond(request: RespondTaskRequest): TaskResult {
    const task = this.tasksFor(request.session).get(request.taskId);
    if (task === undefined) {
      return notFound();
    }
    if (task.assignee.memberId !== request.requester.memberId) {
      return unauthorized("Only the assignee may respond to a task.");
    }
    if (task.status !== "proposed") {
      return invalidTransition(
        `Cannot respond to a task in status '${task.status}'.`,
      );
    }
    task.status = request.accept ? "accepted" : "rejected";
    task.eventRevision = request.eventRevision;
    return { ok: true, task };
  }

  /** Assignee advances an accepted task to in_progress/done (Req 2.3). */
  progress(request: ProgressTaskRequest): TaskResult {
    const task = this.tasksFor(request.session).get(request.taskId);
    if (task === undefined) {
      return notFound();
    }
    if (task.assignee.memberId !== request.requester.memberId) {
      return unauthorized("Only the assignee may report task progress.");
    }
    if (task.status !== "accepted" && task.status !== "in_progress") {
      return invalidTransition(
        `Cannot report progress on a task in status '${task.status}'.`,
      );
    }
    task.status = request.status;
    task.eventRevision = request.eventRevision;
    return { ok: true, task };
  }

  /** Assigner or assignee withdraws a non-terminal task (Req 2.2). */
  withdraw(request: WithdrawTaskRequest): TaskResult {
    const task = this.tasksFor(request.session).get(request.taskId);
    if (task === undefined) {
      return notFound();
    }
    const requesterId = request.requester.memberId;
    if (
      task.assigner.memberId !== requesterId &&
      task.assignee.memberId !== requesterId
    ) {
      return unauthorized(
        "Only the assigner or assignee may withdraw a task.",
      );
    }
    if (
      task.status === "done" ||
      task.status === "withdrawn" ||
      task.status === "rejected"
    ) {
      return invalidTransition(
        `Cannot withdraw a task in status '${task.status}'.`,
      );
    }
    task.status = "withdrawn";
    task.eventRevision = request.eventRevision;
    return { ok: true, task };
  }

  /**
   * Insert or replace a task by `taskId` — the agent-side application of a host
   * `task.update` broadcast. Idempotent; keeps the latest authoritative state.
   */
  upsert(session: SessionId, task: TaskDto): void {
    this.tasksFor(session).set(task.taskId, {
      ...task,
      assignee: { ...task.assignee },
      assigner: { ...task.assigner },
    });
  }

  /** A single task by id, or `undefined`. */
  get(session: SessionId, taskId: string): TaskDto | undefined {
    const task = this.sessions.get(sessionKey(session))?.get(taskId);
    return task === undefined ? undefined : { ...task };
  }

  /**
   * The Task_List for `memberId` — tasks assigned to it that it has accepted
   * (`accepted`/`in_progress`/`done`). Proposed tasks are incoming approvals and
   * are excluded (see {@link incomingProposalsFor}).
   */
  taskListFor(session: SessionId, memberId: string): TaskDto[] {
    return this.filterTasks(
      session,
      (task) =>
        task.assignee.memberId === memberId &&
        (task.status === "accepted" ||
          task.status === "in_progress" ||
          task.status === "done"),
    );
  }

  /** Proposed tasks addressed to `memberId` awaiting its approval (Req 2.2). */
  incomingProposalsFor(session: SessionId, memberId: string): TaskDto[] {
    return this.filterTasks(
      session,
      (task) =>
        task.assignee.memberId === memberId && task.status === "proposed",
    );
  }

  /** Every task recorded for a session, ordered by `eventRevision`. */
  allTasks(session: SessionId): TaskDto[] {
    return this.filterTasks(session, () => true);
  }

  private filterTasks(
    session: SessionId,
    predicate: (task: TaskDto) => boolean,
  ): TaskDto[] {
    const tasks = this.sessions.get(sessionKey(session));
    if (tasks === undefined) {
      return [];
    }
    return [...tasks.values()]
      .filter(predicate)
      .map((task) => ({ ...task }))
      .sort((a, b) => a.eventRevision - b.eventRevision);
  }

  /**
   * Replace a session's entire task state with a persisted set (restart /
   * sync-snapshot restore). Existing state for the session is discarded and each
   * task is deep-copied so the registry never aliases the caller's snapshot.
   */
  restore(session: SessionId, tasks: readonly TaskDto[]): void {
    const map = new Map<string, TaskDto>();
    for (const task of tasks) {
      map.set(task.taskId, {
        ...task,
        assignee: { ...task.assignee },
        assigner: { ...task.assigner },
      });
    }
    this.sessions.set(sessionKey(session), map);
  }
}

function notFound(): TaskResult {
  return { ok: false, code: "NOT_FOUND", reason: "Unknown task." };
}

function unauthorized(reason: string): TaskResult {
  return { ok: false, code: "AUTH_NOT_AUTHORIZED", reason };
}

function invalidTransition(reason: string): TaskResult {
  return { ok: false, code: "FORMAT_ERROR", reason };
}
