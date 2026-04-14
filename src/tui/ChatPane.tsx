import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatMessage } from "./hooks";

export interface ChatPaneDeps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  pending: boolean;
}

export function ChatPane({ messages, onSend, pending }: ChatPaneDeps) {
  const [input, setInput] = useState("");

  useInput((char, key) => {
    if (pending) return;
    if (key.return) {
      const text = input.trim();
      if (text.length > 0) onSend(text);
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((cur) => cur.slice(0, -1));
      return;
    }
    if (!key.meta && !key.ctrl && char) setInput((cur) => cur + char);
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold>Chat w/ PM</Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {messages.slice(-20).map((m, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text color={m.role === "user" ? "cyan" : "white"} bold>
              {m.role === "user" ? "you" : "PM"}
            </Text>
            <Text>{m.text}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">&gt; </Text>
        <Text>{input}</Text>
        {pending ? <Text dimColor> (waiting for PM...)</Text> : <Text color="cyan">▏</Text>}
      </Box>
    </Box>
  );
}
