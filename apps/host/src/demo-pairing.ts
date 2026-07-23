/**
 * Short-code enrollment for a deliberately open demonstration relay.
 *
 * This is not an alternate authentication scheme: it only mints ordinary,
 * device-bound Signed_Invitations using the relay's existing admin key. It is
 * disabled unless the host is launched with an explicit DemoPairingConfig.
 */

import { randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionId } from "@cfls/protocol";
import { issueInvitation } from "@cfls/security";

import type { CoordinationAuthority } from "./authority";
import type { DemoPairingConfig } from "./config";

interface PendingCode {
  expiresAt: number;
  session: SessionId;
}

interface PairRequest {
  devicePublicKey: string;
  memberId: string;
}

const MAX_BODY_BYTES = 8_192;
const CODE_PATTERN = /^\d{8}$/u;
const MEMBER_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/u;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/=]{40,200}$/u;

/** Handles only /demo-pair/host and /demo-pair/join; all state is ephemeral. */
export class DemoPairingEndpoint {
  private readonly pendingCodes = new Map<string, PendingCode>();
  private readonly attemptsByIp = new Map<
    string,
    { count: number; resetAt: number }
  >();

  public constructor(
    private readonly config: DemoPairingConfig,
    private readonly authority: CoordinationAuthority,
  ) {}

  matches(req: IncomingMessage): boolean {
    const pathname = (req.url ?? "").split("?", 1)[0];
    return pathname === "/demo-pair/host" || pathname === "/demo-pair/join";
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      this.send(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!this.allowAttempt(req.socket.remoteAddress ?? "unknown")) {
      this.send(res, 429, { error: "too_many_attempts" });
      return;
    }
    const parsed = await readJson(req);
    if (parsed === null || !isPairRequest(parsed)) {
      this.send(res, 400, { error: "invalid_request" });
      return;
    }
    this.pruneExpired();
    const pathname = (req.url ?? "").split("?", 1)[0];
    if (pathname === "/demo-pair/host") {
      const session = requestedSession(parsed.session, this.config.session);
      if (session === null) {
        this.send(res, 400, { error: "invalid_workspace_session" });
        return;
      }
      // Open demo enrollment supports any workspace. The invitation remains
      // device-bound and this exact session is registered before a client can
      // authenticate to the coordination host.
      this.authority.registerSession(session, [this.config.issuerPublicKey], {
        manualConfig: true,
      });
      const code = this.createCode();
      const expiresAt = Date.now() + (this.config.codeTtlMs ?? 10 * 60_000);
      this.pendingCodes.set(code, { expiresAt, session });
      this.send(res, 201, {
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        invitation: this.issue(parsed, session),
      });
      return;
    }
    const code = typeof parsed.code === "string" ? parsed.code.trim() : "";
    const pending = this.pendingCodes.get(code);
    // A code is consumed before invitation signing, so retries never create
    // multiple enrollment credentials from the same displayed code.
    this.pendingCodes.delete(code);
    if (
      !CODE_PATTERN.test(code) ||
      pending === undefined ||
      pending.expiresAt <= Date.now()
    ) {
      this.send(res, 404, { error: "invalid_or_expired_code" });
      return;
    }
    this.send(res, 201, { invitation: this.issue(parsed, pending.session) });
  }

  private issue(
    request: PairRequest,
    session: SessionId,
  ): ReturnType<typeof issueInvitation> {
    const expiresAt = new Date(
      Date.now() + (this.config.invitationTtlMs ?? 12 * 60 * 60_000),
    ).toISOString();
    return issueInvitation(
      {
        session,
        devicePublicKey: request.devicePublicKey,
        memberId: request.memberId.trim(),
        issuerPublicKey: this.config.issuerPublicKey,
        expiresAt,
      },
      this.config.issuerPrivateKey,
    );
  }

  private createCode(): string {
    // Collisions are vanishingly unlikely, but retrying keeps every pending code
    // one-to-one even under concurrent host setup.
    for (let i = 0; i < 10; i += 1) {
      const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
      if (!this.pendingCodes.has(code)) return code;
    }
    throw new Error("Could not allocate a demo pairing code.");
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [code, pending] of this.pendingCodes) {
      if (pending.expiresAt <= now) this.pendingCodes.delete(code);
    }
  }

  private allowAttempt(ip: string): boolean {
    const now = Date.now();
    const current = this.attemptsByIp.get(ip);
    if (current === undefined || current.resetAt <= now) {
      this.attemptsByIp.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    current.count += 1;
    return current.count <= 30;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  }
}

function isPairRequest(
  value: unknown,
): value is PairRequest & { code?: unknown; session?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.devicePublicKey === "string" &&
    PUBLIC_KEY_PATTERN.test(request.devicePublicKey) &&
    typeof request.memberId === "string" &&
    MEMBER_PATTERN.test(request.memberId.trim())
  );
}

/** Keep the relay's configured team while accepting any local repository. */
function requestedSession(
  value: unknown,
  relaySession: SessionId,
): SessionId | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const repoId = safeSessionPart(source.repoId, 512);
  const branch = safeSessionPart(source.branch, 256);
  const baseRevision = source.baseRevision;
  if (
    repoId === null ||
    branch === null ||
    (baseRevision !== null &&
      (typeof baseRevision !== "string" ||
        baseRevision.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(baseRevision)))
  ) {
    return null;
  }
  return {
    repoId,
    teamId: relaySession.teamId,
    branch,
    baseRevision,
  };
}

function safeSessionPart(value: unknown, maxLength: number): string | null {
  return typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

async function readJson(req: IncomingMessage): Promise<unknown | null> {
  let body = "";
  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
