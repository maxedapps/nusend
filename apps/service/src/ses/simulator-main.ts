import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";

import { deploymentConfig, sendingConfigFromDeployment } from "../config.ts";
import { DatabaseBunLive } from "../services/database-bun.ts";
import { EmailSendingConfigLive } from "../services/email-transport.ts";
import { EmailTransportSesLive } from "../services/email-transport-ses.ts";
import { IdGeneratorLive } from "../services/ids.ts";
import { UnsubscribeConfigLive } from "../unsubscribe/config.ts";
import {
  runSesSimulator,
  simulatorScenarios,
  type SimulatorMode,
  type SimulatorScenario,
} from "./simulator.ts";

const args = parseArgs(process.argv.slice(2));
const configProvider = ConfigProvider.fromEnv();
const loaded = await loadConfig(
  "simulator",
  Effect.flatMap(deploymentConfig, (deployment) =>
    Effect.map(sendingConfigFromDeployment(deployment), (sending) => ({ deployment, sending })),
  ),
);
const service = loaded.deployment.service;
const sending = loaded.sending;
const unsubscribe = loaded.deployment.unsubscribe;
const sendingConfigLayer = EmailSendingConfigLive(sending);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    DatabaseBunLive(service.databasePath),
    IdGeneratorLive,
    sendingConfigLayer,
    UnsubscribeConfigLive(unsubscribe),
    EmailTransportSesLive.pipe(Layer.provide(sendingConfigLayer)),
  ),
);

if (args.mode === "end_to_end") {
  console.error(
    "end-to-end mode polls this machine's local database for SNS-ingested events. Run it on the deployed Nusend instance that receives the public SNS webhook; anywhere else, scenarios will time out.",
  );
}

try {
  const scenarios = args.scenario === "all" ? simulatorScenarios : [args.scenario];
  for (const scenario of scenarios) {
    // oxlint-disable-next-line no-await-in-loop -- simulator scenarios should run sequentially to keep output and SES rate predictable.
    const result = await runtime.runPromise(
      runSesSimulator({
        mode: args.mode,
        purpose: args.purpose,
        scenario,
        targetBaseUrl: args.targetBaseUrl,
        workerId: args.workerId,
      }),
    );
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(`SES simulator failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await runtime.dispose();
}

type Args = {
  mode: SimulatorMode;
  purpose: "marketing" | "transactional";
  scenario: SimulatorScenario | "all";
  targetBaseUrl: string | null;
  workerId: string;
};

function parseArgs(argv: string[]): Args {
  const [scenarioRaw, ...rest] = argv;
  if (
    !scenarioRaw ||
    !(scenarioRaw === "all" || (simulatorScenarios as readonly string[]).includes(scenarioRaw))
  ) {
    usage();
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) usage();
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) usage();
    values.set(arg.slice(2), value);
    index += 1;
  }

  const modeRaw = values.get("mode") ?? "send-acceptance";
  const mode =
    modeRaw === "send-acceptance"
      ? "send_acceptance"
      : modeRaw === "end-to-end"
        ? "end_to_end"
        : null;
  const purpose = values.get("purpose") ?? "transactional";
  if (!mode || (purpose !== "transactional" && purpose !== "marketing")) usage();

  return {
    mode,
    purpose,
    scenario: scenarioRaw as Args["scenario"],
    targetBaseUrl: parseTargetBaseUrl(values.get("target-url") ?? null),
    workerId: process.env.NUSEND_WORKER_ID?.trim() || `ses-simulator-${crypto.randomUUID()}`,
  };
}

function parseTargetBaseUrl(value: string | null): string | null {
  if (value === null) return null;
  console.error(
    "--target-url remote validation is not implemented yet. Run the simulator on the deployed Nusend instance that receives SNS callbacks.",
  );
  process.exit(1);
}

function usage(): never {
  console.error(
    "Usage: bun src/ses/simulator-main.ts <success|bounce|complaint|ooto|suppressionlist|all> --purpose transactional|marketing --mode send-acceptance|end-to-end",
  );
  process.exit(1);
}

async function loadConfig<A>(label: string, effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configProvider)),
  ).catch((error: unknown) => {
    console.error(
      `Invalid ${label} configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
