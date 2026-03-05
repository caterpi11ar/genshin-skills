import { logger } from "../utils/logger.js";
import {
  findCoordinatesPrompt,
  checkConditionPrompt,
  planNextActionPrompt,
  queryPrompt,
} from "./prompts.js";
import type {
  VisionModelConfig,
  Coordinates,
  ActionPlan,
  RecentAction,
  IVisionModel,
} from "./types.js";

interface ChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Pure model client — accepts base64 images, returns parsed results.
 * No dependency on Playwright Page.
 */
export class VisionModel implements IVisionModel {
  private config: VisionModelConfig;

  constructor(config: VisionModelConfig) {
    this.config = config;
  }

  /** Raw chat call: send image + text prompt, get text response. */
  async analyze(imageBase64: string, prompt: string): Promise<string> {
    const url =
      this.config.baseUrl.replace(/\/+$/, "") + "/chat/completions";

    logger.debug(`Vision API call: ${prompt.slice(0, 80)}...`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.name,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${imageBase64}`,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vision API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as ChatResponse;
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Vision API returned empty response");
    }

    logger.debug(`Vision API response: ${content.slice(0, 120)}`);
    return content;
  }

  async findCoordinates(
    imageBase64: string,
    goal: string,
  ): Promise<Coordinates | null> {
    const prompt = findCoordinatesPrompt(goal);
    const result = await this.analyze(imageBase64, prompt);
    try {
      const match = result.match(/\{[^}]*\}/);
      if (!match) return null;
      const coords = JSON.parse(match[0]) as Coordinates;
      if (coords.x < 0 || coords.y < 0) return null;
      return coords;
    } catch {
      return null;
    }
  }

  async planNextAction(
    imageBase64: string,
    goal: string,
    recentActions?: RecentAction[],
  ): Promise<ActionPlan> {
    const prompt = planNextActionPrompt(goal, recentActions);
    const result = await this.analyze(imageBase64, prompt);
    try {
      const match = result.match(/\{[^}]*\}/);
      if (!match) {
        throw new Error(`No JSON found in response: ${result}`);
      }
      return JSON.parse(match[0]) as ActionPlan;
    } catch (err) {
      logger.warn(`Failed to parse action plan: ${result}`);
      return {
        action: "wait",
        reason: "Failed to parse AI response, retrying",
      };
    }
  }

  async checkCondition(
    imageBase64: string,
    condition: string,
  ): Promise<boolean> {
    const prompt = checkConditionPrompt(condition);
    const result = await this.analyze(imageBase64, prompt);
    return /true/i.test(result);
  }

  async query<T>(imageBase64: string, prompt: string): Promise<T> {
    const fullPrompt = queryPrompt(prompt);
    const result = await this.analyze(imageBase64, fullPrompt);
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Failed to parse AI response as JSON: ${result}`);
    }
    return JSON.parse(match[0]) as T;
  }
}
