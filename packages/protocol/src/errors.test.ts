/**
 * Unit tests for the protocol error-code catalog (design §11.1) and the
 * message-type catalog (design §4.3).
 *
 * Task 2.5 — asserts every `ErrorCode` is present in `ERROR_CODES`, that
 * `isErrorCode` narrows correctly, that `MessageType` constants map to their
 * expected wire strings, that `MESSAGE_TYPES` covers every catalog entry, and
 * that `isMessageType` guards correctly.
 *
 * _Requirements: 7.1, 11.1_
 */

import { describe, it, expect } from "vitest";

import { ERROR_CODES, isErrorCode, type ErrorCode } from "./errors";
import {
  AuthMessageType,
  PresenceMessageType,
  LockMessageType,
  IntentMessageType,
  DependencyMessageType,
  PathMessageType,
  HeartbeatMessageType,
  SyncMessageType,
  BroadcastMessageType,
  EventMessageType,
  MessagingMessageType,
  TaskMessageType,
  PresenceLivenessMessageType,
  LunaMessageType,
  DiffMessageType,
  ErrorMessageType,
  MessageType,
  MESSAGE_TYPES,
  isMessageType,
} from "./messages";

// The authoritative §11.1 catalog, spelled out here independently of the source
// so the test fails if the shipped catalog ever drifts from the design.
const EXPECTED_ERROR_CODES: ErrorCode[] = [
  "AUTH_INVALID_DEVICE",
  "AUTH_ISSUER_NOT_ADMIN",
  "AUTH_SESSION_FORBIDDEN",
  "AUTH_NOT_AUTHORIZED",
  "FORMAT_ERROR",
  "NOT_OWNER",
  "NOT_LOCK_HOLDER",
  "NO_ACTIVE_LOCK",
  "NOT_FOUND",
  "OVERRIDE_REASON_REQUIRED",
  "OFFLINE_QUEUED",
  "STORAGE_ERROR",
  "SECURE_STORAGE_UNAVAILABLE",
];

