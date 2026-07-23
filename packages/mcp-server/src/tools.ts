/**
 * The 13 Local_MCP_Server tools (design §3.4; Req 4.2), wired to the
 * CoordinationAgent exclusively through the {@link AgentPort}.
 *
 * Each tool: validates its arguments with a zod schema (mirroring the §3.4
 * request shapes), delegates to the injected {@link AgentPort}, then wraps the
 * result in the common {@link McpEnvelope} — stamping live connection + staleness
 * on every response (Req 4.7, 33.2). Every response is emitted as both MCP
 * `structuredContent` and a JSON text block so any AI_Agent client can consume it
 * programmatically (Req 4.7). Mutations attempted while offline surface as
 * `OFFLINE_QUEUED` through the port, never as false host acceptance (Req 4.8).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CoordinationUpdate } from "@cfls/protocol";
import { z } from "zod";

import type { AgentResult, McpEnvelope } from "./envelope";
import { makeEnvelope } from "./envelope";
import type {
  AgentPort,
  DeclareIntentRequest,
  ReleaseLockRequest,
  SendMessageRequest,
  SessionRef,
  SubscribeData,
} from "./port";

/** The exact set of tool names the Local_MCP_Server exposes (design §3.4; Req 4.2). */
export const TOOL_NAMES = [
  "get_risk_map",
  "get_team_status",
  "get_dependency_impact",
  "get_dependencies",
  "get_dependents",
  "declare_intent",
  "update_intent",
  "withdraw_intent",
  "acquire_lock",
  "release_lock",
  "subscribe_to_coordination_updates",
  "get_connection_status",
  "get_project_session_status",
  // V2 Phase 1 — messaging (Req 1.1–1.4).
  "send_message",
  "list_messages",
  "mark_message_read",
  "ask_question",
  "answer_question",
  "list_open_questions",
  // V2 Phase 2 — tasks (Req 2.1–2.3).
  "assign_task",
  "respond_to_task",
  "update_task_progress",
  "list_tasks",
  // V2 Phase 3 — liveness, notifications & wake (Req 3.1–3.3).
  "get_liveness",
  "wake_member",
  "get_notifications",
  // V2 Phase 4 — Luna orchestrator (Req 4.1–4.5).
  "ask_luna",
  // V2 Phase 5 — live diffs, opt-in (Req 5.1–5.5).
  "share_diff",
  "list_diffs",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The stable marker carried in MCP `notifications/message` data for a live
 * coordination update. MCP clients can register a standard logging-message
 * handler and narrow on this marker without parsing a human-readable string.
 */
export const COORDINATION_UPDATE_NOTIFICATION_TYPE =
  "cfls.coordination_update" as const;

/** The MCP logging channel used for live coordination-update notifications. */
export const COORDINATION_UPDATE_LOGGER = "cfls.coordination";

/** Structured payload emitted in a standard MCP `notifications/message` event. */
export interface CoordinationUpdateNotificationData {
  type: typeof COORDINATION_UPDATE_NOTIFICATION_TYPE;
  update: CoordinationUpdate;
}

// ---- Shared zod fragments -----------------------------------------------------

const sessionSchema = z.object({
  repoId: z.string(),
  teamId: z.string(),
  branch: z.string(),
  baseRevision: z.string().nullable(),
});

const scopeKindSchema = z.enum(["file", "folder", "glob"]);
const messagePrioritySchema = z.enum(["fyi", "normal", "urgent"]);
const messageKindSchema = z.enum([
  "direct",
  "broadcast",
  "question",
  "answer",
  "heads_up",
]);
const lunaActionSchema = z.enum([
  "assign",
  "arbitrate",
  "answer",
  "summarize",
]);

/** Serialise an envelope as both structured content and a JSON text block. */
function toToolResult<T>(envelope: McpEnvelope<T>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

/** Stamp connection/staleness and wrap a (possibly async) result in an envelope. */
async function respond<T>(
  port: AgentPort,
  result: AgentResult<T> | Promise<AgentResult<T>>,
): Promise<CallToolResult> {
  const resolved = await result;
  const envelope = makeEnvelope(
    port.getConnection(),
    port.getStaleness(),
    resolved,
  );
  return toToolResult(envelope);
}

/**
 * Register all 13 coordination tools on `server`, delegating to `port`.
 * Returns the same server for chaining.
 */
export function registerTools(server: McpServer, port: AgentPort): McpServer {
  // Keep one stable callback and one agent subscription per Repository_Session.
  // A caller may repeat the MCP tool call after reconnecting or retrying; that
  // must not multiply Local_API subscriptions or repeat every update.
  const subscriptions = new Map<string, Promise<AgentResult<SubscribeData>>>();
  const notifyCoordinationUpdate = (update: CoordinationUpdate): void => {
    const data: CoordinationUpdateNotificationData = {
      type: COORDINATION_UPDATE_NOTIFICATION_TYPE,
      update,
    };
    // `sendLoggingMessage` is the SDK's documented standard MCP
    // `notifications/message` path. A disconnected client must not be able to
    // disrupt the agent's update stream, so notification delivery is best effort.
    void server
      .sendLoggingMessage({
        level: "info",
        logger: COORDINATION_UPDATE_LOGGER,
        data,
      })
      .catch(() => undefined);
  };
  const subscribeOnce = (
    session: SessionRef,
  ): Promise<AgentResult<SubscribeData>> => {
    const key = subscriptionKey(session);
    const existing = subscriptions.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const subscription = Promise.resolve(
      port.subscribeToCoordinationUpdates(
        { session },
        notifyCoordinationUpdate,
      ),
    );
    subscriptions.set(key, subscription);
    void subscription.then(
      (result) => {
        // A failed registration is not durable: a later tool call may retry it.
        if (!result.ok && subscriptions.get(key) === subscription) {
          subscriptions.delete(key);
        }
      },
      () => {
        if (subscriptions.get(key) === subscription) {
          subscriptions.delete(key);
        }
      },
    );
    return subscription;
  };

  // 1. get_risk_map — Req 4.3, 24, 21, 22, 31.5
  server.registerTool(
    "get_risk_map",
    {
      description:
        "Return the machine-readable Risk_Map for a Repository_Session: per-path " +
        "risk levels, contributors, direct/indirect conflicts, and planned file creations.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.getRiskMap({ session: args.session })),
  );

  // 1b. get_team_status — a metadata-only member/activity projection.
  server.registerTool(
    "get_team_status",
    {
      description:
        "Return active team members, their declared tasks, files, locks, and " +
        "editing signals for a Repository_Session. This is coordination metadata, never source content.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.getTeamStatus({ session: args.session })),
  );

  // 2. get_dependency_impact — Req 23.1, 23.4, 23.5
  server.registerTool(
    "get_dependency_impact",
    {
      description:
        "Return metadata-only dependency impact (direct/reverse dependencies, " +
        "shared contracts, risk) for a set of repository-relative paths.",
      inputSchema: { paths: z.array(z.string()) },
    },
    (args) => respond(port, port.getDependencyImpact({ paths: args.paths })),
  );

  // 3. get_dependencies — Req 23.2
  server.registerTool(
    "get_dependencies",
    {
      description: "Return the paths a given path depends on (metadata only).",
      inputSchema: { path: z.string() },
    },
    (args) => respond(port, port.getDependencies({ path: args.path })),
  );

  // 4. get_dependents — Req 23.3
  server.registerTool(
    "get_dependents",
    {
      description:
        "Return the paths that depend on a given path (metadata only).",
      inputSchema: { path: z.string() },
    },
    (args) => respond(port, port.getDependents({ path: args.path })),
  );

  // 5. declare_intent — Req 4.4, 16.1–16.2, 16.5, 16.7
  server.registerTool(
    "declare_intent",
    {
      description:
        "Declare an intent to modify and/or create a set of paths; forwarded to " +
        "the CoordinationHost. Returns the recorded intent id and event revision.",
      inputSchema: {
        session: sessionSchema,
        modifyPaths: z.array(z.string()).default([]),
        createPaths: z.array(z.string()).default([]),
        description: z.string().default(""),
        scopeKind: scopeKindSchema.optional(),
      },
    },
    (args) => {
      const req: DeclareIntentRequest = {
        session: args.session,
        modifyPaths: args.modifyPaths,
        createPaths: args.createPaths,
        description: args.description,
      };
      if (args.scopeKind !== undefined) {
        req.scopeKind = args.scopeKind;
      }
      return respond(port, port.declareIntent(req));
    },
  );

  // 6. update_intent — Req 16.3, 16.8
  server.registerTool(
    "update_intent",
    {
      description:
        "Update an owned Declared_Intent's modify/create paths and description.",
      inputSchema: {
        intentId: z.string(),
        modifyPaths: z.array(z.string()).default([]),
        createPaths: z.array(z.string()).default([]),
        description: z.string().default(""),
      },
    },
    (args) =>
      respond(
        port,
        port.updateIntent({
          intentId: args.intentId,
          modifyPaths: args.modifyPaths,
          createPaths: args.createPaths,
          description: args.description,
        }),
      ),
  );

  // 7. withdraw_intent — Req 16.4, 16.8
  server.registerTool(
    "withdraw_intent",
    {
      description: "Withdraw an owned Declared_Intent.",
      inputSchema: { intentId: z.string() },
    },
    (args) => respond(port, port.withdrawIntent({ intentId: args.intentId })),
  );

  // 8. acquire_lock — Req 12.1–12.4, 32.1, 32.4
  server.registerTool(
    "acquire_lock",
    {
      description:
        "Acquire a coordination lock over a file/folder/glob scope. Reports the " +
        "winner and concurrent-claim status on contention.",
      inputSchema: {
        session: sessionSchema,
        scope: z.string(),
        scopeKind: scopeKindSchema,
      },
    },
    (args) =>
      respond(
        port,
        port.acquireLock({
          session: args.session,
          scope: args.scope,
          scopeKind: args.scopeKind,
        }),
      ),
  );

  // 9. release_lock — Req 12.5–12.8
  server.registerTool(
    "release_lock",
    {
      description: "Release a held lock by lock id or by scope.",
      inputSchema: {
        lockId: z.string().optional(),
        scope: z.string().optional(),
      },
    },
    (args) => {
      const req: ReleaseLockRequest = {};
      if (args.lockId !== undefined) {
        req.lockId = args.lockId;
      }
      if (args.scope !== undefined) {
        req.scope = args.scope;
      }
      return respond(port, port.releaseLock(req));
    },
  );

  // 10. subscribe_to_coordination_updates — Req 25.1, 25.5, 25.6
  server.registerTool(
    "subscribe_to_coordination_updates",
    {
      description:
        "Subscribe to Coordination_Updates for a Repository_Session. Returns a " +
        "subscription id. Each later update is sent as a standard MCP " +
        "notifications/message event with logger 'cfls.coordination' and " +
        "structured data { type: 'cfls.coordination_update', update }.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, subscribeOnce(args.session)),
  );

  // 11. get_connection_status — Req 4.6, 6.5, 27.4
  server.registerTool(
    "get_connection_status",
    {
      description:
        "Return the current CoordinationHost connectivity and participant lists.",
      inputSchema: {},
    },
    () => respond(port, port.getConnectionStatus()),
  );

  // 12. get_project_session_status — Req 4.6, 10
  server.registerTool(
    "get_project_session_status",
    {
      description:
        "Return the current Repository_Session identity and authorization status.",
      inputSchema: {},
    },
    () => respond(port, port.getProjectSessionStatus()),
  );

  // ---- V2 Phase 1 — messaging (Req 1.1–1.4) --------------------------------

  // 13. send_message
  server.registerTool(
    "send_message",
    {
      description:
        "Send a coordination message to a teammate (direct) or the whole team " +
        "(broadcast), or a heads-up. Team text only — never source content or secrets.",
      inputSchema: {
        session: sessionSchema,
        kind: messageKindSchema.default("direct"),
        toMemberId: z.string().optional(),
        priority: messagePrioritySchema.optional(),
        body: z.string(),
        correlationId: z.string().optional(),
      },
    },
    (args) => {
      const req: SendMessageRequest = {
        session: args.session,
        kind: args.kind,
        body: args.body,
      };
      if (args.toMemberId !== undefined) req.toMemberId = args.toMemberId;
      if (args.priority !== undefined) req.priority = args.priority;
      if (args.correlationId !== undefined)
        req.correlationId = args.correlationId;
      return respond(port, port.sendMessage(req));
    },
  );

  // 14. list_messages
  server.registerTool(
    "list_messages",
    {
      description:
        "List messages visible to this member (sent by or addressed to it) plus the unread count.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.listMessages({ session: args.session })),
  );

  // 15. mark_message_read
  server.registerTool(
    "mark_message_read",
    {
      description: "Mark a delivered message as read.",
      inputSchema: { messageId: z.string() },
    },
    (args) =>
      respond(port, port.markMessageRead({ messageId: args.messageId })),
  );

  // 16. ask_question — a message that expects a reply, correlated by id
  server.registerTool(
    "ask_question",
    {
      description:
        "Ask a teammate a question that expects a reply. Provide a correlationId " +
        "so the answer can be matched to this question.",
      inputSchema: {
        session: sessionSchema,
        toMemberId: z.string(),
        body: z.string(),
        correlationId: z.string(),
        priority: messagePrioritySchema.optional(),
      },
    },
    (args) => {
      const req: SendMessageRequest = {
        session: args.session,
        kind: "question",
        toMemberId: args.toMemberId,
        body: args.body,
        correlationId: args.correlationId,
      };
      if (args.priority !== undefined) req.priority = args.priority;
      return respond(port, port.sendMessage(req));
    },
  );

  // 17. answer_question — reply to a question by its correlationId
  server.registerTool(
    "answer_question",
    {
      description:
        "Answer a teammate's question, referencing the same correlationId as the question.",
      inputSchema: {
        session: sessionSchema,
        toMemberId: z.string(),
        body: z.string(),
        correlationId: z.string(),
        priority: messagePrioritySchema.optional(),
      },
    },
    (args) => {
      const req: SendMessageRequest = {
        session: args.session,
        kind: "answer",
        toMemberId: args.toMemberId,
        body: args.body,
        correlationId: args.correlationId,
      };
      if (args.priority !== undefined) req.priority = args.priority;
      return respond(port, port.sendMessage(req));
    },
  );

  // 18. list_open_questions
  server.registerTool(
    "list_open_questions",
    {
      description:
        "List unanswered questions addressed to this member (the 'wait for the answer' surface).",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.listOpenQuestions({ session: args.session })),
  );

  // ---- V2 Phase 2 — tasks (Req 2.1–2.3) ------------------------------------

  // 19. assign_task
  server.registerTool(
    "assign_task",
    {
      description:
        "Assign a task to a teammate (created as 'proposed' — the assignee must " +
        "approve it before it enters their task list). Title/description are team text.",
      inputSchema: {
        session: sessionSchema,
        title: z.string(),
        description: z.string().default(""),
        assigneeMemberId: z.string(),
      },
    },
    (args) =>
      respond(
        port,
        port.assignTask({
          session: args.session,
          title: args.title,
          description: args.description,
          assigneeMemberId: args.assigneeMemberId,
        }),
      ),
  );

  // 20. respond_to_task
  server.registerTool(
    "respond_to_task",
    {
      description:
        "Approve or reject an incoming proposed task. Only the assignee may respond.",
      inputSchema: { taskId: z.string(), accept: z.boolean() },
    },
    (args) =>
      respond(
        port,
        port.respondTask({ taskId: args.taskId, accept: args.accept }),
      ),
  );

  // 21. update_task_progress
  server.registerTool(
    "update_task_progress",
    {
      description:
        "Advance an accepted task to 'in_progress' or 'done'. Only the assignee may update progress.",
      inputSchema: {
        taskId: z.string(),
        status: z.enum(["in_progress", "done"]),
      },
    },
    (args) =>
      respond(
        port,
        port.updateTaskProgress({ taskId: args.taskId, status: args.status }),
      ),
  );

  // 22. list_tasks
  server.registerTool(
    "list_tasks",
    {
      description:
        "List all session tasks, plus this member's accepted task list and incoming proposals.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.listTasks({ session: args.session })),
  );

  // ---- V2 Phase 3 — liveness, notifications & wake (Req 3.1–3.3) -----------

  // 23. get_liveness
  server.registerTool(
    "get_liveness",
    {
      description:
        "Return each team member's liveness: active, idle, or gone (Req 3.1).",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.getLiveness({ session: args.session })),
  );

  // 24. wake_member
  server.registerTool(
    "wake_member",
    {
      description:
        "Ask an idle teammate to resume. Delivered at the target's next action, " +
        "never as a mid-turn interrupt.",
      inputSchema: {
        session: sessionSchema,
        targetMemberId: z.string(),
        reason: z.string().optional(),
      },
    },
    (args) =>
      respond(
        port,
        port.wake({
          session: args.session,
          targetMemberId: args.targetMemberId,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        }),
      ),
  );

  // 25. get_notifications
  server.registerTool(
    "get_notifications",
    {
      description:
        "Return this member's notifications (incoming tasks, questions, urgent " +
        "messages, wakes), with severity.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.getNotifications({ session: args.session })),
  );

  // ---- V2 Phase 4 — Luna orchestrator (Req 4.1–4.5) ------------------------

  // 26. ask_luna
  server.registerTool(
    "ask_luna",
    {
      description:
        "Ask Luna, the coordination orchestrator, to assign work, arbitrate an " +
        "ambiguous conflict, answer a cross-agent question, or summarize team " +
        "activity in plain language. The prompt is team text — never source content.",
      inputSchema: {
        session: sessionSchema,
        action: lunaActionSchema,
        prompt: z.string(),
        refId: z.string().optional(),
      },
    },
    (args) =>
      respond(
        port,
        port.askLuna({
          session: args.session,
          action: args.action,
          prompt: args.prompt,
          ...(args.refId !== undefined ? { refId: args.refId } : {}),
        }),
      ),
  );

  // ---- V2 Phase 5 — live diffs, opt-in (Req 5.1–5.5) -----------------------

  // 27. share_diff
  server.registerTool(
    "share_diff",
    {
      description:
        "Share your current change diff for a path with the team (opt-in; only " +
        "works when the team enabled liveDiffs). Omit patch to clear a shared " +
        "diff. This is the only tool that shares source-derived content.",
      inputSchema: {
        session: sessionSchema,
        path: z.string(),
        patch: z.string().optional(),
      },
    },
    (args) =>
      respond(
        port,
        port.shareDiff({
          session: args.session,
          path: args.path,
          ...(args.patch !== undefined ? { patch: args.patch } : {}),
        }),
      ),
  );

  // 28. list_diffs
  server.registerTool(
    "list_diffs",
    {
      description:
        "List the team's currently-shared Live_Diffs (read-only; empty unless " +
        "the team enabled liveDiffs). Never applied to your files automatically.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.listDiffs({ session: args.session })),
  );

  return server;
}

/** A lossless, stable key for deduplicating one subscription per session. */
function subscriptionKey(session: SessionRef): string {
  return JSON.stringify([
    session.repoId,
    session.teamId,
    session.branch,
    session.baseRevision,
  ]);
}
