import React from "react";
import { Box, Text } from "ink";
import type { TuiState } from "./hooks";

export function DashboardPane({ state }: { state: TuiState }) {
  const { status, portfolio, positions, recentCandidates, recentAgentEvents } = state;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box>
        <Text bold>Status: </Text>
        <Text color={statusColor(status)}>{status.toUpperCase()}</Text>
        {portfolio && (
          <>
            <Text>  |  </Text>
            <Text bold>Equity: </Text>
            <Text>${portfolio.equityQuote.toFixed(2)}</Text>
            <Text>  </Text>
            <Text color={portfolio.realizedPnlToday >= 0 ? "green" : "red"}>
              {portfolio.realizedPnlToday >= 0 ? "+" : ""}${portfolio.realizedPnlToday.toFixed(2)} today
            </Text>
          </>
        )}
      </Box>

      <Section title="Positions">
        {positions.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          positions.map((p) => (
            <Text key={p.symbol}>
              {p.symbol.padEnd(10)} {p.side === "buy" ? "+" : "-"}
              {p.amount.toFixed(4)}  @{p.entryPrice.toFixed(2)}  {" "}
              <Text color={p.unrealizedPnl >= 0 ? "green" : "red"}>
                {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}
              </Text>
            </Text>
          ))
        )}
      </Section>

      <Section title="Recent signals">
        {recentCandidates.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          recentCandidates.slice(0, 6).map((c) => (
            <Text key={c.id}>
              <Text dimColor>{new Date(c.createdAt).toISOString().slice(11, 19)} </Text>
              {c.symbol.padEnd(10)} {c.strategy.padEnd(14)} {c.side.toUpperCase()}
              <Text dimColor>str={c.strength.toFixed(2)}</Text>
            </Text>
          ))
        )}
      </Section>

      <Section title="Agent activity">
        {recentAgentEvents.length === 0 ? (
          <Text dimColor>idle</Text>
        ) : (
          recentAgentEvents.slice(0, 8).map((e) => (
            <Text key={e.id}>
              <Text dimColor>{new Date(e.ts).toISOString().slice(11, 19)} </Text>
              {e.from}<Text dimColor>→</Text>{e.to}{" "}
              <Text color={e.kind === "error" ? "red" : e.kind === "response" ? "green" : "cyan"}>
                {e.kind}
              </Text>
              {e.durationMs !== undefined && <Text dimColor> {e.durationMs}ms</Text>}
            </Text>
          ))
        )}
      </Section>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>── {title} ──────────────</Text>
      {children}
    </Box>
  );
}

function statusColor(s: TuiState["status"]): string {
  if (s === "running") return "green";
  if (s === "paused") return "yellow";
  return "red";
}
