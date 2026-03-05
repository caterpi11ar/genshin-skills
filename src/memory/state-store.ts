import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { PersistedState, RunSummary } from "./types.js";
import { logger } from "../utils/logger.js";

const STATE_FILE = "./data/state.json";
const MAX_HISTORY = 100;

function defaultState(): PersistedState {
  return {
    lastRunId: null,
    lastRunAt: null,
    lastSuccess: null,
    totalRuns: 0,
    history: [],
  };
}

export class StateStore {
  private state: PersistedState | null = null;

  async load(): Promise<PersistedState> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(STATE_FILE, "utf-8");
      this.state = JSON.parse(raw) as PersistedState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = defaultState();
      } else {
        logger.warn("Failed to load state, using defaults", err);
        this.state = defaultState();
      }
    }
    return this.state;
  }

  async save(): Promise<void> {
    if (!this.state) return;
    await mkdir("./data", { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(this.state, null, 2), "utf-8");
  }

  async updateAfterRun(summary: RunSummary): Promise<void> {
    const state = await this.load();
    state.lastRunId = summary.runId;
    state.lastRunAt = summary.completedAt;
    state.lastSuccess = summary.results.every((r) => r.success);
    state.totalRuns++;
    state.history.push(summary);
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }
    await this.save();
  }

  async getHistory(limit?: number): Promise<RunSummary[]> {
    const state = await this.load();
    const history = state.history;
    if (limit && limit < history.length) {
      return history.slice(-limit);
    }
    return history;
  }

  async getState(): Promise<PersistedState> {
    return this.load();
  }
}
