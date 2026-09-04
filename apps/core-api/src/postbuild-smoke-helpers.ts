const SAFE_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
] as const;

export type SmokeResponse = {
  status: number;
  contentType: string;
  body: string;
};

export type SmokeResults = {
  health: SmokeResponse;
  root: SmokeResponse;
  deepLink: SmokeResponse;
  missingApi: SmokeResponse;
};

export function createSmokeEnvironment(source: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  return {
    ...environment,
    NODE_ENV: 'test',
    CHARTER_ENV: 'test',
    RAZORPAY_MODE: 'test',
    LOG_LEVEL: 'error',
    PORT: String(port),
  };
}

function assertResponse(
  label: string,
  response: SmokeResponse,
  expectedStatus: number,
  expectedContentType: string,
): void {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}; expected ${expectedStatus}`);
  }
  if (!response.contentType.toLowerCase().includes(expectedContentType)) {
    throw new Error(
      `${label} returned content-type ${response.contentType || '(missing)'}; expected ${expectedContentType}`,
    );
  }
}

export function validateSmokeResults(results: SmokeResults): void {
  assertResponse('health', results.health, 200, 'application/json');
  assertResponse('root SPA page', results.root, 200, 'text/html');
  assertResponse('SPA deep link', results.deepLink, 200, 'text/html');
  assertResponse('missing API path', results.missingApi, 404, 'application/json');

  const health = JSON.parse(results.health.body) as { ok?: unknown };
  if (health.ok !== true) {
    throw new Error('health response did not contain {"ok":true}');
  }
}
