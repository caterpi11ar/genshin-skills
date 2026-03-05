import { Command } from "commander";
import { loadConfig } from "./config/loader.js";
import { Gateway } from "./gateway/gateway.js";
import { startGateway } from "./gateway/lifecycle.js";
import { logger } from "./utils/logger.js";

const program = new Command();

program
  .name("genshin-auto")
  .description("AI vision-driven Genshin Impact cloud gaming automation")
  .version("0.2.0")
  .option("-c, --config <path>", "config file path", "./config.json")
  .option("-t, --tasks <ids...>", "task IDs to run")
  .option("--headless", "force headless mode")
  .option("--no-headless", "force visible mode")
  .option("--dry-run", "validate config only, do not execute")
  .option("-v, --verbose", "enable debug logging");

program
  .command("run", { isDefault: true })
  .description("Run tasks once (default)")
  .action(async () => {
    const opts = program.opts();
    await runOnce(opts);
  });

program
  .command("daemon")
  .description("Run as daemon with cron scheduling")
  .option("-p, --port <number>", "web panel port", "3000")
  .option("--no-web", "disable web panel")
  .action(async (daemonOpts) => {
    const opts = program.opts();
    await runDaemon(opts, daemonOpts);
  });

async function runOnce(opts: Record<string, unknown>): Promise<void> {
  if (opts["verbose"]) {
    logger.setLevel("debug");
  }

  const cliOverrides: Record<string, unknown> = {};
  if (opts["headless"] !== undefined) {
    cliOverrides["browser"] = { headless: opts["headless"] as boolean };
  }

  const config = await loadConfig({
    configPath: opts["config"] as string | undefined,
    cliOverrides,
  });

  if (opts["dryRun"]) {
    logger.info("Dry run — config validated successfully:");
    logger.info(JSON.stringify(config, null, 2));
    return;
  }

  const gateway = new Gateway(config);
  const taskIds = opts["tasks"] as string[] | undefined;

  try {
    const result = await gateway.runOnce(taskIds);

    for (const r of result.results) {
      const status = r.success ? "OK" : "FAIL";
      logger.info(
        `  [${status}] ${r.taskId}: ${r.message} (${r.durationMs}ms)`,
      );
    }

    const failed = result.results.filter((r) => !r.success);
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error("Run failed", err);
    process.exitCode = 1;
  }
}

async function runDaemon(
  opts: Record<string, unknown>,
  daemonOpts: Record<string, unknown>,
): Promise<void> {
  if (opts["verbose"]) {
    logger.setLevel("debug");
  }

  const cliOverrides: Record<string, unknown> = {};
  if (opts["headless"] !== undefined) {
    cliOverrides["browser"] = { headless: opts["headless"] as boolean };
  }

  const webPort = Number(daemonOpts["port"] ?? 3000);
  const webEnabled = daemonOpts["web"] !== false;
  cliOverrides["web"] = { port: webPort, enabled: webEnabled };

  const config = await loadConfig({
    configPath: opts["config"] as string | undefined,
    cliOverrides,
  });

  await startGateway(config);
}

program.parse();
