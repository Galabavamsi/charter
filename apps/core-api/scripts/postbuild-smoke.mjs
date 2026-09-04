import { access } from 'node:fs/promises';
import { log } from 'node:console';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { createSmokeEnvironment, validateSmokeResults } from '../dist/postbuild-smoke-helpers.js';

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const startupTimeoutMs = 20_000;

function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Unable to reserve an available TCP port'));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function responseSnapshot(baseUrl, path) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    signal: globalThis.AbortSignal.timeout(2_000),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

async function waitForHealth(baseUrl, child, childOutput) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Built server exited during startup${childOutput()}`);
    }
    try {
      const response = await responseSnapshot(baseUrl, '/health');
      if (response.status === 200) {
        return response;
      }
      lastError = new Error(`Health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(
    `Built server did not become healthy within ${startupTimeoutMs}ms: ${String(lastError)}${childOutput()}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(5_000)]);
  }
}

await access(serverPath);
const port = await reserveAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [serverPath], {
  cwd: tmpdir(),
  env: createSmokeEnvironment(process.env, port),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
const appendOutput = (chunk) => {
  output = `${output}${String(chunk)}`.slice(-8_000);
};
child.stdout.on('data', appendOutput);
child.stderr.on('data', appendOutput);
child.on('error', appendOutput);
const childOutput = () => (output.trim() ? `\nChild output:\n${output.trim()}` : '');

try {
  const health = await waitForHealth(baseUrl, child, childOutput);
  const results = {
    health,
    root: await responseSnapshot(baseUrl, '/'),
    deepLink: await responseSnapshot(baseUrl, '/shops/northstar'),
    missingApi: await responseSnapshot(baseUrl, '/api/v1/postbuild-smoke-missing'),
  };
  validateSmokeResults(results);
  log('Built artifact smoke passed: /health, /, SPA deep link, and JSON API 404.');
} finally {
  await stopChild(child);
}
