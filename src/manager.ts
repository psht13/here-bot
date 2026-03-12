import { InlineKeyboard } from "grammy";

import { escapeHtml, normalizeKey } from "./domain.js";
import type { KnownChat, KnownMember, MentionGroup } from "./models.js";

const MEMBERS_PAGE_SIZE = 6;
const GROUPS_PAGE_SIZE = 6;
const DRAFT_TTL_MS = 30 * 60 * 1000;

export interface ManagerScreen {
  text: string;
  keyboard: InlineKeyboard;
}

export interface DraftState {
  chatId: number;
  userId: number;
  memberIds: number[];
  page: number;
  groupKey?: string | undefined;
  awaitingName: boolean;
  updatedAt: number;
}

type ManagerAction =
  | { kind: "home"; chatId: number }
  | { kind: "pingAll"; chatId: number }
  | { kind: "members"; chatId: number; page: number }
  | { kind: "groups"; chatId: number; page: number }
  | { kind: "groupView"; chatId: number; groupKey: string; page: number }
  | { kind: "groupPing"; chatId: number; groupKey: string }
  | { kind: "groupDelete"; chatId: number; groupKey: string; page: number }
  | { kind: "draftNew"; chatId: number }
  | { kind: "draftEdit"; chatId: number; groupKey: string; page: number }
  | { kind: "draftView"; chatId: number; page: number }
  | { kind: "draftToggle"; chatId: number; page: number; memberId: number }
  | { kind: "draftSave"; chatId: number }
  | { kind: "draftCancel"; chatId: number };

export const managerCallbacks = {
  home: (chatId: number) => `hm:${chatId}`,
  pingAll: (chatId: number) => `ha:${chatId}`,
  members: (chatId: number, page: number) => `ml:${chatId}:${page}`,
  groups: (chatId: number, page: number) => `gl:${chatId}:${page}`,
  groupView: (chatId: number, groupKey: string, page: number) =>
    `gv:${chatId}:${groupKey}:${page}`,
  groupPing: (chatId: number, groupKey: string) => `gp:${chatId}:${groupKey}`,
  groupDelete: (chatId: number, groupKey: string, page: number) =>
    `gd:${chatId}:${groupKey}:${page}`,
  draftNew: (chatId: number) => `dn:${chatId}`,
  draftEdit: (chatId: number, groupKey: string, page: number) =>
    `de:${chatId}:${groupKey}:${page}`,
  draftView: (chatId: number, page: number) => `dv:${chatId}:${page}`,
  draftToggle: (chatId: number, page: number, memberId: number) =>
    `dt:${chatId}:${page}:${memberId}`,
  draftSave: (chatId: number) => `ds:${chatId}`,
  draftCancel: (chatId: number) => `dc:${chatId}`,
};

function parseInteger(raw: string | undefined): number | null {
  if (!raw || !/^-?\d+$/.test(raw)) {
    return null;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value)) {
    return null;
  }

  return value;
}

function parsePage(raw: string | undefined): number | null {
  const value = parseInteger(raw);

  if (value === null || value < 0) {
    return null;
  }

  return value;
}

