import OpenAI, { type ClientOptions } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { type ZodType } from 'zod';
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

/**
 * Minimal transport surface shared by the real SDK client and test doubles.
 *
 * Both parsers declare their own structurally-compatible client type, so the
 * helper must not require the concrete `OpenAI` class.
 */
type ChatMessage = { role: 'system' | 'user'; content: string };

type StructuredMessage = {
  parsed?: unknown;
  content?: string | null;
  refusal?: string | null;
};

export type ChatCompletionsClient = {
  chat: {
    completions: {
      // Deliberately loose: callers pass their own structurally-compatible
      // client types, so the helper is cast at the call boundary instead of
      // narrowing every caller to the concrete SDK type.
      parse?: (input: any) => Promise<any>;
      create?: (input: any) => Promise<any>;
    };
  };
};

/**
 * Parses one chat completion into a Zod schema across both transports.
 *
 * Direct OpenAI returns `choices[0].message.parsed` already validated by the
 * SDK. 9Router does not emit that field and, for OpenAI-shaped providers, only
 * appends the JSON schema to the system prompt instead of enforcing it at the
 * provider level (older models answered with invented keys for the passenger
 * schema). The router path therefore validates the content locally and repairs
 * it once with the concrete schema errors before failing.
 *
 * Errors intentionally reuse the historical wording so failure categories,
 * operator messages and existing contracts keep behaving the same.
 */
export async function parseChatCompletionWithSchema<T>(
  client: ChatCompletionsClient,
  config: AIConnectionConfig,
  request: {
    messages: ChatMessage[];
    responseFormat: ReturnType<typeof zodResponseFormat>;
    schema: ZodType<T>;
  },
): Promise<T> {
  const isRouter = config.provider === '9router';
  const messages = [...request.messages];

  if (!isRouter) {
    if (typeof client?.chat?.completions?.parse !== 'function') {
      throw new Error('AI client does not support structured output parsing.');
    }
    const completion = await (client.chat.completions.parse as (i: any) => Promise<any>)({
      model: config.model,
      messages,
      response_format: request.responseFormat,
    });
    const message = completion.choices[0]?.message;

    if (message?.refusal) {
      throw new Error(`OpenAI parser refused the request: ${message.refusal}`);
    }
    if (!message?.parsed) {
      const contentPreview = message?.content?.slice(0, 200) ?? 'empty content';

      throw new Error(
        `OpenAI parser returned invalid structured output: ${contentPreview}`,
      );
    }
    return request.schema.parse(message.parsed) as T;
  }

  if (typeof client?.chat?.completions?.create !== 'function') {
    throw new Error('AI client does not support chat completions.');
  }

  const attempt = async (attemptMessages: ChatMessage[]) => {
    const completion = await (client.chat.completions.create as (i: any) => Promise<any>)({
      model: config.model,
      messages: attemptMessages,
      response_format: request.responseFormat,
    });
    const message = completion.choices[0]?.message;

    if (message?.refusal) {
      throw new Error(`OpenAI parser refused the request: ${message.refusal}`);
    }
    return message?.content ?? '';
  };

  const parsed = await validateRouterContent(await attempt(messages), request.schema);

  if (!parsed.ok) {
    // One repair attempt: the router cannot enforce the schema, so show the
    // model the exact validation errors instead of asking the operator again.
    const repairMessages: ChatMessage[] = [
      ...messages,
      {
        role: 'user',
        content: [
          'Your previous reply did not match the required JSON schema.',
          `Validation errors: ${JSON.stringify(parsed.issues).slice(0, 600)}`,
          'Reply with ONLY a single JSON object that matches the schema exactly.',
        ].join('\n'),
      },
    ];
    const repaired = await validateRouterContent(await attempt(repairMessages), request.schema);

    if (!repaired.ok) {
      throw new Error(
        `OpenAI parser returned invalid structured output: ${repaired.content.slice(0, 200) || 'empty content'}`,
      );
    }
    return repaired.value;
  }

  return parsed.value;
}

type RouterValidation<T> =
  | { ok: true; value: T }
  | { ok: false; content: string; issues: unknown };

/** Validates router JSON content, tolerating fenced or wrapped JSON output. */
async function validateRouterContent<T>(
  content: string,
  schema: ZodType<T>,
): Promise<RouterValidation<T>> {
  let jsonText = content.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  }
  // Some providers wrap the object in prose; take the outermost object.
  if (!jsonText.startsWith('{')) {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start !== -1 && end > start) jsonText = jsonText.slice(start, end + 1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, content, issues: [{ message: 'response was not valid JSON' }] };
  }

  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  return {
    ok: false,
    content,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** Removes configured and bearer-style keys before an AI error is logged. */export function sanitizeAIError(error: unknown, env: NodeJS.ProcessEnv = process.env) {
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
