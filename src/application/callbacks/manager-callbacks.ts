import { normalizeKey } from "../../domain/index.js";

export type ManagerAction =
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
  groupView: (chatId: number, groupKey: string, page: number) => `gv:${chatId}:${groupKey}:${page}`,
  groupPing: (chatId: number, groupKey: string) => `gp:${chatId}:${groupKey}`,
  groupDelete: (chatId: number, groupKey: string, page: number) =>
    `gd:${chatId}:${groupKey}:${page}`,
  draftNew: (chatId: number) => `dn:${chatId}`,
  draftEdit: (chatId: number, groupKey: string, page: number) => `de:${chatId}:${groupKey}:${page}`,
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