export function parseManagerAction(data: string): ManagerAction | null {
  const parts = data.split(":");
  const type = parts[0];

  if (type === "hm") {
    const chatId = parseInteger(parts[1]);
    return chatId === null ? null : { kind: "home", chatId };
  }

  if (type === "ha") {
    const chatId = parseInteger(parts[1]);
    return chatId === null ? null : { kind: "pingAll", chatId };
  }

  if (type === "ml") {
    const chatId = parseInteger(parts[1]);
    const page = parsePage(parts[2]);
    return chatId === null || page === null ? null : { kind: "members", chatId, page };
  }

  if (type === "gl") {
    const chatId = parseInteger(parts[1]);
    const page = parsePage(parts[2]);
    return chatId === null || page === null ? null : { kind: "groups", chatId, page };
  }

  if (type === "gv") {
    const chatId = parseInteger(parts[1]);
    const groupKey = normalizeKey(parts[2] ?? "");
    const page = parsePage(parts[3]);

    if (chatId === null || !groupKey || page === null) {
      return null;
    }

    return { kind: "groupView", chatId, groupKey, page };
  }

  if (type === "gp") {
    const chatId = parseInteger(parts[1]);
    const groupKey = normalizeKey(parts[2] ?? "");

    if (chatId === null || !groupKey) {
      return null;
    }

    return { kind: "groupPing", chatId, groupKey };
  }

  if (type === "gd") {
    const chatId = parseInteger(parts[1]);
    const groupKey = normalizeKey(parts[2] ?? "");
    const page = parsePage(parts[3]);

    if (chatId === null || !groupKey || page === null) {
      return null;
    }

    return { kind: "groupDelete", chatId, groupKey, page };
  }

  if (type === "dn") {
    const chatId = parseInteger(parts[1]);
    return chatId === null ? null : { kind: "draftNew", chatId };
  }

  if (type === "de") {
    const chatId = parseInteger(parts[1]);
    const groupKey = normalizeKey(parts[2] ?? "");
    const page = parsePage(parts[3]);

    if (chatId === null || !groupKey || page === null) {
      return null;
    }

    return { kind: "draftEdit", chatId, groupKey, page };
  }

  if (type === "dv") {
    const chatId = parseInteger(parts[1]);
    const page = parsePage(parts[2]);
    return chatId === null || page === null ? null : { kind: "draftView", chatId, page };
  }

  if (type === "dt") {
    const chatId = parseInteger(parts[1]);
    const page = parsePage(parts[2]);
    const memberId = parseInteger(parts[3]);

    if (chatId === null || page === null || memberId === null) {
      return null;
    }

    return { kind: "draftToggle", chatId, page, memberId };
  }

  if (type === "ds") {
    const chatId = parseInteger(parts[1]);
    return chatId === null ? null : { kind: "draftSave", chatId };
  }

  if (type === "dc") {
    const chatId = parseInteger(parts[1]);
    return chatId === null ? null : { kind: "draftCancel", chatId };
  }

  return null;
}

export class DraftRegistry {
  private readonly drafts = new Map<string, DraftState>();

  create(chatId: number, userId: number, memberIds: number[] = [], groupKey?: string): DraftState {
    this.gc();

    const draft: DraftState = {
      chatId,
      userId,
      memberIds: [...new Set(memberIds)],
      page: 0,
      groupKey,
      awaitingName: false,
      updatedAt: Date.now(),
    };

    this.drafts.set(this.key(chatId, userId), draft);

    return draft;
  }

  get(chatId: number, userId: number): DraftState | null {
    this.gc();

    const draft = this.drafts.get(this.key(chatId, userId));

    if (!draft) {
      return null;
    }

    draft.updatedAt = Date.now();
    return draft;
  }

  toggle(chatId: number, userId: number, memberId: number, availableIds: Set<number>): DraftState | null {
    const draft = this.get(chatId, userId);

    if (!draft || !availableIds.has(memberId)) {
      return null;
    }

    const selected = new Set(draft.memberIds);

    if (selected.has(memberId)) {
      selected.delete(memberId);
    } else {
      selected.add(memberId);
    }

    draft.memberIds = [...selected];
    draft.updatedAt = Date.now();

    return draft;
  }

  setPage(chatId: number, userId: number, page: number): DraftState | null {
    const draft = this.get(chatId, userId);

    if (!draft) {
      return null;
    }

    draft.page = Math.max(0, page);
    draft.updatedAt = Date.now();

    return draft;
  }

  setGroupKey(chatId: number, userId: number, groupKey: string): DraftState | null {
    const normalized = normalizeKey(groupKey);
    const draft = this.get(chatId, userId);

    if (!draft || !normalized) {
      return null;
    }

    draft.groupKey = normalized;
    draft.awaitingName = false;
    draft.updatedAt = Date.now();

    return draft;
  }

  promptForName(chatId: number, userId: number): DraftState | null {
    const draft = this.get(chatId, userId);

    if (!draft) {
      return null;
    }

    draft.awaitingName = true;
    draft.updatedAt = Date.now();

    return draft;
  }

  clear(chatId: number, userId: number): void {
    this.drafts.delete(this.key(chatId, userId));
  }

  private gc(): void {
    const cutoff = Date.now() - DRAFT_TTL_MS;

    for (const [key, draft] of this.drafts.entries()) {
      if (draft.updatedAt < cutoff) {
        this.drafts.delete(key);
      }
    }
  }

  private key(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }
}

function clampPage(page: number, itemCount: number, pageSize: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  const lastPage = Math.max(0, Math.ceil(itemCount / pageSize) - 1);

  return Math.min(Math.max(0, page), lastPage);
}

function pageCount(itemCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(itemCount / pageSize));
}

