import OpenAI, { type ClientOptions } from 'openai';
import { OpenAIProvider } from '@openai/agents';

export type AIAPIProvider = 'openai' | '9router';
export type AIRouterAPI = 'chat_completions' | 'responses';

export const DEFAULT_NINE_ROUTER_BASE_URL = 'http://localhost:20128/v1';

export type AIConnectionConfig = {
  provider: AIAPIProvider;
  apiKey?: string;
  baseURL?: string;
  model: string;
  api?: AIRouterAPI;
  useResponses?: boolean;
};

export type AIConnectionOptions = {
  env?: NodeJS.ProcessEnv;
  model?: string;
  defaultModel?: string;
  /** Test-only escape hatch for callers that provide their own client/model. */
  requireCredentials?: boolean;
};

export type AIClientOptions = AIConnectionOptions & {
  config?: AIConnectionConfig;
  fetch?: ClientOptions['fetch'];
  /** Callers with their own bounded recovery can disable transport retries. */
  maxRetries?: number;
};

export type AIConnection = {
  config: AIConnectionConfig;
  client: OpenAI;
  modelProvider: OpenAIProvider;
};

type SDKOpenAIClient = NonNullable<
  NonNullable<ConstructorParameters<typeof OpenAIProvider>[0]>['openAIClient']
>;

/** Reads one validated provider configuration without ever mixing provider keys. */
export function readAIConnectionConfig(
  options: AIConnectionOptions = {},
): AIConnectionConfig {
  const env = options.env ?? process.env;
  const rawProvider = env.AI_API_PROVIDER?.trim() || 'openai';
  const provider = parseProvider(rawProvider);
  const requireCredentials = options.requireCredentials !== false;

  if (provider === '9router') {
    const apiKey = env.NINE_ROUTER_API_KEY?.trim() || undefined;
    if (requireCredentials && !apiKey) {
      throw new Error(
        'Missing NINE_ROUTER_API_KEY. AI provider "9router" requires NINE_ROUTER_API_KEY.',
      );
    }

    const model = options.model?.trim() || env.NINE_ROUTER_MODEL?.trim();
    if (!model) {
      throw new Error(
        'AI provider "9router" requires NINE_ROUTER_MODEL.',
      );
    }

    const api = parseRouterAPI(env.NINE_ROUTER_API);
    return {
      provider,
      apiKey,
      baseURL: normalizeRouterBaseURL(
        env.NINE_ROUTER_BASE_URL === undefined
          ? DEFAULT_NINE_ROUTER_BASE_URL
          : env.NINE_ROUTER_BASE_URL,
      ),
      model,
      api,
      useResponses: api === 'responses',
    };
  }

  const apiKey = env.OPENAI_API_KEY?.trim() || undefined;
  if (requireCredentials && !apiKey) {
    throw new Error(
      'Missing OPENAI_API_KEY. AI provider "openai" requires OPENAI_API_KEY.',
    );
  }

  return {
    provider,
    apiKey,
    // OPENAI_BASE_URL remains compatible with the OpenAI SDK's existing env.
    baseURL: env.OPENAI_BASE_URL?.trim() || undefined,
    model:
      options.model?.trim()
      || env.OPENAI_MODEL?.trim()
      || options.defaultModel?.trim()
      || 'gpt-5.4-mini',
    // Leave direct OpenAI transport selection undefined so the SDK keeps its
    // existing default (currently Responses) and old env behavior.
    api: undefined,
    useResponses: undefined,
  };
}

/** Resolves the effective model while allowing injected test clients/models. */
export function getAIModel(
  defaultModel: string,
  model?: string,
  env?: NodeJS.ProcessEnv,
) {
  return readAIConnectionConfig({
    env,
    model,
    defaultModel,
    requireCredentials: false,
  }).model;
}

/** Creates the OpenAI-compatible client for the already-selected provider. */
export function createAIClient(options: AIClientOptions = {}) {
  const config = options.config ?? readAIConnectionConfig(options);
  const clientOptions: ClientOptions = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  };
  if (options.fetch) clientOptions.fetch = options.fetch;
  if (options.maxRetries !== undefined) clientOptions.maxRetries = options.maxRetries;
  return new OpenAI(clientOptions);
}

/** Creates the Agents SDK provider over the shared provider client. */
export function createAIModelProvider(options: AIClientOptions = {}) {
  const config = options.config ?? readAIConnectionConfig(options);
  const client = createAIClient({ ...options, config });
  return new OpenAIProvider({
    // The app pins a direct OpenAI SDK version while Agents carries its own
    // compatible version; both clients share the same runtime surface.
    openAIClient: client as unknown as SDKOpenAIClient,
    useResponses: config.useResponses,
  });
}

/** Creates one validated config, client, and SDK provider for a model turn. */
export function createAIConnection(
  options: AIClientOptions = {},
): AIConnection {
  const config = options.config ?? readAIConnectionConfig(options);
  const client = createAIClient({ ...options, config });
  const modelProvider = new OpenAIProvider({
    // See createAIModelProvider for the SDK's nominal-version boundary.
    openAIClient: client as unknown as SDKOpenAIClient,
    useResponses: config.useResponses,
  });
  return { config, client, modelProvider };
}

/** Removes configured and bearer-style keys before an AI error is logged. */
export function sanitizeAIError(error: unknown, env: NodeJS.ProcessEnv = process.env) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [env.OPENAI_API_KEY, env.NINE_ROUTER_API_KEY]) {
    if (key) message = message.replaceAll(key, '[REDACTED]');
  }
  return message
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}

/** Parses the provider selector and rejects accidental silent fallback. */
function parseProvider(value: string): AIAPIProvider {
  if (value === 'openai' || value === '9router') return value;
  throw new Error(
    `Unsupported AI_API_PROVIDER "${value}". Use "openai" or "9router".`,
  );
}

/** Parses the optional router transport selector. */
function parseRouterAPI(value: string | undefined): AIRouterAPI {
  const api = value?.trim() || 'chat_completions';
  if (api === 'chat_completions' || api === 'responses') return api;
  throw new Error(
    `Unsupported NINE_ROUTER_API "${api}". Use "chat_completions" or "responses".`,
  );
}

/** Validates and normalizes the router endpoint before any request is possible. */
function normalizeRouterBaseURL(value: string) {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('NINE_ROUTER_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('NINE_ROUTER_BASE_URL must be an absolute HTTP(S) URL without credentials or query parameters.');
  }
  return trimmed.replace(/\/+$/, '');
}
