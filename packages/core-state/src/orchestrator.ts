/**
 * Luna orchestrator brain — deterministic task routing, conflict arbitration,
 * cross-agent answering, and team summaries (V2 Phase 4; Req 4.1–4.4;
 * idea.md §5 "Luna").
 *
 * {@link LunaBrain} is the pluggable decision component behind Luna. The default
 * {@link RulesLunaBrain} is fully deterministic and requires no external service
 * — it selects a suitable assignee from liveness + current load, states the
 * mechanical arbitration outcome, and produces plain-language answers/summaries
 * from the coordination state it can see. An optional {@link LlmLunaBrain}
 * (task 4.3) may be injected to enrich the natural-language text, but it is
 * never used unless explicitly configured, so the build/tests stay key-free
 * (Req 4.1.3).
 *
 * Luna only routes/assigns work a human directs; it never autonomously carves a
 * feature into subtasks (idea.md §9), and it never overrides V1's
 * earliest-Event_Revision resolution — arbitration only communicates the
 * deterministic outcome for cases the mechanical rule leaves ambiguous (Req 4.3).
 */

import type {
  LivenessState,
  LunaAction,
  LunaRequestDto,
  MemberRef,
  SessionId,
  TaskDto,
} from "@cfls/protocol";

/** The coordination context Luna decides against (Req 4.2–4.4). */
export interface LunaContext {
  session: SessionId;
  /** The member who directed Luna. */
  requester: MemberRef;
  /** Known member ids in the session. */
  members: string[];
  /** Current liveness per member (used to prefer available assignees). */
  liveness: { memberId: string; state: LivenessState }[];
  /** Current tasks (used to prefer the least-busy assignee). */
  tasks: TaskDto[];
}

/** An assignment Luna proposes (a human still approves it downstream, Req 4.2). */
export interface LunaAssignment {
  assigneeMemberId: string;
  title: string;
  description: string;
}

/** A message Luna wants sent (an answer, or an arbitration notice). */
export interface LunaMessagePlan {
  /** Recipient; omitted for a broadcast to the whole team. */
  toMemberId?: string;
  body: string;
}

/** Luna's structured decision (Req 4.2–4.4). */
export interface LunaDecision {
  action: LunaAction;
  /** Plain-language result. */
  summary: string;
  /** Present for `assign`. */
  assignment?: LunaAssignment;
  /** Present for `answer`/`arbitrate` when Luna communicates via a message. */
  message?: LunaMessagePlan;
}

/** The pluggable Luna decision component (Req 4.1). */
export interface LunaBrain {
  decide(
    request: LunaRequestDto,
    context: LunaContext,
  ): LunaDecision | Promise<LunaDecision>;
}

const STATE_RANK: Record<LivenessState, number> = {
  active: 0,
  idle: 1,
  gone: 2,
};

/** A short title derived from a prompt (first line, capped). */
function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const capped = firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
  return capped.length > 0 ? capped : "Task";
}

/** Whether `prompt` mentions `memberId` as a whole word (case-insensitive). */
function promptMentions(prompt: string, memberId: string): boolean {
  if (memberId.length === 0) return false;
  const escaped = memberId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(
    prompt,
  );
}

/**
 * The default, deterministic Luna brain (Req 4.1–4.4). No I/O, no randomness:
 * the same request + context always yields the same decision.
 */
export class RulesLunaBrain implements LunaBrain {
  decide(request: LunaRequestDto, context: LunaContext): LunaDecision {
    switch (request.action) {
      case "assign":
        return this.assign(request, context);
      case "arbitrate":
        return this.arbitrate(request, context);
      case "answer":
        return this.answer(request, context);
      case "summarize":
        return this.summarize(context);
    }
  }

  /** Choose a suitable assignee and propose a task (Req 4.2). */
  private assign(request: LunaRequestDto, context: LunaContext): LunaDecision {
    const assignee = this.chooseAssignee(request.prompt, context);
    const title = titleFromPrompt(request.prompt);
    if (assignee === undefined) {
      return {
        action: "assign",
        summary: "No suitable teammate is available to take this task.",
      };
    }
    return {
      action: "assign",
      summary: `Assigning "${title}" to ${assignee}.`,
      assignment: {
        assigneeMemberId: assignee,
        title,
        description: request.prompt,
      },
    };
  }

