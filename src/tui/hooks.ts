import { useEffect, useState } from "react";
import type { EventEmitter } from "node:events";
import type { AgentEvent, Candidate, LoopStatus, PortfolioSummary, Position } from "../types";

export interface ChatMessage {
  role: "user" | "pm";
  text: string;
  ts: number;
}

export interface TuiState {
  status: LoopStatus;
  portfolio: PortfolioSummary | null;
  recentCandidates: Candidate[];
  recentAgentEvents: AgentEvent[];
  positions: Position[];
  chatMessages: ChatMessage[];
  pending: boolean;
}

export interface StateSource {
  getSnapshot: () => TuiState;
  on: (event: "update", listener: () => void) => void;
  off: (event: "update", listener: () => void) => void;
}

export function useTuiState(source: StateSource): TuiState {
  const [snap, setSnap] = useState(source.getSnapshot());
  useEffect(() => {
    const update = () => setSnap(source.getSnapshot());
    source.on("update", update);
    return () => source.off("update", update);
  }, [source]);
  return snap;
}

export function createStateSource(bus: EventEmitter, getSnapshot: () => TuiState): StateSource {
  return {
    getSnapshot,
    on: (event, listener) => bus.on(event, listener),
    off: (event, listener) => bus.off(event, listener),
  };
}
