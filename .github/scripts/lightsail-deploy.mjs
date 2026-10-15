// Deploys an image to the Charter Lightsail container service by copying the live deployment
// and swapping only the image. Runtime secrets stay in Lightsail and never pass through GitHub.
// AWS responses carry those secrets, so they are parsed in memory: only non-secret fields are
// printed, and on Actions every other environment value is registered as a log mask first.
//
//   node .github/scripts/lightsail-deploy.mjs prepare         mask secrets, output Vite build args
//   node .github/scripts/lightsail-deploy.mjs deploy <image>  deploy <image>, wait for ACTIVE
//   node .github/scripts/lightsail-deploy.mjs smoke <url>     /health ok+db, MCP initialize
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVICE_NAME = process.env.SERVICE_NAME ?? 'charter';
const CONTAINER_NAME = process.env.CONTAINER_NAME ?? 'app';
const ON_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

// Values of these keys are public (shipped to browsers) or plain config. Everything else is masked.
const PUBLIC_KEYS = new Set([
  'CHARTER_DAILY_TURNS_GLOBAL',
  'CHARTER_DAILY_TURNS_PER_USER',
  'CHARTER_ENV',
  'CHARTER_PUBLIC_URL',
  'FIREWORKS_MODEL',
  'LANGFUSE_HOST',
  'LOG_LEVEL',
  'PORT',
  'RAZORPAY_MODE',
  'SUPABASE_JWT_AUDIENCE',
  'SUPABASE_JWT_ISSUER',
  'SUPABASE_JWT_JWKS_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_URL',
  'TRUST_PROXY_HOPS',
]);

class DeployError extends Error {}

function fail(message) {
  throw new DeployError(message);
}

function aws(args) {
  // stderr is inherited for CLI errors; stdout holds the response and is never printed, not even
  // through an exception (Node prints an uncaught error's stdout property and JSON.parse quotes its
  // input), so both failures become plain messages.
  const operation = `aws ${args.slice(0, 2).join(' ')}`;
  let stdout;
  try {
    stdout = execFileSync('aws', [...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return fail(`${operation} failed (exit ${error.status ?? error.code})`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return fail(`${operation} returned output that is not JSON`);
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

function maskSecrets(environment) {
  // Off Actions an ::add-mask:: line would print the secret itself, so only emit it on a runner.
  if (!ON_ACTIONS) {
    return;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (PUBLIC_KEYS.has(key)) {
      continue;
    }
    for (const line of String(value).split(/\r?\n/)) {
      if (line.length >= 6) {
        console.log(`::add-mask::${line}`);
      }
    }
  }
}

function getService() {
  const service = aws(['lightsail', 'get-container-services', '--service-name', SERVICE_NAME])
    .containerServices?.[0];
  if (!service) {
    fail(`Lightsail container service ${SERVICE_NAME} not found`);
  }
  return service;
}

function liveContainer(service) {
  const container = service.currentDeployment?.containers?.[CONTAINER_NAME];
  if (!container) {
    fail(`No live deployment of container ${CONTAINER_NAME} to copy the environment from`);
  }
  return container;
}

// Lightsail rejects a new deployment while another one is still activating.
async function waitUntilIdle() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const service = getService();
    if (service.state === 'RUNNING' || service.state === 'READY') {
      return service;
    }
    if (!['DEPLOYING', 'UPDATING', 'PENDING'].includes(service.state)) {
      fail(`Lightsail service ${SERVICE_NAME} is ${service.state}`);
    }
    console.log(`Lightsail service is ${service.state}; waiting`);
    await sleep(10_000);
  }
  return fail(`Lightsail service ${SERVICE_NAME} stayed busy for 10 minutes`);
}

async function prepare() {
  const service = await waitUntilIdle();
  const container = liveContainer(service);
  const environment = container.environment ?? {};
  maskSecrets(environment);

  const url = environment.SUPABASE_URL ?? '';
  const key = environment.SUPABASE_PUBLISHABLE_KEY ?? '';
  if (!url.startsWith('https://')) {
    fail('SUPABASE_URL in the live deployment is not an https URL');
  }
  // Vite bakes this into public JavaScript, so anything but a browser-safe key is refused.
  if (!key.startsWith('sb_publishable_')) {
    fail('SUPABASE_PUBLISHABLE_KEY in the live deployment is not an sb_publishable_ key');
  }
  setOutput('vite_supabase_url', url);
  setOutput('vite_supabase_publishable_key', key);
  console.log(`Live: v${service.currentDeployment.version} ${container.image}`);
}

async function deploy(image) {
  if (!image) {
    fail('Usage: lightsail-deploy.mjs deploy <image>');
  }
  const service = await waitUntilIdle();
  const live = service.currentDeployment;
  maskSecrets(liveContainer(service).environment ?? {});

  const containers = structuredClone(live.containers);
  containers[CONTAINER_NAME].image = image;
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'charter-deploy-'));
  let version;
  try {
    const input = join(dir, 'deployment.json');
    writeFileSync(
      input,
      JSON.stringify({
        serviceName: SERVICE_NAME,
        containers,
        publicEndpoint: live.publicEndpoint,
      }),
      { mode: 0o600 },
    );
    const created = aws([
      'lightsail',
      'create-container-service-deployment',
      '--cli-input-json',
      `file://${input}`,
    ]);
    version = created.containerService?.nextDeployment?.version;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!Number.isInteger(version)) {
    fail('Lightsail did not report the new deployment version');
  }
  console.log(`Created deployment v${version} of ${image} (live was v${live.version})`);

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const { deployments = [] } = aws([
      'lightsail',
      'get-container-service-deployments',
      '--service-name',
      SERVICE_NAME,
    ]);
    const state = deployments.find((deployment) => deployment.version === version)?.state;
    if (state === 'ACTIVE') {
      console.log(`Deployment v${version} is ACTIVE`);
      summary(`Deployed \`${image}\` as Lightsail deployment v${version} (was v${live.version}).`);
      return;
    }
    if (state === 'FAILED' || state === 'INACTIVE') {
      fail(
        `Deployment v${version} is ${state}; Lightsail keeps v${live.version} serving. ` +
          'Check the container logs in the Lightsail console.',
      );
    }
    console.log(`Deployment v${version} is ${state ?? 'pending'}`);
    await sleep(10_000);
  }
  fail(`Deployment v${version} did not become ACTIVE within 15 minutes`);
}