  /**
   * Pick the assignee: an explicitly named member wins; otherwise the least-busy
   * available member other than the requester (fewest active tasks, preferring
   * active over idle over gone, breaking ties by memberId).
   */
  private chooseAssignee(
    prompt: string,
    context: LunaContext,
  ): string | undefined {
    const mentioned = context.members.find(
      (m) => m !== context.requester.memberId && promptMentions(prompt, m),
    );
    if (mentioned !== undefined) {
      return mentioned;
    }
    const stateOf = (memberId: string): LivenessState =>
      context.liveness.find((l) => l.memberId === memberId)?.state ?? "idle";
    const activeTaskCount = (memberId: string): number =>
      context.tasks.filter(
        (t) =>
          t.assignee.memberId === memberId &&
          (t.status === "accepted" || t.status === "in_progress"),
      ).length;

    const candidates = context.members.filter(
      (m) => m !== context.requester.memberId,
    );
    if (candidates.length === 0) {
      return undefined;
    }
    return [...candidates].sort((a, b) => {
      const stateDiff = STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)];
      if (stateDiff !== 0) return stateDiff;
      const loadDiff = activeTaskCount(a) - activeTaskCount(b);
      if (loadDiff !== 0) return loadDiff;
      return a.localeCompare(b);
    })[0];
  }

  /** Communicate the deterministic arbitration outcome (Req 4.3). */
  private arbitrate(
    request: LunaRequestDto,
    _context: LunaContext,
  ): LunaDecision {
    const scope = request.refId ?? "the contested item";
    const body =
      `Coordination decision for ${scope}: the earliest accepted change wins ` +
      `(by Event_Revision); if truly tied, the lower member id proceeds and the ` +
      `other coordinates before continuing.`;
    return {
      action: "arbitrate",
      summary: body,
      message: { body },
    };
  }

  /** Answer a cross-agent question from the visible coordination state (Req 4.4). */
  private answer(request: LunaRequestDto, context: LunaContext): LunaDecision {
    const body = `Luna: ${this.teamSummary(context)}`;
    const message: LunaMessagePlan = { body };
    // Reply to the asker when the request references one; else broadcast.
    if (request.refId !== undefined && request.refId.length > 0) {
      message.toMemberId = context.requester.memberId;
    }
    return { action: "answer", summary: body, message };
  }

  /** Summarize the live team state in plain language (Req 4.4). */
  private summarize(context: LunaContext): LunaDecision {
    return { action: "summarize", summary: this.teamSummary(context) };
  }

  /** A deterministic plain-language description of the current team state. */
  private teamSummary(context: LunaContext): string {
    const active = context.liveness
      .filter((l) => l.state === "active")
      .map((l) => l.memberId)
      .sort((a, b) => a.localeCompare(b));
    const idle = context.liveness
      .filter((l) => l.state === "idle")
      .map((l) => l.memberId)
      .sort((a, b) => a.localeCompare(b));
    const openTasks = context.tasks.filter(
      (t) => t.status === "accepted" || t.status === "in_progress",
    ).length;
    const parts: string[] = [];
    parts.push(
      active.length > 0 ? `Active: ${active.join(", ")}.` : "No one is active.",
    );
    if (idle.length > 0) {
      parts.push(`Idle: ${idle.join(", ")}.`);
    }
    parts.push(
      openTasks === 1 ? `1 task in progress.` : `${openTasks} tasks in progress.`,
    );
    return parts.join(" ");
  }
}

/** A completion function an {@link LlmLunaBrain} calls to enrich text (optional). */
export type LlmCompletion = (prompt: string) => Promise<string>;

/**
 * An optional LLM-backed Luna brain (task 4.3; Req 4.1.3). It reuses the
 * deterministic {@link RulesLunaBrain} for every *structural* decision (who to
 * assign, the arbitration rule) — so behavior stays safe and predictable — and
 * only asks the injected {@link LlmCompletion} to rephrase the natural-language
 * `summary`/answer text. It is inert unless a completion function is supplied,
 * and is never instantiated by the default host wiring, keeping the build and
 * tests free of any external service (Req 4.1.3, 4.1.4).
 */
export class LlmLunaBrain implements LunaBrain {
  private readonly rules = new RulesLunaBrain();

  constructor(private readonly complete: LlmCompletion) {}

  async decide(
    request: LunaRequestDto,
    context: LunaContext,
  ): Promise<LunaDecision> {
    const base = this.rules.decide(request, context);
    try {
      const enriched = await this.complete(
        `Rephrase concisely for a dev team. Action: ${request.action}. ` +
          `Prompt: ${request.prompt}. Draft: ${base.summary}`,
      );
      const summary = enriched.trim().length > 0 ? enriched.trim() : base.summary;
      return {
        ...base,
        summary,
        ...(base.message !== undefined
          ? { message: { ...base.message, body: summary } }
          : {}),
      };
    } catch {
      // On any LLM failure, fall back to the deterministic decision (Req 4.1.4).
      return base;
    }
  }
}
