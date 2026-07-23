/**
 * Local_API request dispatch (task 9.2, 9.3): maps a tool/method name + params
 * onto the {@link AgentPort} and wraps the result in the common
 * {@link McpEnvelope} (connection + staleness on every response — Req 4.7,
 * 33.2). The embedded Local_MCP_Server and the Editor_Extension both reach the
 * agent through this one dispatch, over the same shared view (Req 31.1).
 */

import {
  makeEnvelope,
  type AgentPort,
  type McpEnvelope,
} from "@cfls/mcp-server";
import type {
  LunaAction,
  MessageKind,
  MessagePriority,
  ScopeKind,
  SessionId,
} from "@cfls/protocol";

/** The set of dispatchable Local_API method names (mirrors the 13 MCP tools). */
export const LOCAL_API_METHODS = [
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
  "get_connection_status",
  "get_project_session_status",
  "send_message",
  "list_messages",
  "mark_message_read",
  "ask_question",
  "answer_question",
  "list_open_questions",
  "assign_task",
  "respond_to_task",
  "update_task_progress",
  "list_tasks",
  "get_liveness",
  "wake_member",
  "get_notifications",
  "ask_luna",
  "share_diff",
  "list_diffs",
] as const;

export type LocalApiMethod = (typeof LOCAL_API_METHODS)[number];

/** A loosely-typed params bag arriving over the loopback transport. */
type Params = Record<string, unknown>;

/**
 * Dispatch a Local_API request to the port and wrap the result in an
 * {@link McpEnvelope}. Unknown methods resolve to a `FORMAT_ERROR` envelope
 * rather than throwing, so a misbehaving local client cannot crash the agent.
 */
