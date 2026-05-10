import { planMentionChunks } from "../../../domain/index.js";
import type { KnownMember } from "../../../domain/models.js";

const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildMention(member: KnownMember): string {
  return `<a href="tg://user?id=${member.id}">${escapeHtml(member.displayName)}</a>`;
}

export function buildMentionChunks(label: string, members: readonly KnownMember[]): string[] {
  return planMentionChunks(label, members, {
    maxLength: MAX_TELEGRAM_MESSAGE_LENGTH,
    getMemberReferenceLength: (member) => buildMention(member).length,
  }).map((chunk) => {
    const mentions = chunk.members.map((member) => ` ${buildMention(member)}`).join("");
    return `@${chunk.label}${mentions}`;
  });
}