describe("ERROR_CODES catalog (design §11.1)", () => {
  it("contains exactly the expected error codes in catalog order", () => {
    expect([...ERROR_CODES]).toEqual(EXPECTED_ERROR_CODES);
  });

  it("includes every expected ErrorCode", () => {
    for (const code of EXPECTED_ERROR_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe("isErrorCode", () => {
  it("returns true for every code in ERROR_CODES", () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isErrorCode("NOT_A_CODE")).toBe(false);
    expect(isErrorCode("")).toBe(false);
    // The MCP-schema aliases are NOT canonical codes (see errors.ts reconciliation note).
    expect(isErrorCode("NOT_AUTHORIZED")).toBe(false);
    expect(isErrorCode("SESSION_NOT_FOUND")).toBe(false);
    expect(isErrorCode("OFFLINE")).toBe(false);
    // Case sensitivity: lowercase is not a valid code.
    expect(isErrorCode("format_error")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode({})).toBe(false);
    expect(isErrorCode(["FORMAT_ERROR"])).toBe(false);
  });
});

describe("MessageType constants map to expected wire strings (design §4.3)", () => {
  it("uses the exact dotted wire strings for each message type", () => {
    expect(AuthMessageType.HELLO).toBe("auth.hello");
    expect(AuthMessageType.CHALLENGE).toBe("auth.challenge");
    expect(AuthMessageType.RESPONSE).toBe("auth.response");
    expect(AuthMessageType.OK).toBe("auth.ok");
    expect(AuthMessageType.ERROR).toBe("auth.error");

    expect(PresenceMessageType.REPORT).toBe("presence.report");
    expect(PresenceMessageType.UPDATE).toBe("presence.update");

    expect(LockMessageType.ACQUIRE).toBe("lock.acquire");
    expect(LockMessageType.RELEASE).toBe("lock.release");
    expect(LockMessageType.OVERRIDE).toBe("lock.override");
    expect(LockMessageType.UPDATE).toBe("lock.update");
    expect(LockMessageType.CONFLICT).toBe("lock.conflict");

    expect(IntentMessageType.DECLARE).toBe("intent.declare");
    expect(IntentMessageType.UPDATE).toBe("intent.update");
    expect(IntentMessageType.WITHDRAW).toBe("intent.withdraw");
    expect(IntentMessageType.PROGRESS).toBe("intent.progress");
    expect(IntentMessageType.CONFLICT).toBe("intent.conflict");

    expect(DependencyMessageType.SNAPSHOT).toBe("dep.snapshot");
    expect(DependencyMessageType.DELTA).toBe("dep.delta");
    expect(DependencyMessageType.APPLIED).toBe("dep.applied");

    expect(PathMessageType.RENAMED).toBe("path.renamed");
    expect(PathMessageType.DELETED).toBe("path.deleted");
    expect(PathMessageType.FILE_CREATED).toBe("file.created");
    expect(PathMessageType.UPDATE).toBe("path.update");

    expect(HeartbeatMessageType.PING).toBe("heartbeat.ping");
    expect(HeartbeatMessageType.ACK).toBe("heartbeat.ack");

    expect(SyncMessageType.REQUEST).toBe("sync.request");
    expect(SyncMessageType.EVENTS).toBe("sync.events");
    expect(SyncMessageType.SNAPSHOT).toBe("sync.snapshot");

    expect(BroadcastMessageType.UPDATE).toBe("coordination.update");
    expect(BroadcastMessageType.PARTICIPANTS).toBe("participants.update");

    expect(EventMessageType.EVENT_APPLIED).toBe("event.applied");

    expect(ErrorMessageType.ERROR).toBe("error");
  });

  it("references only wire strings that exist in the authoritative catalog", () => {
    // MessageType is a lossy, last-wins convenience map (shared key names such as
    // UPDATE collapse to a single value), so every value it does expose must at
    // least be a real catalog entry.
    for (const wire of Object.values(MessageType)) {
      expect(MESSAGE_TYPES).toContain(wire);
    }
  });
});

const ALL_GROUPS = [
  AuthMessageType,
  PresenceMessageType,
  LockMessageType,
  IntentMessageType,
  DependencyMessageType,
  PathMessageType,
  HeartbeatMessageType,
  SyncMessageType,
  BroadcastMessageType,
  EventMessageType,
  MessagingMessageType,
  TaskMessageType,
  PresenceLivenessMessageType,
  LunaMessageType,
  DiffMessageType,
  ErrorMessageType,
];

describe("MESSAGE_TYPES catalog", () => {
  it("includes every wire string from every message-type group (design §4.3)", () => {
    for (const group of ALL_GROUPS) {
      for (const wire of Object.values(group)) {
        expect(MESSAGE_TYPES).toContain(wire);
      }
    }
  });

  it("contains exactly the 48 catalog message types", () => {
    const expected = ALL_GROUPS.flatMap((group) => Object.values(group));
    expect([...MESSAGE_TYPES].sort()).toEqual([...expected].sort());
    expect(MESSAGE_TYPES.length).toBe(48);
  });

  it("has no duplicate entries", () => {
    expect(new Set(MESSAGE_TYPES).size).toBe(MESSAGE_TYPES.length);
  });
});

describe("isMessageType", () => {
  it("returns true for every catalog message type", () => {
    for (const type of MESSAGE_TYPES) {
      expect(isMessageType(type)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isMessageType("auth.unknown")).toBe(false);
    expect(isMessageType("presence")).toBe(false);
    expect(isMessageType("")).toBe(false);
    expect(isMessageType("AUTH.HELLO")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isMessageType(undefined)).toBe(false);
    expect(isMessageType(null)).toBe(false);
    expect(isMessageType(7)).toBe(false);
    expect(isMessageType({ type: "auth.hello" })).toBe(false);
  });
});
