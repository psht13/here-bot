const SECOND_MS = 1000;

export const PING_COOLDOWN_MS = 60 * SECOND_MS;

export class PingCooldownRegistry {
  private readonly cooldowns = new Map<string, number>();

  reserve(chatId: number, userId: number, label: string, now = Date.now()): number {
    this.gc(now);

    const key = this.key(chatId, userId, label);
    const expiresAt = this.cooldowns.get(key);

    if (expiresAt && expiresAt > now) {
      return expiresAt - now;
    }

    this.cooldowns.set(key, now + PING_COOLDOWN_MS);
    return 0;
  }

  private gc(now: number): void {
    for (const [key, expiresAt] of this.cooldowns.entries()) {
      if (expiresAt <= now) {
        this.cooldowns.delete(key);
      }
    }
  }

  private key(chatId: number, userId: number, label: string): string {
    return `${chatId}:${userId}:${label.trim().toLowerCase()}`;
  }
}

export function formatPingCooldownMessage(remainingMs: number): string {
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / SECOND_MS));

  if (remainingSeconds >= 60) {
    const remainingMinutes = Math.ceil(remainingSeconds / 60);
    return `Wait ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} before sending the same ping again.`;
  }

  return `Wait ${remainingSeconds}s before sending the same ping again.`;
}
