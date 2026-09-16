import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ClientOptions } from 'openai';
import {
  Agent,
  Runner,
  tool,
} from '@openai/agents';
import { z } from 'zod';
import {
  type ParsedFlightRequest,
} from '../src/contracts/flight';
import { createOpenAIFlightRequestParser } from '../src/agent/openai-flight-request-parser';
import { createOpenAIPassengerMessageParser } from '../src/agent/openai-passenger-message-parser';
import {
  resolveHybridModelTimeout,
  runHybridSearchTurn,
} from '../src/agent/hybrid-search-agent';
import { HybridSearchSessionStore } from '../src/storage/hybrid-search-session-store';
import {
  createAIClient,
  createAIConnection,
  getAIModel,
  readAIConnectionConfig,
  sanitizeAIError,
} from '../src/agent/ai-provider';

type CapturedRequest = {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
};

const routerEnv: NodeJS.ProcessEnv = {
  AI_API_PROVIDER: '9router',
  NINE_ROUTER_API_KEY: 'router-test-key',
  NINE_ROUTER_BASE_URL: 'http://router.test/v1/',
  NINE_ROUTER_MODEL: 'cx/gpt-5.6-luna',
  NINE_ROUTER_API: 'chat_completions',
  OPENAI_API_KEY: 'openai-must-not-be-used',
  OPENAI_MODEL: 'openai-model-must-not-be-used',
};

/** Creates a fetch double that records requests without opening a socket. */
function fakeFetchFor(
  responseBody: Record<string, unknown>,
  captured: CapturedRequest[],
  delayMs = 0,
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      authorization: headers.get('authorization'),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        const signal = init?.signal;
        if (signal?.aborted) {
          clearTimeout(timer);
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    }
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as NonNullable<ClientOptions['fetch']>;
}