function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const safePage = clampPage(page, items.length, pageSize);
  const start = safePage * pageSize;
  return items.slice(start, start + pageSize);
}

function shorten(value: string, maxLength = 18): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function memberButtonLabel(member: KnownMember, selected: boolean): string {
  const base = member.username ? `@${member.username}` : member.displayName;
  const prefix = selected ? "[x] " : "[ ] ";
  return `${prefix}${shorten(base, 18)}`;
}

function memberLine(member: KnownMember): string {
  const username = member.username ? ` (@${escapeHtml(member.username)})` : "";
  return `- ${escapeHtml(member.displayName)}${username}`;
}

function selectedPreview(members: KnownMember[]): string[] {
  if (members.length === 0) {
    return ["- No one selected yet."];
  }

  const preview = members.slice(0, 8).map(memberLine);

  if (members.length > 8) {
    preview.push(`- +${members.length - 8} more selected`);
  }

  return preview;
}

function buildPagerRow(
  keyboard: InlineKeyboard,
  previousData: string | null,
  nextData: string | null,
): void {
  if (previousData) {
    keyboard.text("Prev", previousData);
  }

  if (nextData) {
    keyboard.text("Next", nextData);
  }

  if (previousData || nextData) {
    keyboard.row();
  }
}

export function buildHomeScreen(
  chat: KnownChat,
  memberCount: number,
  groupCount: number,
): ManagerScreen {
  const keyboard = new InlineKeyboard()
    .text("Ping All", managerCallbacks.pingAll(chat.id))
    .switchInlineCurrent("Inline Here", "all")
    .row()
    .text("Groups", managerCallbacks.groups(chat.id, 0))
    .text("Members", managerCallbacks.members(chat.id, 0))
    .row()
    .text("New Subgroup", managerCallbacks.draftNew(chat.id));

  return {
    text: [
      `<b>${escapeHtml(chat.title)}</b>`,
      `Tracked members: <b>${memberCount}</b>`,
      `Custom groups: <b>${groupCount}</b>`,
      "",
      "Use the buttons below to ping everyone, browse members, and manage subgroups.",
    ].join("\n"),
    keyboard,
  };
}

