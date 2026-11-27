import type { ChallengeStatus } from '../shared/challenge.js';
import type {
  ChallengeInfo,
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
  /** Set when this room is a weekly challenge attempt. */
  challenge: ChallengeInfo | null;
}

export interface RoundModel {
  index: number;
  total: number;
  color: string | null; // null once hidden (memory mode, after a reconnect)
  hideAt: number | null; // memory mode: when the color hides
  unlockAt: number | null; // memory mode: when the picker unlocks
  startedAt: number; // when the time to pick started (Rapid's bonus counts from here)
  endsAt: number | null; // null = no time limit (solo "unlimited" mode); Rapid's shot clock can move it
  /** Rapid: someone locked in first and the shot clock started (once per round). */
  shot: { by: string; shortened: boolean } | null;
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
  /** Play (or resume) this week's challenge. */
  challenge(name: string): void;
  /** The home card's numbers; null when the server cannot be reached. */
  challengeStatus(): Promise<ChallengeStatus | null>;
  start(): void;
  setSettings(patch: Partial<GameSettings>): void;
  pick(hex: string): boolean;
  /** Tell the server the color on screen (used if time runs out first). Silent: no error toast. */
  draft(hex: string): boolean;
  /** Solo only: skip the pause after a round result. */
  next(): void;
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
