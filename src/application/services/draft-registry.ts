import { normalizeKey } from "../../domain/index.js";

const DRAFT_TTL_MS = 30 * 60 * 1000;
const DRAFT_GC_INTERVAL_MS = 60 * 1000;

export interface DraftState {
  chatId: number;
  userId: number;
  memberIds: number[];
  page: number;
  groupKey?: string | undefined;
  awaitingName: boolean;
  updatedAt: number;
}

export class DraftRegistry {
  private readonly drafts = new Map<string, DraftState>();
  private nextGcAt = 0;

  constructor(private readonly gcIntervalMs = DRAFT_GC_INTERVAL_MS) {}

  create(chatId: number, userId: number, memberIds: number[] = [], groupKey?: string): DraftState {
    const now = Date.now();

    this.gc(now);

    const draft: DraftState = {
      chatId,
      userId,
      memberIds: [...new Set(memberIds)],
      page: 0,
      groupKey,
      awaitingName: false,
      updatedAt: now,
    };

    this.drafts.set(this.key(chatId, userId), draft);

    return draft;
  }

  get(chatId: number, userId: number): DraftState | null {
    const now = Date.now();

    this.gc(now);

    const draft = this.getActiveDraft(chatId, userId, now);

    if (!draft) {
      return null;
    }

    draft.updatedAt = now;
    return draft;
  }

  toggle(
    chatId: number,
    userId: number,
    memberId: number,
    availableIds: Set<number>,
  ): DraftState | null {
    const now = Date.now();

    this.gc(now);

    const draft = this.getActiveDraft(chatId, userId, now);

    if (!draft || !availableIds.has(memberId)) {
      if (draft) {
        draft.updatedAt = now;
      }

      return null;
    }

    const selected = new Set(draft.memberIds);

    if (selected.has(memberId)) {
      selected.delete(memberId);
    } else {
      selected.add(memberId);
    }

    draft.memberIds = [...selected];
    draft.updatedAt = now;

    return draft;
  }

  setPage(chatId: number, userId: number, page: number): DraftState | null {
    const now = Date.now();

    this.gc(now);

    const draft = this.getActiveDraft(chatId, userId, now);

    if (!draft) {
      return null;
    }

    draft.page = Math.max(0, page);
    draft.updatedAt = now;

    return draft;
  }

  setGroupKey(chatId: number, userId: number, groupKey: string): DraftState | null {
    const normalized = normalizeKey(groupKey);
    const now = Date.now();

    this.gc(now);

    const draft = this.getActiveDraft(chatId, userId, now);

    if (!draft || !normalized) {
      if (draft) {
        draft.updatedAt = now;
      }

      return null;
    }

    draft.groupKey = normalized;
    draft.awaitingName = false;
    draft.updatedAt = now;

    return draft;
  }

  promptForName(chatId: number, userId: number): DraftState | null {
    const now = Date.now();

    this.gc(now);

    const draft = this.getActiveDraft(chatId, userId, now);

    if (!draft) {
      return null;
    }

    draft.awaitingName = true;
    draft.updatedAt = now;

    return draft;
  }

  clear(chatId: number, userId: number): void {
    this.drafts.delete(this.key(chatId, userId));
  }

  private getActiveDraft(chatId: number, userId: number, now: number): DraftState | null {
    const key = this.key(chatId, userId);
    const draft = this.drafts.get(key);

    if (!draft) {
      return null;
    }

    if (this.isExpired(draft, now)) {
      this.drafts.delete(key);
      return null;
    }

    return draft;
  }

  private isExpired(draft: DraftState, now: number): boolean {
    return now - draft.updatedAt > DRAFT_TTL_MS;
  }

  private gc(now: number): void {
    if (now < this.nextGcAt) {
      return;
    }

    this.nextGcAt = now + this.gcIntervalMs;

    for (const [key, draft] of this.drafts.entries()) {
      if (this.isExpired(draft, now)) {
        this.drafts.delete(key);
      }
    }
  }

  private key(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }
}
