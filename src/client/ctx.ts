import type {
  GameSettings,
  Phase,
  PlayerInfo,
  ServerMessage,
} from '../shared/protocol.js';
import type { Status } from './net.js';

export type RevealMsg = Extract<ServerMessage, { t: 'reveal' }>;
export type FinalMsg = Extract<ServerMessage, { t: 'final' }>;

export interface RoomModel {
  code: string;
  youId: string;
  hostId: string;
  phase: Phase;
  settings: GameSettings;
  players: PlayerInfo[];
}

export interface RoundModel {
  index: number;
  total: number;
  color: string;
  endsAt: number | null; // null = no time limit (solo "unlimited" mode)
  submitted: number;
  expected: number;
  youPick: string | null;
}

export interface Model {
  status: Status;
  name: string;
  room: RoomModel | null;
  startsAt: number;
  round: RoundModel | null;
  reveal: RevealMsg | null;
  final: FinalMsg | null;
  /** Room code from an invite link (?room=ABCDE). */
  prefillCode: string;
  /** Waiting for the server to answer a create/join request. */
  busy: boolean;
}

export interface Actions {
  create(name: string): void;
  join(code: string, name: string): void;
  start(): void;
  setSettings(patch: Partial<GameSettings>): void;
  pick(hex: string): boolean;
  again(): void;
  leave(): void;
  notify(message: string): void;
}

export interface Ctx {
  model: Model;
  actions: Actions;
  /** Current time on the server's clock (ms since epoch). */
  now(): number;
}

export interface View {
  el: HTMLElement;
  /** Model changed (progress counters, player list, ...). */
  update?(): void;
  /** Called ~10 times per second for timers. */
  tick?(): void;
}
