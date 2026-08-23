/**
 * Room event log — the §09 envelope. In-memory implementation now; the
 * NEDB-backed log (append-only causal chain via nedbd) drops in behind
 * EventLog in its own PR.
 */

import { newToken } from "./tokens.js";

export interface EventEnvelope {
  event_id: string;
  room_id: string;
  sequence: number;
  actor_id: string;
  type: string;
  payload: unknown;
  server_time: number;
  causation_id?: string;
}

export interface EventLog {
  append(
    roomId: string,
    actorId: string,
    type: string,
    payload: unknown,
    serverTime: number,
    causationId?: string,
  ): EventEnvelope;
  list(roomId: string): EventEnvelope[];
}

export class MemoryEventLog implements EventLog {
  private logs = new Map<string, EventEnvelope[]>();
  private sequences = new Map<string, number>();

  append(
    roomId: string,
    actorId: string,
    type: string,
    payload: unknown,
    serverTime: number,
    causationId?: string,
  ): EventEnvelope {
    const seq = (this.sequences.get(roomId) ?? 0) + 1;
    this.sequences.set(roomId, seq);
    const envelope: EventEnvelope = {
      event_id: `evt_${newToken().slice(0, 16)}`,
      room_id: roomId,
      sequence: seq,
      actor_id: actorId,
      type,
      payload,
      server_time: serverTime,
      ...(causationId !== undefined ? { causation_id: causationId } : {}),
    };
    const list = this.logs.get(roomId) ?? [];
    list.push(envelope);
    this.logs.set(roomId, list);
    return envelope;
  }

  list(roomId: string): EventEnvelope[] {
    return this.logs.get(roomId) ?? [];
  }
}
