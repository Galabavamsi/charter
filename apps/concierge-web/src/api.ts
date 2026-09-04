export const API = '/api';

export type AccessTokenProvider = () => Promise<string | null>;
export type ApiClient = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

type ApiDependencies = {
  getAccessToken?: AccessTokenProvider;
  httpFetch?: typeof fetch;
};

type ErrorBody = {
  error?: unknown;
  message?: unknown;
  requestId?: unknown;
};

let currentAccessToken: AccessTokenProvider = async () => null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(input: {
    status: number;
    code: string;
    requestId?: string | null;
    message?: string;
  }) {
    super(input.message ?? input.code);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
  }
}

export function setAccessTokenProvider(provider: AccessTokenProvider): void {
  currentAccessToken = provider;
}

export function getAccessToken(): Promise<string | null> {
  return currentAccessToken();
}

function apiPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/')) {
    throw new ApiError({ status: 0, code: 'API_PATH_INVALID' });
  }
  return `${API}${path}`;
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  dependencies: ApiDependencies = {},
): Promise<T> {
  const url = apiPath(path);
  const token = await (dependencies.getAccessToken ?? currentAccessToken)();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  headers.accept ??= 'application/json';
  if (init.body !== undefined && init.body !== null && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await (dependencies.httpFetch ?? fetch)(url, {
      ...init,
      headers,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new ApiError({ status: 0, code: 'TURN_TIMEOUT' });
    }
    throw error;
  }
  const body = await responseBody(response);
  if (!response.ok) {
    const errorBody = body && typeof body === 'object' ? (body as ErrorBody) : {};
    const code =
      typeof errorBody.error === 'string' ? errorBody.error : `HTTP_${response.status || 'ERROR'}`;
    const requestId =
      typeof errorBody.requestId === 'string'
        ? errorBody.requestId
        : response.headers.get('x-request-id');
    throw new ApiError({
      status: response.status,
      code,
      requestId,
      ...(typeof errorBody.message === 'string' ? { message: errorBody.message } : {}),
    });
  }
  return body as T;
}

export async function fetchPendingConversationSnapshot<T>(input: {
  conversationId: string;
  shopSlug: string | null;
  getAccessToken?: AccessTokenProvider;
  httpFetch?: typeof fetch;
}): Promise<T | null> {
  if (!input.shopSlug) {
    return null;
  }
  let getAccessToken: AccessTokenProvider | undefined;
  if (input.getAccessToken) {
    const token = await input.getAccessToken();
    if (!token) {
      return null;
    }
    getAccessToken = async () => token;
  }
  const query = new URLSearchParams({
    shopSlug: input.shopSlug,
    takeCheckout: '1',
  });
  return apiFetch<T>(
    `/v1/conversations/${input.conversationId}?${query.toString()}`,
    {},
    {
      ...(getAccessToken ? { getAccessToken } : {}),
      ...(input.httpFetch ? { httpFetch: input.httpFetch } : {}),
    },
  );
}