export async function dispatchLocalRequest(
  port: AgentPort,
  method: string,
  params: unknown,
): Promise<McpEnvelope<unknown>> {
  const p = (params ?? {}) as Params;
  const wrap = <T>(result: T | Promise<T>): Promise<McpEnvelope<unknown>> =>
    Promise.resolve(result).then((r) =>
      makeEnvelope(port.getConnection(), port.getStaleness(), r as never),
    );

  switch (method) {
    case "get_risk_map":
      return wrap(port.getRiskMap({ session: p.session as SessionId }));
    case "get_team_status":
      return wrap(port.getTeamStatus({ session: p.session as SessionId }));
    case "get_dependency_impact":
      return wrap(
        port.getDependencyImpact({ paths: (p.paths as string[]) ?? [] }),
      );
    case "get_dependencies":
      return wrap(port.getDependencies({ path: p.path as string }));
    case "get_dependents":
      return wrap(port.getDependents({ path: p.path as string }));
    case "declare_intent":
      return wrap(
        port.declareIntent({
          session: p.session as SessionId,
          modifyPaths: (p.modifyPaths as string[]) ?? [],
          createPaths: (p.createPaths as string[]) ?? [],
          description: (p.description as string) ?? "",
          ...(p.scopeKind !== undefined
            ? { scopeKind: p.scopeKind as ScopeKind }
            : {}),
        }),
      );
    case "update_intent":
      return wrap(
        port.updateIntent({
          intentId: p.intentId as string,
          modifyPaths: (p.modifyPaths as string[]) ?? [],
          createPaths: (p.createPaths as string[]) ?? [],
          description: (p.description as string) ?? "",
        }),
      );
    case "withdraw_intent":
      return wrap(port.withdrawIntent({ intentId: p.intentId as string }));
    case "acquire_lock":
      return wrap(
        port.acquireLock({
          session: p.session as SessionId,
          scope: p.scope as string,
          scopeKind: p.scopeKind as ScopeKind,
        }),
      );
    case "release_lock":
      return wrap(
        port.releaseLock({
          ...(p.lockId !== undefined ? { lockId: p.lockId as string } : {}),
          ...(p.scope !== undefined ? { scope: p.scope as string } : {}),
        }),
      );
    case "get_connection_status":
      return wrap(port.getConnectionStatus());
    case "get_project_session_status":
      return wrap(port.getProjectSessionStatus());
    case "send_message":
      return wrap(
        port.sendMessage({
          session: p.session as SessionId,
          kind: (p.kind as MessageKind) ?? "direct",
          ...(p.toMemberId !== undefined
            ? { toMemberId: p.toMemberId as string }
            : {}),
          ...(p.priority !== undefined
            ? { priority: p.priority as MessagePriority }
            : {}),
          body: (p.body as string) ?? "",
          ...(p.correlationId !== undefined
            ? { correlationId: p.correlationId as string }
            : {}),
        }),
      );
    case "list_messages":
      return wrap(port.listMessages({ session: p.session as SessionId }));
    case "mark_message_read":
      return wrap(port.markMessageRead({ messageId: p.messageId as string }));
    case "ask_question":
      return wrap(
        port.sendMessage({
          session: p.session as SessionId,
          kind: "question",
          ...(p.toMemberId !== undefined
            ? { toMemberId: p.toMemberId as string }
            : {}),
          ...(p.priority !== undefined
            ? { priority: p.priority as MessagePriority }
            : {}),
          body: (p.body as string) ?? "",
          ...(p.correlationId !== undefined
            ? { correlationId: p.correlationId as string }
            : {}),
        }),
      );
    case "answer_question":
      return wrap(
        port.sendMessage({
          session: p.session as SessionId,
          kind: "answer",
          ...(p.toMemberId !== undefined
            ? { toMemberId: p.toMemberId as string }
            : {}),
          ...(p.priority !== undefined
            ? { priority: p.priority as MessagePriority }
            : {}),
          body: (p.body as string) ?? "",
          ...(p.correlationId !== undefined
            ? { correlationId: p.correlationId as string }
            : {}),
        }),
      );
    case "list_open_questions":
      return wrap(port.listOpenQuestions({ session: p.session as SessionId }));
    case "assign_task":
      return wrap(
        port.assignTask({
          session: p.session as SessionId,
          title: (p.title as string) ?? "",
          description: (p.description as string) ?? "",
          assigneeMemberId: (p.assigneeMemberId as string) ?? "",
        }),
      );
    case "respond_to_task":
      return wrap(
        port.respondTask({
          taskId: p.taskId as string,
          accept: Boolean(p.accept),
        }),
      );
    case "update_task_progress":
      return wrap(
        port.updateTaskProgress({
          taskId: p.taskId as string,
          status: p.status as "in_progress" | "done",
        }),
      );
    case "list_tasks":
      return wrap(port.listTasks({ session: p.session as SessionId }));
    case "get_liveness":
      return wrap(port.getLiveness({ session: p.session as SessionId }));
    case "wake_member":
      return wrap(
        port.wake({
          session: p.session as SessionId,
          targetMemberId: (p.targetMemberId as string) ?? "",
          ...(p.reason !== undefined ? { reason: p.reason as string } : {}),
        }),
      );
    case "get_notifications":
      return wrap(port.getNotifications({ session: p.session as SessionId }));
    case "ask_luna":
      return wrap(
        port.askLuna({
          session: p.session as SessionId,
          action: p.action as LunaAction,
          prompt: (p.prompt as string) ?? "",
          ...(p.refId !== undefined ? { refId: p.refId as string } : {}),
        }),
      );
    case "share_diff":
      return wrap(
        port.shareDiff({
          session: p.session as SessionId,
          path: (p.path as string) ?? "",
          ...(p.patch !== undefined ? { patch: p.patch as string } : {}),
        }),
      );
    case "list_diffs":
      return wrap(port.listDiffs({ session: p.session as SessionId }));
    default:
      return wrap({
        ok: false,
        error: {
          code: "FORMAT_ERROR",
          message: `Unknown Local_API method '${method}'.`,
        },
      });
  }
}
