import { appendFile, mkdir } from "node:fs/promises";
import type { TranscriptEntry } from "./types.js";

const DATA_DIR = "./data/transcripts";

/**
 * Append-only JSONL writer for execution transcripts.
 */
export class TranscriptWriter {
  private filePath: string;
  private initialized = false;

  constructor(runId: string) {
    this.filePath = `${DATA_DIR}/${runId}.jsonl`;
  }

  async append(entry: TranscriptEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(DATA_DIR, { recursive: true });
      this.initialized = true;
    }
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.filePath, line, "utf-8");
  }

  getFilePath(): string {
    return this.filePath;
  }
}
