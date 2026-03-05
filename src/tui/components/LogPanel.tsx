import { Box, Text } from "ink";
import type { LogEntry } from "../../utils/logger.js";

interface LogPanelProps {
  logs: LogEntry[];
}

const MAX_VISIBLE = 15;

type LogColor = "gray" | "white" | "yellow" | "red";

const levelColors: Record<string, LogColor> = {
  debug: "gray",
  info: "white",
  warn: "yellow",
  error: "red",
};

export function LogPanel({ logs }: LogPanelProps) {
  const visible = logs.slice(-MAX_VISIBLE);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Logs</Text>
      {visible.length === 0 ? (
        <Text dimColor> No logs</Text>
      ) : (
        visible.map((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const color = levelColors[entry.level] ?? "white";
          return (
            <Text key={i} color={color}>
              <Text dimColor>{time} </Text>
              <Text>[{entry.level.toUpperCase().padEnd(5)}] </Text>
              <Text>{entry.message}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
