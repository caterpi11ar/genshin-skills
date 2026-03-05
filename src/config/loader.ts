import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { appConfigSchema, type AppConfig } from "./schema.js";
import { ConfigError } from "../utils/errors.js";

/**
 * Deep-merge two objects. `b` values override `a` values.
 * Arrays are replaced, not concatenated.
 */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a };
  for (const key of Object.keys(b)) {
    const bVal = b[key];
    const aVal = a[key];
    if (
      bVal !== null &&
      typeof bVal === "object" &&
      !Array.isArray(bVal) &&
      aVal !== null &&
      typeof aVal === "object" &&
      !Array.isArray(aVal)
    ) {
      result[key] = deepMerge(
        aVal as Record<string, unknown>,
        bVal as Record<string, unknown>,
      );
    } else if (bVal !== undefined) {
      result[key] = bVal;
    }
  }
  return result;
}

/**
 * Read a JSON config file. Returns empty object if file doesn't exist.
 */
async function loadJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(resolve(path), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new ConfigError(`Failed to parse config file: ${path}`, err);
  }
}

/**
 * Map environment variables to config overrides.
 */
function envOverrides(): Record<string, unknown> {
  const env = process.env;
  const overrides: Record<string, unknown> = {};

  // Model config from MIDSCENE_* or MODEL_* env vars
  const modelName = env["MIDSCENE_MODEL_NAME"] ?? env["MODEL_NAME"];
  const modelBaseUrl = env["MIDSCENE_MODEL_BASE_URL"] ?? env["MODEL_BASE_URL"];
  const modelApiKey = env["MIDSCENE_MODEL_API_KEY"] ?? env["MODEL_API_KEY"];
  const modelFamily = env["MIDSCENE_MODEL_FAMILY"] ?? env["MODEL_FAMILY"];

  if (modelName || modelBaseUrl || modelApiKey || modelFamily) {
    const model: Record<string, string> = {};
    if (modelName) model["name"] = modelName;
    if (modelBaseUrl) model["baseUrl"] = modelBaseUrl;
    if (modelApiKey) model["apiKey"] = modelApiKey;
    if (modelFamily) model["family"] = modelFamily;
    overrides["model"] = model;
  }

  // Browser config
  const headless = env["BROWSER_HEADLESS"];
  if (headless !== undefined) {
    overrides["browser"] = { headless: headless !== "false" };
  }

  return overrides;
}

export interface LoadConfigOptions {
  configPath?: string;
  cliOverrides?: Record<string, unknown>;
}

/**
 * Load config with priority: config.json < env vars < CLI args.
 * Loads .env file automatically.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  // Load .env
  dotenv.config();

  const { configPath = "./config.json", cliOverrides = {} } = options;

  // Layer 1: JSON file
  const fileConfig = await loadJsonFile(configPath);

  // Layer 2: env vars
  const envConfig = envOverrides();

  // Layer 3: CLI overrides
  const merged = deepMerge(deepMerge(fileConfig, envConfig), cliOverrides);

  // Validate
  const result = appConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    );
  }

  return result.data;
}
