/**
 * Message registry — directed/broadcast messages, questions, answers, and
 * heads-ups between Team_Members/AI agents (V2 Phase 1; Req 1.1–1.4;
 * idea.md §6 Communication).
 *
 * The {@link MessageRegistry} is the pure, in-memory authority for the messaging
 * channel. Like the other core-state registries it is dependency-free (no I/O, no
 * clocks): the caller assigns the authoritative `eventRevision` (from the host's
 * monotonic counter) and `sentAt`, and the registry records them verbatim so the
 * per-session Event_Revision total order — never a raw client time — governs
 * ordering (Req 1.1).
 *
 * State is isolated per `Repository_Session` (keyed by the opaque
 * {@link sessionKey}) so unrelated repos/teams/branches never mix.
 *
 * ## Addressing (Req 1.1)
 * - `broadcast` / `heads_up` are addressed to every member of the session.
 * - `direct` / `question` / `answer` are addressed to exactly one `toMemberId`.
 *
 * ## Questions & answers (Req 1.3)
 * A `question` carries a `correlationId`; the matching `answer` references the
 * same `correlationId`. Appending an answer marks the correlated question
 * `answered`. {@link MessageRegistry.openQuestionsFor} returns a member's
 * still-unanswered questions (the "wait for the answer" surface).
 *
 * ## Delivery / read state (Req 1.4)
 * Per-recipient read state is tracked by `messageId`. A member's unread count
 * (see {@link MessageRegistry.unreadCountFor}) counts messages **addressed to**
 * that member that it has not read, and **excludes the member's own sent
 * messages** (Req 1.4). Delivery to offline members is handled upstream by the
 * V1 sync-from-revision path — this registry simply retains every message.
 */

import type {
  MemberRef,
  MessageDto,
  MessageKind,
  MessagePriority,
  SessionId,
} from "@cfls/protocol";

import { sessionKey } from "./session";

/** A request to append a message; `eventRevision`/`sentAt` are assigned by the caller. */
export interface AppendMessageInput {
  session: SessionId;
  /** Globally unique message id (typically the originating Event_ID). */
  messageId: string;
  kind: MessageKind;
  sender: MemberRef;
  /** Required for `direct`/`question`/`answer`; ignored for `broadcast`/`heads_up`. */
  toMemberId?: string;
  priority: MessagePriority;
  body: string;
  /** Correlation id for a `question`/`answer` (Req 1.3). */
  correlationId?: string;
  /** Authoritative Event_Revision assigned by the host (Req 1.1). */
  eventRevision: number;
  /** ISO-8601 send time (recorded verbatim; never used as a resolver). */
  sentAt: string;
}

/** Outcome of appending a message. */
export interface AppendMessageResult {
  /** The recorded message. */
  message: MessageDto;
  /**
   * When the appended message was an `answer` that matched an open question, the
   * question after being marked `answered` — so the caller can broadcast the
   * question's updated state.
   */
  answeredQuestion?: MessageDto;
}

/** Per-session messaging state. */
interface MessageState {
  /** All messages for the session, kept sorted by `eventRevision`. */
  messages: MessageDto[];
  /** `messageId` → set of memberIds that have read it. */
  read: Map<string, Set<string>>;
  /** `correlationId` → the question `messageId` awaiting an answer. */
  openQuestions: Map<string, string>;
}

/** Is `message` addressed to `memberId` (a recipient, not merely visible)? */
function isRecipient(message: MessageDto, memberId: string): boolean {
  if (message.kind === "broadcast" || message.kind === "heads_up") {
    return true;
  }
  return message.toMemberId === memberId;
}

/**
 * Pure in-memory registry of the messaging channel (Req 1.1–1.4).
 */
export class MessageRegistry {
  /** `session_key` → messaging state. */
  private readonly sessions = new Map<string, MessageState>();

  private stateFor(session: SessionId): MessageState {
    const key = sessionKey(session);
    let state = this.sessions.get(key);
    if (state === undefined) {
      state = { messages: [], read: new Map(), openQuestions: new Map() };
      this.sessions.set(key, state);
    }
    return state;
  }

  /**
   * Append a message (Req 1.1–1.3). Records the message verbatim with the
   * supplied Event_Revision, keeping the per-session list ordered by revision.
   * When the message is an `answer` whose `correlationId` matches an open
   * question, that question is marked `answered` and returned so the caller can
   * broadcast its updated state.
   */
  append(input: AppendMessageInput): AppendMessageResult {
    const state = this.stateFor(input.session);

    const message: MessageDto = {
      messageId: input.messageId,
      kind: input.kind,
      sender: { ...input.sender },
      ...(input.toMemberId !== undefined
        ? { toMemberId: input.toMemberId }
        : {}),
      priority: input.priority,
      body: input.body,
      ...(input.correlationId !== undefined
        ? { correlationId: input.correlationId }
        : {}),
      ...(input.kind === "question" ? { answered: false } : {}),
      eventRevision: input.eventRevision,
      sentAt: input.sentAt,
    };

    this.insertOrdered(state, message);

    if (message.kind === "question" && message.correlationId !== undefined) {
      state.openQuestions.set(message.correlationId, message.messageId);
    }

    let answeredQuestion: MessageDto | undefined;
    if (message.kind === "answer" && message.correlationId !== undefined) {
      const questionId = state.openQuestions.get(message.correlationId);
      if (questionId !== undefined) {
        const question = state.messages.find(
          (m) => m.messageId === questionId,
        );
        if (question !== undefined) {
          question.answered = true;
          answeredQuestion = question;
        }
        state.openQuestions.delete(message.correlationId);
      }
    }

    return answeredQuestion === undefined
      ? { message }
      : { message, answeredQuestion };
  }

