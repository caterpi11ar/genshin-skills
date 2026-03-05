import type { FastifyInstance } from "fastify";
import { logger, type LogEntry } from "../utils/logger.js";

export function registerWebSocket(app: FastifyInstance): void {
  // Circular buffer for recent logs
  const LOG_BUFFER_SIZE = 500;
  const logBuffer: LogEntry[] = [];

  logger.on("log", (entry: LogEntry) => {
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) {
      logBuffer.shift();
    }
  });

  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket) => {
      // Send recent logs on connect
      for (const entry of logBuffer) {
        socket.send(JSON.stringify({ type: "log", data: entry }));
      }

      // Forward new log entries
      const onLog = (entry: LogEntry) => {
        try {
          socket.send(JSON.stringify({ type: "log", data: entry }));
        } catch {
          // Client disconnected
        }
      };

      logger.on("log", onLog);

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "status", data: { alive: true } }));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      socket.on("close", () => {
        logger.removeListener("log", onLog);
        clearInterval(heartbeat);
      });
    });
  });
}