async function smoke(baseUrl) {
  if (!baseUrl) {
    fail('Usage: lightsail-deploy.mjs smoke <url>');
  }
  let health;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      health = await response.json();
      if (response.ok && health.ok === true && health.db === true) {
        break;
      }
      console.log(`/health: HTTP ${response.status} ok=${health.ok} db=${health.db}`);
    } catch (error) {
      console.log(`/health: ${error.message}`);
    }
    if (attempt === 18) {
      fail(`${baseUrl}/health did not report ok and db within 3 minutes`);
    }
    await sleep(10_000);
  }
  const { ok, db, env, persistence, paymentsConfigured, fireworksConfigured, vapiConfigured } =
    health;
  console.log(
    'Health:',
    JSON.stringify({
      ok,
      db,
      env,
      persistence,
      paymentsConfigured,
      fireworksConfigured,
      vapiConfigured,
    }),
  );

  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'charter-deploy-smoke', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const rpc = await response.json().catch(() => null);
  const server = rpc?.result?.serverInfo;
  if (!response.ok || server?.name !== 'charter-commerce') {
    fail(
      `MCP initialize failed: HTTP ${response.status} ${JSON.stringify(rpc?.error ?? rpc ?? null)}`,
    );
  }
  console.log(`MCP: ${server.name} ${server.version}, protocol ${rpc.result.protocolVersion}`);
  summary(`Smoke: \`/health\` ok and db, MCP \`initialize\` answered by ${server.name}.`);
}

const [command, argument] = process.argv.slice(2);
const commands = { prepare, deploy, smoke };
try {
  if (!commands[command]) {
    fail('Usage: lightsail-deploy.mjs prepare | deploy <image> | smoke <url>');
  }
  await commands[command](argument);
} catch (error) {
  if (!(error instanceof DeployError)) {
    throw error;
  }
  console.log(ON_ACTIONS ? `::error::${error.message}` : error.message);
  process.exitCode = 1;
}
