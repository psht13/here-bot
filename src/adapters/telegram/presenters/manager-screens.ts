import { InlineKeyboard } from "grammy";

import { managerCallbacks } from "../../../application/callbacks/manager-callbacks.js";
import type {
  KeyboardButton,
  KeyboardModel,
  ManagerScreen,
} from "../../../application/presenters/manager-screens.js";
import type { DraftState } from "../../../application/services/draft-registry.js";
import type { KnownChat, KnownMember, MentionGroup } from "../../../domain/models.js";
import { escapeHtml } from "./mentions.js";

export * from "../../../application/presenters/manager-screens.js";

const MEMBERS_PAGE_SIZE = 6;
const GROUPS_PAGE_SIZE = 6;

class KeyboardBuilder {
  private readonly rows: KeyboardButton[][] = [];
  private currentRow: KeyboardButton[] = [];

  text(label: string, data: string): this {
    this.currentRow.push({ kind: "callback", text: label, data });
    return this;
  }

  switchInlineCurrent(label: string, query: string): this {
    this.currentRow.push({ kind: "switchInlineCurrent", text: label, query });
    return this;
  }

  row(): this {
    if (this.currentRow.length > 0) {
      this.rows.push(this.currentRow);
      this.currentRow = [];
    }

    return this;
  }

  toModel(): KeyboardModel {
    this.row();
    return {
      rows: this.rows.map((row) => [...row]),
    };
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

function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
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
  keyboard: KeyboardBuilder,
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
  const keyboard = new KeyboardBuilder()
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
    keyboard: keyboard.toModel(),
  };
}

export function buildMembersScreen(
  chat: KnownChat,
  members: KnownMember[],
  page: number,
): ManagerScreen {
  const safePage = clampPage(page, members.length, MEMBERS_PAGE_SIZE);
  const totalPages = pageCount(members.length, MEMBERS_PAGE_SIZE);
  const slice = pageSlice(members, safePage, MEMBERS_PAGE_SIZE);
  const keyboard = new KeyboardBuilder();

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
    keyboard: keyboard.toModel(),
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
  const keyboard = new KeyboardBuilder();

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
    keyboard: keyboard.toModel(),
  };
}

export function buildGroupScreen(
  chat: KnownChat,
  group: MentionGroup,
  members: KnownMember[],
  originPage: number,
): ManagerScreen {
  const keyboard = new KeyboardBuilder()
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
    keyboard: keyboard.toModel(),
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
  const keyboard = new KeyboardBuilder();

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
    draft.groupKey ? `Editing: <code>@${draft.groupKey}</code>` : "New subgroup draft",
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
    keyboard: keyboard.toModel(),
  };
}

export function toTelegramInlineKeyboard(model: KeyboardModel): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  model.rows.forEach((row, rowIndex) => {
    for (const button of row) {
      if (button.kind === "callback") {
        keyboard.text(button.text, button.data);
      } else {
        keyboard.switchInlineCurrent(button.text, button.query);
      }
    }

    if (rowIndex + 1 < model.rows.length) {
      keyboard.row();
    }
  });

  return keyboard;
}
