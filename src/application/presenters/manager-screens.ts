export { managerCallbacks, parseManagerAction } from "../callbacks/manager-callbacks.js";
export type { ManagerAction } from "../callbacks/manager-callbacks.js";

export type KeyboardButton =
  | { kind: "callback"; text: string; data: string }
  | { kind: "switchInlineCurrent"; text: string; query: string };

export interface KeyboardModel {
  rows: KeyboardButton[][];
}

export interface ManagerScreen {
  text: string;
  keyboard: KeyboardModel;
}
