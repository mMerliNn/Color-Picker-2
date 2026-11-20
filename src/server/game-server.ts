import { randomInt } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  parseClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '../shared/protocol.js';
import type { GameStore } from './db.js';
import { DEFAULT_TIMING, Room, type Conn, type Player, type RoomTiming } from './room.js';

export interface GameServerOptions {
  timing?: Partial<RoomTiming>;
  maxRooms?: number;
  /** A room with nobody connected is deleted after this long. */
  emptyRoomTtlMs?: number;
  /** Any room is deleted after this much inactivity. */
  idleRoomTtlMs?: number;
}

/** One per websocket connection. */
export interface Session {
  readonly conn: Conn;
  room: Room | null;
  player: Player | null;
  tokens: number;
  lastRefill: number;
  strikes: number;
}

// Token bucket: a burst of 20 messages, refilled at 10 per second.
const BUCKET_SIZE = 20;
const REFILL_PER_SEC = 10;
const MAX_STRIKES = 50;

/**
 * Owns all rooms and turns raw client messages into room operations.
 * Knows nothing about websockets, which keeps it directly testable.
 */
export class GameServer {
  private readonly rooms = new Map<string, Room>();
  private readonly timing: RoomTiming;
  private readonly maxRooms: number;
  private readonly emptyRoomTtlMs: number;
  private readonly idleRoomTtlMs: number;

  constructor(
    private readonly store: GameStore,
    options: GameServerOptions = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.maxRooms = options.maxRooms ?? 500;
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? 10 * 60_000;
    this.idleRoomTtlMs = options.idleRoomTtlMs ?? 3 * 60 * 60_000;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  connect(conn: Conn): Session {
    return { conn, room: null, player: null, tokens: BUCKET_SIZE, lastRefill: Date.now(), strikes: 0 };
  }

  disconnect(session: Session): void {
    if (session.room && session.player) session.room.detach(session.player, session.conn);
    session.room = null;
    session.player = null;
  }

  handle(session: Session, raw: string): void {
    if (!this.allow(session)) {
      this.error(session, 'rate_limited', 'Slow down.');
      if (++session.strikes > MAX_STRIKES) session.conn.close();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.error(session, 'bad_message', 'Invalid message.');
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) {
      this.error(session, 'bad_message', 'Invalid message.');
      return;
    }

    switch (msg.t) {
      case 'create': {
        if (this.rooms.size >= this.maxRooms) {
          this.error(session, 'server_busy', 'The server is busy. Try again in a minute.');
          return;
        }
        this.leaveCurrent(session);
        const room = new Room(this.newCode(), msg.settings ?? {}, this.store, this.timing);
        this.rooms.set(room.code, room);
        const result = room.join(msg.clientId, msg.name, session.conn);
        if (!result.ok) {
          this.error(session, result.code, result.message);
          return;
        }
        session.room = room;
        session.player = result.player;
        return;
      }

      case 'join': {
        const room = this.rooms.get(msg.code);
        if (!room) {
          this.error(session, 'no_room', 'No room with that code.');
          return;
        }
        if (session.room && session.room !== room) this.leaveCurrent(session);
        const result = room.join(msg.clientId, msg.name, session.conn);
        if (!result.ok) {
          this.error(session, result.code, result.message);
          return;
        }
        session.room = room;
        session.player = result.player;
        return;
      }

      case 'leave':
        this.leaveCurrent(session);
        return;

      case 'ping':
        // Clock sync; works before joining a room. Never fails, never needs a reply error.
        try {
          session.conn.send({ t: 'pong', c: msg.c, serverNow: Date.now() });
        } catch {
          /* socket already gone */
        }
        return;

      default: {
        const { room, player } = session;
        if (!room || !player) {
          this.error(session, 'not_in_room', 'Join a room first.');
          return;
        }
        let failure = null;
        if (msg.t === 'settings') failure = room.setSettings(player, msg.settings);
        else if (msg.t === 'start') failure = room.start(player);
        else if (msg.t === 'pick') failure = room.pick(player, msg.hex);
        else if (msg.t === 'draft') failure = room.draft(player, msg.hex);
        else if (msg.t === 'again') failure = room.again(player);
        if (failure) this.error(session, failure.code, failure.message);
      }
    }
  }

  /** Delete abandoned rooms. Call periodically. */
  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      const abandoned = room.connectedCount() === 0 && idle > this.emptyRoomTtlMs;
      if (abandoned || idle > this.idleRoomTtlMs) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  close(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  // ---- internals ----------------------------------------------------------

  private leaveCurrent(session: Session): void {
    if (session.room && session.player) session.room.leave(session.player);
    session.room = null;
    session.player = null;
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  private allow(session: Session): boolean {
    const now = Date.now();
    const elapsed = (now - session.lastRefill) / 1000;
    session.lastRefill = now;
    session.tokens = Math.min(BUCKET_SIZE, session.tokens + elapsed * REFILL_PER_SEC);
    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  }

  private error(session: Session, code: ErrorCode, message: string): void {
    const msg: ServerMessage = { t: 'error', code, message };
    try {
      session.conn.send(msg);
    } catch {
      /* socket already gone */
    }
  }
}