export function buildMembersScreen(chat: KnownChat, members: KnownMember[], page: number): ManagerScreen {
  const safePage = clampPage(page, members.length, MEMBERS_PAGE_SIZE);
  const totalPages = pageCount(members.length, MEMBERS_PAGE_SIZE);
  const slice = pageSlice(members, safePage, MEMBERS_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  buildPagerRow(
    keyboard,
    safePage > 0 ? managerCallbacks.members(chat.id, safePage - 1) : null,
    safePage + 1 < totalPages ? managerCallbacks.members(chat.id, safePage + 1) : null,
  );

  keyboard
    .text("New Subgroup", managerCallbacks.draftNew(chat.id))
    .text("Groups", managerCallbacks.groups(chat.id, 0))
    .row()
    .text("Home", managerCallbacks.home(chat.id));

  const lines = [
    `<b>${escapeHtml(chat.title)} Members</b>`,
    `Tracked members: <b>${members.length}</b>`,
    `Page ${safePage + 1}/${totalPages}`,
    "",
  ];

  if (slice.length === 0) {
    lines.push("No tracked members yet.");
  } else {
    lines.push(...slice.map(memberLine));
  }

  return {
    text: lines.join("\n"),
    keyboard,
  };
}

export function buildGroupsScreen(
  chat: KnownChat,
  groups: MentionGroup[],
  page: number,
): ManagerScreen {
  const safePage = clampPage(page, groups.length, GROUPS_PAGE_SIZE);
  const totalPages = pageCount(groups.length, GROUPS_PAGE_SIZE);
  const slice = pageSlice(groups, safePage, GROUPS_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  for (const group of slice) {
    keyboard.text(
      `@${shorten(group.key, 20)} (${group.memberIds.length})`,
      managerCallbacks.groupView(chat.id, group.key, safePage),
    );
    keyboard.row();
  }

  buildPagerRow(
    keyboard,
    safePage > 0 ? managerCallbacks.groups(chat.id, safePage - 1) : null,
    safePage + 1 < totalPages ? managerCallbacks.groups(chat.id, safePage + 1) : null,
  );

  keyboard
    .text("New Subgroup", managerCallbacks.draftNew(chat.id))
    .text("Home", managerCallbacks.home(chat.id));

  const lines = [
    `<b>${escapeHtml(chat.title)} Subgroups</b>`,
    `Custom groups: <b>${groups.length}</b>`,
    `Page ${safePage + 1}/${totalPages}`,
    "",
  ];

  if (slice.length === 0) {
    lines.push("No custom groups yet. Create one with the New Subgroup button.");
  } else {
    lines.push(...slice.map((group) => `- @${group.key} (${group.memberIds.length} members)`));
  }

  return {
    text: lines.join("\n"),
    keyboard,
  };
}

export function buildGroupScreen(
  chat: KnownChat,
  group: MentionGroup,
  members: KnownMember[],
  originPage: number,
): ManagerScreen {
  const keyboard = new InlineKeyboard()
    .text(`Ping @${shorten(group.key, 14)}`, managerCallbacks.groupPing(chat.id, group.key))
    .switchInlineCurrent("Inline", group.key)
    .row()
    .text("Edit Members", managerCallbacks.draftEdit(chat.id, group.key, originPage))
    .text("Delete", managerCallbacks.groupDelete(chat.id, group.key, originPage))
    .row()
    .text("Back", managerCallbacks.groups(chat.id, originPage))
    .text("Home", managerCallbacks.home(chat.id));

  const lines = [
    `<b>@${group.key}</b> in <b>${escapeHtml(chat.title)}</b>`,
    `Members: <b>${members.length}</b>`,
    "",
  ];

  if (members.length === 0) {
    lines.push("This subgroup is empty.");
  } else {
    lines.push(...members.slice(0, 12).map(memberLine));

    if (members.length > 12) {
      lines.push(`- +${members.length - 12} more members`);
    }
  }

  return {
    text: lines.join("\n"),
    keyboard,
  };
}

export function buildDraftScreen(
  chat: KnownChat,
  draft: DraftState,
  allMembers: KnownMember[],
): ManagerScreen {
  const safePage = clampPage(draft.page, allMembers.length, MEMBERS_PAGE_SIZE);
  const totalPages = pageCount(allMembers.length, MEMBERS_PAGE_SIZE);
  const slice = pageSlice(allMembers, safePage, MEMBERS_PAGE_SIZE);
  const selectedIds = new Set(draft.memberIds);
  const selectedMembers = allMembers.filter((member) => selectedIds.has(member.id));
  const keyboard = new InlineKeyboard();

  for (let index = 0; index < slice.length; index += 2) {
    const left = slice[index];
    const right = slice[index + 1];

    if (left) {
      keyboard.text(
        memberButtonLabel(left, selectedIds.has(left.id)),
        managerCallbacks.draftToggle(chat.id, safePage, left.id),
      );
    }

    if (right) {
      keyboard.text(
        memberButtonLabel(right, selectedIds.has(right.id)),
        managerCallbacks.draftToggle(chat.id, safePage, right.id),
      );
    }

    keyboard.row();
  }

  buildPagerRow(
    keyboard,
    safePage > 0 ? managerCallbacks.draftView(chat.id, safePage - 1) : null,
    safePage + 1 < totalPages ? managerCallbacks.draftView(chat.id, safePage + 1) : null,
  );

  keyboard
    .text(
      draft.groupKey
        ? `Save @${draft.groupKey}`
        : draft.awaitingName
          ? "Waiting For Name"
          : "Name + Save",
      managerCallbacks.draftSave(chat.id),
    )
    .text("Cancel", managerCallbacks.draftCancel(chat.id))
    .row()
    .text("Home", managerCallbacks.home(chat.id));

  const lines = [
    `<b>Subgroup Builder</b> for <b>${escapeHtml(chat.title)}</b>`,
    draft.groupKey
      ? `Editing: <code>@${draft.groupKey}</code>`
      : "New subgroup draft",
    `Selected members: <b>${selectedMembers.length}</b> of <b>${allMembers.length}</b>`,
    `Page ${safePage + 1}/${totalPages}`,
    "",
    allMembers.length > 0
      ? "Tap members below to toggle them."
      : "No tracked members are available yet. Ask people to send one message in this group.",
    draft.groupKey
      ? "Press Save to update this subgroup."
      : draft.awaitingName
        ? "Send the subgroup name as your next message in this group."
        : "Press Name + Save to enter naming mode.",
    "",
    "Currently selected:",
    ...selectedPreview(selectedMembers),
  ];
  return {
    text: lines.join("\n"),
    keyboard,
  };
}
