import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MONEY_API = 'http://127.0.0.1:3010';
export const MONEY_PROVIDER = 'http://127.0.0.1:3101';
export const MONEY_APP = 'http://127.0.0.1:5174';
export const MONEY_KEY_SECRET = 'rzp_test_e2e_harness_secret';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];

async function probeJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(label);
}

function spawnLogged(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    shell: true,
    stdio: 'pipe',
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

function stopChild(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

export async function startMoneyContractStack(): Promise<void> {
  const health = await probeJson(`${MONEY_API}/health`);
  if (health && typeof health === 'object' && health !== null && 'e2eHarness' in health) {
    const ready = (health as { e2eHarness?: unknown }).e2eHarness === true;
    if (!ready) {
      throw new Error('E2E_MONEY_HARNESS_PORT_BUSY');
    }
  } else if (health) {
    throw new Error('E2E_MONEY_HARNESS_PORT_BUSY');
  } else {
    spawnLogged('pnpm', ['--filter', '@charter/core-api', 'e2e:money-api'], REPO_ROOT, {
      CHARTER_E2E_HARNESS: '1',
      CHARTER_E2E_API_PORT: '3010',
      CHARTER_E2E_RAZORPAY_PORT: '3101',
    });
    await waitFor('E2E_MONEY_HARNESS_UNAVAILABLE', async () => {
      const body = await probeJson(`${MONEY_API}/health`);
      return Boolean(
        body && typeof body === 'object' && (body as { e2eHarness?: unknown }).e2eHarness === true,
      );
    });
  }

  try {
    const spa = await fetch(MONEY_APP, { method: 'HEAD' });
    if (spa.ok) {
      return;
    }
  } catch {
    /* start a dedicated Vite that proxies only to the harness */
  }

  spawnLogged(
    'pnpm',
    ['exec', 'vite', '--config', 'e2e/vite.money.config.ts', '--port', '5174', '--strictPort'],
    WEB_ROOT,
    {},
  );
  await waitFor('E2E_MONEY_VITE_UNAVAILABLE', async () => {
    try {
      const response = await fetch(MONEY_APP);
      return response.ok;
    } catch {
      return false;
    }
  });
}

export async function stopMoneyContractStack(): Promise<void> {
  for (const child of children.splice(0)) {
    stopChild(child);
  }
}