  /** Insert `message` keeping `messages` sorted ascending by `eventRevision`. */
  private insertOrdered(state: MessageState, message: MessageDto): void {
    const list = state.messages;
    let i = list.length;
    while (i > 0 && list[i - 1]!.eventRevision > message.eventRevision) {
      i -= 1;
    }
    list.splice(i, 0, message);
  }

  /**
   * Mark a message read by `memberId` (Req 1.4). Only a recipient of the message
   * can mark it read; a non-recipient (or unknown message) is a no-op returning
   * `false`.
   */
  markRead(session: SessionId, messageId: string, memberId: string): boolean {
    const state = this.sessions.get(sessionKey(session));
    if (state === undefined) {
      return false;
    }
    const message = state.messages.find((m) => m.messageId === messageId);
    if (message === undefined || !isRecipient(message, memberId)) {
      return false;
    }
    let readers = state.read.get(messageId);
    if (readers === undefined) {
      readers = new Set();
      state.read.set(messageId, readers);
    }
    readers.add(memberId);
    return true;
  }

  /** Has `memberId` read the message `messageId`? */
  isRead(session: SessionId, messageId: string, memberId: string): boolean {
    return (
      this.sessions.get(sessionKey(session))?.read.get(messageId)?.has(memberId) ??
      false
    );
  }

  /**
   * Messages visible to `memberId`: every message it sent, plus every message
   * addressed to it (directed messages, broadcasts, and heads-ups). Ordered by
   * `eventRevision`.
   */
  messagesFor(session: SessionId, memberId: string): MessageDto[] {
    const state = this.sessions.get(sessionKey(session));
    if (state === undefined) {
      return [];
    }
    return state.messages.filter(
      (m) => m.sender.memberId === memberId || isRecipient(m, memberId),
    );
  }

  /**
   * The count of messages addressed to `memberId` that it has not yet read,
   * **excluding the member's own sent messages** (Req 1.4).
   */
  unreadCountFor(session: SessionId, memberId: string): number {
    const state = this.sessions.get(sessionKey(session));
    if (state === undefined) {
      return 0;
    }
    let count = 0;
    for (const message of state.messages) {
      if (message.sender.memberId === memberId) {
        continue; // never count your own messages (Req 1.4).
      }
      if (
        isRecipient(message, memberId) &&
        !(state.read.get(message.messageId)?.has(memberId) ?? false)
      ) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * The still-unanswered questions addressed to `memberId` (Req 1.3) — the
   * "wait for the answer" surface. Ordered by `eventRevision`.
   */
  openQuestionsFor(session: SessionId, memberId: string): MessageDto[] {
    const state = this.sessions.get(sessionKey(session));
    if (state === undefined) {
      return [];
    }
    return state.messages.filter(
      (m) =>
        m.kind === "question" &&
        m.answered !== true &&
        m.toMemberId === memberId,
    );
  }

  /**
   * Insert or replace a message by `messageId` — the agent-side application of a
   * host `message.update` broadcast (`op: added` inserts, `op: updated` replaces,
   * e.g. a question flipping to `answered`). Idempotent: re-applying the same
   * message id is a no-op beyond replacing its fields. Open-question tracking is
   * kept in sync.
   */
  upsert(session: SessionId, message: MessageDto): void {
    const state = this.stateFor(session);
    const copy: MessageDto = { ...message, sender: { ...message.sender } };
    const existingIndex = state.messages.findIndex(
      (m) => m.messageId === copy.messageId,
    );
    if (existingIndex >= 0) {
      state.messages[existingIndex] = copy;
    } else {
      this.insertOrdered(state, copy);
    }
    if (copy.kind === "question" && copy.correlationId !== undefined) {
      if (copy.answered === true) {
        state.openQuestions.delete(copy.correlationId);
      } else {
        state.openQuestions.set(copy.correlationId, copy.messageId);
      }
    }
  }

  /** Every message recorded for a session (ordered by `eventRevision`). */
  allMessages(session: SessionId): readonly MessageDto[] {
    return this.sessions.get(sessionKey(session))?.messages.slice() ?? [];
  }

  /**
   * Replace a session's entire message state with a persisted set (restart /
   * sync-snapshot restore). Existing state for the session is discarded; messages
   * are re-sorted by `eventRevision`, open questions are rederived from
   * unanswered questions, and read state is reset (read state is derived, not
   * part of the authoritative snapshot in Phase 1).
   */
  restore(session: SessionId, messages: readonly MessageDto[]): void {
    const state: MessageState = {
      messages: [],
      read: new Map(),
      openQuestions: new Map(),
    };
    this.sessions.set(sessionKey(session), state);
    for (const message of messages) {
      const copy: MessageDto = { ...message, sender: { ...message.sender } };
      this.insertOrdered(state, copy);
      if (
        copy.kind === "question" &&
        copy.answered !== true &&
        copy.correlationId !== undefined
      ) {
        state.openQuestions.set(copy.correlationId, copy.messageId);
      }
    }
  }
}
