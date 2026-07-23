/**
 * @cfls/mcp-server — the strictly-local Local_MCP_Server built on
 * `@modelcontextprotocol/sdk`, exposing the 13 coordination tools wired to the
 * core-state engine through the CoordinationAgent (design §3.4; Req 4.1–4.8).
 *
 * Public surface:
 *   - {@link createMcpServer} / {@link registerTools} — build the server and
 *     register the 13 tools against an {@link AgentPort}.
 *   - {@link McpEnvelope} and helpers — the common connection/staleness response
 *     envelope carried by every tool response (Req 4.7, 33.2).
 *   - {@link AgentPort} and its request/response DTOs — the clean port the
 *     CoordinationAgent implements (Task 9).
 *   - {@link CoreStateAgentPort} — an in-memory, core-state-backed reference
 *     implementation of the port (used by tests).
 */

export const PACKAGE_NAME = "@cfls/mcp-server";

// ---- Server + tools (task 7.1, 7.2; design §3.4) ----
export {
  createMcpServer,
  MCP_SERVER_INFO,
  type CreateMcpServerOptions,
} from "./server";
export {
  COORDINATION_UPDATE_LOGGER,
  COORDINATION_UPDATE_NOTIFICATION_TYPE,
  registerTools,
  TOOL_NAMES,
  type CoordinationUpdateNotificationData,
  type ToolName,
} from "./tools";

// ---- Common response envelope + error mapping (task 7.1; Req 4.7, 33.2) ----
export {
  makeEnvelope,
  mapToolErrorCode,
  offlineQueuedResult,
} from "./envelope";
export type {
  AgentResult,
  ConnectionSnapshot,
  EnvelopeError,
  McpEnvelope,
  StalenessSnapshot,
  ToolErrorAlias,
} from "./envelope";

// ---- Agent-facing port + DTOs (task 7.2; design §3.4) ----
export type {
  AcquireLockData,
  AcquireLockRequest,
  AgentPort,
  ConnectionStatusData,
  DeclareIntentData,
  DeclareIntentRequest,
  DependencyImpact,
  GetDependenciesData,
  GetDependenciesRequest,
  GetDependencyImpactData,
  GetDependencyImpactRequest,
  GetDependentsData,
  GetDependentsRequest,
  GetRiskMapData,
  GetRiskMapRequest,
  GetTeamStatusData,
  GetTeamStatusRequest,
  MaybePromise,
  ProjectSessionStatusData,
  ReleaseLockData,
  ReleaseLockRequest,
  RiskContributor,
  RiskEdge,
  RiskExplanation,
  RiskPathEntry,
  SessionRef,
  SubscribeData,
  SubscribeRequest,
  UpdateIntentData,
  UpdateIntentRequest,
  WithdrawIntentData,
  WithdrawIntentRequest,
  TeamActivityFile,
  TeamActivityTask,
  TeamMemberActivity,
  SendMessageRequest,
  SendMessageData,
  ListMessagesRequest,
  ListMessagesData,
  MarkMessageReadRequest,
  MarkMessageReadData,
  ListOpenQuestionsRequest,
  ListOpenQuestionsData,
  AssignTaskRequest,
  AssignTaskData,
  RespondTaskRequest,
  RespondTaskData,
  UpdateTaskProgressRequest,
  UpdateTaskProgressData,
  ListTasksRequest,
  ListTasksData,
  GetLivenessRequest,
  GetLivenessData,
  WakeRequest,
  WakeData,
  GetNotificationsRequest,
  GetNotificationsData,
  AskLunaRequest,
  AskLunaData,
  ShareDiffRequest,
  ShareDiffData,
  ListDiffsRequest,
  ListDiffsData,
} from "./port";

// ---- Reference in-memory port backed by core-state (tests) ----
export { CoreStateAgentPort, type CoreStateAgentOptions } from "./fake-agent";