/** Proves an explicitly supplied timeout reaches the real string-model SDK path. */
async function testStringModelTimeoutOverride() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-provider-timeout-'));
  const previousFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];
  try {
    await withEnvironment({
      ...routerEnv,
      HYBRID_SEARCH_MODEL_TIMEOUT_MS: '10',
      AGENT_ORCHESTRATION_MODE: 'hybrid_search',
    }, async () => {
      globalThis.fetch = fakeFetchFor({
        id: 'chat-timeout-1',
        object: 'chat.completion',
        model: 'fixture-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-timeout-1',
              type: 'function',
              function: {
                name: 'ask_operator_for_clarification',
                arguments: JSON.stringify({ question: 'Bạn ưu tiên giá hay giờ bay?' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }, captured, 25) as typeof fetch;
      const result = await runHybridSearchTurn(991, 'Tìm chuyến tốt nhất', {
        model: 'fixture-model',
        modelTimeoutMs: 100,
        maxTurns: 1,
        ownerTelegramUserId: 1,
        sessionStore: new HybridSearchSessionStore(temporary),
        settingsReader: async () => ({
          agentEnabled: true,
          autoSearchFlights: true,
          autoHoldBooking: false,
          requireConfirmationBeforeHold: true,
          debugMode: false,
        }),
        logger: () => undefined,
      });
      assert.equal(result.status, 'clarification');
      assert.equal(captured.length, 1);

      const timedOut = await runHybridSearchTurn(992, 'Tìm chuyến tốt nhất', {
        model: 'fixture-model',
        modelTimeoutMs: 5,
        maxTurns: 1,
        ownerTelegramUserId: 1,
        sessionStore: new HybridSearchSessionStore(temporary),
        settingsReader: async () => ({
          agentEnabled: true,
          autoSearchFlights: true,
          autoHoldBooking: false,
          requireConfirmationBeforeHold: true,
          debugMode: false,
        }),
        logger: () => undefined,
      });
      assert.equal(timedOut.status, 'error');
      let rateLimitCalls = 0;
      globalThis.fetch = (async () => {
        rateLimitCalls++;
        return new Response(JSON.stringify({ error: { message: 'fixture rate limit', type: 'rate_limit_error' } }), {
          status: 429, headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const rateLimited = await runHybridSearchTurn(993, 'Tìm chuyến SGN HAN', {
        model: 'fixture-model', modelTimeoutMs: 1000,
        sessionStore: new HybridSearchSessionStore(temporary),
        settingsReader: async () => ({ agentEnabled: true, autoSearchFlights: true, autoHoldBooking: false, requireConfirmationBeforeHold: true, debugMode: false }),
        logger: () => undefined,
      });
      assert.equal(rateLimited.status, 'error');
      assert.equal(rateLimitCalls, 1, 'hybrid must disable underlying HTTP retries as well as model recovery on 429');
    });
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Temporarily installs environment values for an isolated provider contract. */
async function withEnvironment<T>(
  values: NodeJS.ProcessEnv,
  callback: () => Promise<T> | T,
) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

/** Verifies selector defaults, provider isolation, validation and redaction. */
function testConfigContracts() {
  const config = readAIConnectionConfig({ env: routerEnv });
  assert.equal(config.provider, '9router');
  assert.equal(config.apiKey, 'router-test-key');
  assert.equal(config.baseURL, 'http://router.test/v1');
  assert.equal(config.model, 'cx/gpt-5.6-luna');
  assert.equal(config.api, 'chat_completions');
  assert.equal(config.useResponses, false);
  assert.equal(
    getAIModel('fallback-model', undefined, routerEnv),
    'cx/gpt-5.6-luna',
  );

  assert.throws(
    () => readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_API_KEY: '' },
    }),
    /NINE_ROUTER_API_KEY/,
  );
  assert.throws(
    () => readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_MODEL: '' },
    }),
    /NINE_ROUTER_MODEL/,
  );
  assert.throws(
    () => readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_API: 'other' },
    }),
    /NINE_ROUTER_API/,
  );
  assert.throws(
    () => readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_BASE_URL: '  ' },
    }),
    /NINE_ROUTER_BASE_URL/,
  );
  assert.throws(
    () => readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_BASE_URL: 'file:///tmp/router' },
    }),
    /NINE_ROUTER_BASE_URL/,
  );
  assert.throws(
    () => readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_BASE_URL: 'http://user:pass@router.test/v1' },
    }),
    /NINE_ROUTER_BASE_URL/,
  );

  const direct = readAIConnectionConfig({
    env: { OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'legacy-model' },
    defaultModel: 'new-default',
  });
  assert.equal(direct.provider, 'openai');
  assert.equal(direct.apiKey, 'openai-key');
  assert.equal(direct.model, 'legacy-model');
  assert.equal(direct.api, undefined);
  assert.equal(
    readAIConnectionConfig({
      env: {
        ...routerEnv,
        AI_API_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'http://openai.test/v1',
        NINE_ROUTER_BASE_URL: 'bad router endpoint',
      },
    }).baseURL,
    'http://openai.test/v1',
  );
  assert.throws(
    () => readAIConnectionConfig({ env: { AI_API_PROVIDER: '9router' } }),
    /NINE_ROUTER_API_KEY/,
  );

  const sanitized = sanitizeAIError(
    new Error('Authorization: Bearer router-test-key and sk-another-secret'),
    routerEnv,
  );
  assert.doesNotMatch(sanitized, /router-test-key|another-secret/);
  assert.match(sanitized, /REDACTED/);

  assert.equal(resolveHybridModelTimeout(undefined, {}), 15_000);
  assert.equal(
    resolveHybridModelTimeout(undefined, { HYBRID_SEARCH_MODEL_TIMEOUT_MS: '30000' }),
    30_000,
  );
  assert.equal(
    resolveHybridModelTimeout(5_000, { HYBRID_SEARCH_MODEL_TIMEOUT_MS: 'bad' }),
    5_000,
  );
  assert.throws(
    () => resolveHybridModelTimeout(undefined, { HYBRID_SEARCH_MODEL_TIMEOUT_MS: 'bad' }),
    /HYBRID_SEARCH_MODEL_TIMEOUT_MS/,
  );
}

