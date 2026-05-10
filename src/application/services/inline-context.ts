import type { Clock } from "../ports/system.js";

const INLINE_CONTEXT_TTL_MS = 10 * 60 * 1000;
const INLINE_CONTEXT_GC_INTERVAL_MS = 60 * 1000;

export class InlineContextService {
  private readonly recentChats = new Map<number, { chatId: number; updatedAt: number }>();
  private nextGcAt = 0;

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs = INLINE_CONTEXT_TTL_MS,
    private readonly gcIntervalMs = INLINE_CONTEXT_GC_INTERVAL_MS,
  ) {}

  remember(userId: number, chatId: number): void {
    const now = this.clock.now();

    this.gc(now);
    this.recentChats.set(userId, {
      chatId,
      updatedAt: now,
    });
  }

  getChatId(userId: number): number | null {
    const now = this.clock.now();
    const context = this.recentChats.get(userId);

    if (!context) {
      return null;
    }

    if (now - context.updatedAt > this.ttlMs) {
      this.recentChats.delete(userId);
      return null;
    }

    return context.chatId;
  }

  clear(): void {
    this.recentChats.clear();
  }

  private gc(now: number): void {
    if (now < this.nextGcAt) {
      return;
    }

    this.nextGcAt = now + this.gcIntervalMs;

    for (const [userId, context] of this.recentChats.entries()) {
      if (now - context.updatedAt > this.ttlMs) {
        this.recentChats.delete(userId);
      }
    }
  }
}
