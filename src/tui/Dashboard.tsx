import { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { Gateway } from "../gateway/gateway.js";
import type { GatewaySnapshot } from "../gateway/types.js";
import type { RunResult } from "../tasks/task-runner.js";
import type { LogEntry } from "../utils/logger.js";
import { logger } from "../utils/logger.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskResults } from "./components/TaskResults.js";
import { LogPanel } from "./components/LogPanel.js";

interface DashboardProps {
  gateway: Gateway;
}

export function Dashboard({ gateway }: DashboardProps) {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<GatewaySnapshot>(
    gateway.getSnapshot(),
  );
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Subscribe to gateway state changes
  useEffect(() => {
    const onChange = (s: GatewaySnapshot) => {
      setSnapshot(s);
    };
    gateway.state.on("change", onChange);
    return () => {
      gateway.state.off("change", onChange);
    };
  }, [gateway]);

  // Subscribe to task runner events for last result
  useEffect(() => {
    const runner = gateway.getTaskRunner();
    const onRunComplete = (result: RunResult) => {
      setLastResult(result);
    };
    runner.on("run:complete", onRunComplete);
    return () => {
      runner.off("run:complete", onRunComplete);
    };
  }, [gateway]);

  // Subscribe to logger events
  useEffect(() => {
    const onLog = (entry: LogEntry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 200 ? next.slice(-200) : next;
      });
    };
    logger.on("log", onLog);
    return () => {
      logger.off("log", onLog);
    };
  }, []);

  const handleRunNow = useCallback(() => {
    if (!snapshot.running) {
      gateway.enqueueRun("manual").catch(() => {});
    }
  }, [snapshot.running, gateway]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  useInput((input) => {
    if (input === "r") handleRunNow();
    if (input === "c") clearLogs();
    if (input === "q") {
      logger.unmute();
      gateway.shutdown().then(() => {
        exit();
        process.exit(0);
      }).catch(() => {
        exit();
        process.exit(1);
      });
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box>
        <Text bold color="cyan">
          Genshin Auto
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          Schedule: {gateway.config.schedule.cron} (
          {gateway.config.schedule.timezone})
        </Text>
      </Box>

      <StatusBar
        running={snapshot.running}
        currentTask={snapshot.currentTask}
      />
      <TaskResults lastResult={lastResult} />
      <LogPanel logs={logs} />

      {/* Key hints */}
      <Box marginTop={1}>
        <Text dimColor>
          [r] Run Now [c] Clear Logs [q] Quit
          {snapshot.queueDepth > 0 && ` | Queue: ${snapshot.queueDepth}`}
        </Text>
      </Box>
    </Box>
  );
}
