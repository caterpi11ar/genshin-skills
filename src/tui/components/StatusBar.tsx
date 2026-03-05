import { Box, Text } from "ink";

interface StatusBarProps {
  running: boolean;
  currentTask: string | null;
}

export function StatusBar({ running, currentTask }: StatusBarProps) {
  return (
    <Box marginTop={1}>
      <Text>Status: </Text>
      {running ? (
        <Text>
          <Text color="blue" bold>
            ● Running
          </Text>
          {currentTask && <Text dimColor> — {currentTask}</Text>}
        </Text>
      ) : (
        <Text color="gray">○ Idle</Text>
      )}
    </Box>
  );
}
