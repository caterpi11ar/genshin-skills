import type { Page } from "playwright";
import type { IVisionModel, TaskDescription } from "../model/types.js";
import type { TranscriptWriter } from "../memory/transcript.js";

export interface AgentContext {
  page: Page;
  model: IVisionModel;
  goal: string | TaskDescription;
  timeoutMs: number;
  transcript?: TranscriptWriter;
  screenshotDir?: string;
}

export interface AgentResult {
  success: boolean;
  reason: string;
  steps: number;
  durationMs: number;
  screenshotPaths: string[];
}