/** Verifies the shared client uses the selected base URL, path and key. */
async function testChatTransport() {
  const captured: CapturedRequest[] = [];
  const config = readAIConnectionConfig({ env: routerEnv });
  const client = createAIClient({
    config,
    fetch: fakeFetchFor({
      id: 'chat-1',
      object: 'chat.completion',
      model: config.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
    }, captured),
  });
  await client.chat.completions.create({
    model: config.model,
    messages: [{ role: 'user', content: 'test' }],
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'http://router.test/v1/chat/completions');
  assert.equal(captured[0].authorization, 'Bearer router-test-key');
  assert.equal(captured[0].body.model, 'cx/gpt-5.6-luna');
  assert.equal(captured[0].body.messages instanceof Array, true);
}

/** Verifies Agents function-tool requests on both configured transports. */
async function testSDKFunctionToolTransport() {
  for (const api of ['chat_completions', 'responses'] as const) {
    const captured: CapturedRequest[] = [];
    const config = readAIConnectionConfig({
      env: { ...routerEnv, NINE_ROUTER_API: api },
    });
    const response = api === 'chat_completions'
      ? {
        id: 'chat-tool-1',
        object: 'chat.completion',
        model: config.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-tool-1',
              type: 'function',
              function: { name: 'fixture_tool', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }
      : {
        id: 'resp-tool-1',
        object: 'response',
        model: config.model,
        status: 'completed',
        output: [{
          type: 'function_call',
          id: 'fc-tool-1',
          call_id: 'call-tool-1',
          name: 'fixture_tool',
          arguments: '{}',
          status: 'completed',
        }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      };
    const connection = createAIConnection({
      config,
      fetch: fakeFetchFor(response, captured),
    });
    let executed = 0;
    const agent = new Agent({
      name: `Provider-${api}`,
      model: config.model,
      toolUseBehavior: 'stop_on_first_tool',
      tools: [tool({
        name: 'fixture_tool',
        description: 'Test-only function tool.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => {
          executed += 1;
          return 'fixture';
        },
      })],
    });
    const result = await new Runner({
      tracingDisabled: true,
      modelProvider: connection.modelProvider,
    }).run(agent, 'call the fixture tool', { maxTurns: 1 });
    assert.equal(executed, 0);
    assert.equal(result.interruptions.length, 1);
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].url,
      `http://router.test/v1/${api === 'chat_completions' ? 'chat/completions' : 'responses'}`,
    );
    assert.equal(captured[0].authorization, 'Bearer router-test-key');
    assert.equal(captured[0].body.model, 'cx/gpt-5.6-luna');
    assert.ok(
      Array.isArray(captured[0].body.tools)
        || Array.isArray(captured[0].body.input),
    );
  }
}

/** Verifies injected parser clients continue to bypass credential construction. */
async function testInjectedParserClients() {
  await withEnvironment({}, async () => {
    let flightModel: unknown;
    const flightParser = createOpenAIFlightRequestParser({
      model: 'injected-flight-model',
      client: {
        chat: {
          completions: {
            async parse(input: unknown) {
              flightModel = (input as { model: string }).model;
              return {
                choices: [{
                  message: {
                    parsed: {
                      fromAirportCode: 'SGN', fromAirportText: 'Sài Gòn',
                      toAirportCode: 'HAN', toAirportText: 'Hà Nội',
                      departureDate: '2099-01-01', returnDate: null,
                      tripType: 'one_way', preferredTime: null, specificTime: null,
                      resultRanking: null, preferredAirlineCodes: null,
                      missingFields: [],
                    } satisfies ParsedFlightRequest,
                  },
                }],
              };
            },
          },
        },
      },
    });
    assert.equal((await flightParser.parse('test')).departureDate, '2099-01-01');
    assert.equal(flightModel, 'injected-flight-model');

    let passengerModel: unknown;
    const passengerParser = createOpenAIPassengerMessageParser({
      model: 'injected-passenger-model',
      client: {
        chat: {
          completions: {
            async parse(input: unknown) {
              passengerModel = (input as { model: string }).model;
              return {
                choices: [{
                  message: {
                    parsed: {
                      intent: 'confirm_passenger',
                      caseCode: null,
                      passengerMentions: [],
                      missingFields: [],
                      confidence: 1,
                    },
                  },
                }],
              };
            },
          },
        },
      },
    });
    assert.equal((await passengerParser.parse('x')).intent, 'confirm_passenger');
    assert.equal(passengerModel, 'injected-passenger-model');
  });
}

async function main() {
  testConfigContracts();
  await testChatTransport();
  await testSDKFunctionToolTransport();
  await testStringModelTimeoutOverride();
  await testInjectedParserClients();
  console.log('AI provider contracts passed: config isolation, chat/responses transport, SDK tools, and injected clients. No network calls.');
}

main().catch((error) => {
  console.error(sanitizeAIError(error));
  process.exitCode = 1;
});
