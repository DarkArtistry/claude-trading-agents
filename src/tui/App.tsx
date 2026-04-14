import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ChatPane } from "./ChatPane";
import { DashboardPane } from "./DashboardPane";
import { useTuiState, type StateSource } from "./hooks";

export interface AppDeps {
  stateSource: StateSource;
  sendToPm: (text: string) => Promise<void> | void;
  onPause: () => void;
  onResume: () => void;
  onKill: () => void | Promise<void>;
}

export function App({ stateSource, sendToPm, onPause, onResume, onKill }: AppDeps) {
  const state = useTuiState(stateSource);
  const { exit } = useApp();

  useInput((char) => {
    if (state.pending) return;
    if (char === "p") onPause();
    else if (char === "r") onResume();
    else if (char === "k") {
      void Promise.resolve(onKill()).finally(() => exit());
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="row" flexGrow={1}>
        <ChatPane messages={state.chatMessages} onSend={(t) => void sendToPm(t)} pending={state.pending} />
        <DashboardPane state={state} />
      </Box>
      <Box paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>
          [p]ause  [r]esume  [k]ill  —  type a message and press enter to chat with PM
        </Text>
      </Box>
    </Box>
  );
}
