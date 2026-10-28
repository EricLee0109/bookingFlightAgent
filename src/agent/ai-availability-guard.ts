import { sanitizeAIError } from './ai-provider';

/**
 * Failure categories exposed to the Telegram operator.
 *
 * The operator needs to know whether retrying the same wording can help, so the
 * transport never shows one generic "I could not read this" message for every
 * failure mode. Provider-outage categories are deliberately explicit because an
 * operator who retypes a request five times cannot fix a missing credit balance.
 */
export type AIFailureCategory =
  | 'configuration'
  | 'quota'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'response_format'
  | 'refusal'
  | 'unreachable';

export type AIClassifiedFailure = {
  category: AIFailureCategory;
  /** Sanitized technical detail for local logs only; never sent to Telegram. */
  detail: string;
  /** Categories where the same request text cannot succeed by retyping. */
  retryWithSameTextUseful: boolean;
};

/** Provider failures that must stop further calls until the breaker expires. */
const CIRCUIT_BREAKING_CATEGORIES: ReadonlySet<AIFailureCategory> = new Set([
  'quota',
  'authentication',
  'configuration',
]);

const DEFAULT_COOLDOWN_MS = 5 * 60_000;

type BreakerState = {
  openUntil: number;
  failure: AIClassifiedFailure;
};

/**
 * Remembers a provider outage in this process so repeated messages fail fast.
 *
 * Without this, every message pays the full upstream latency only to fail with
 * the same reason. The breaker is in-memory on purpose: a process restart
 * re-probes the provider, which is the cheapest safe recovery path.
 */
export class AIAvailabilityGuard {
  private state: BreakerState | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
  ) {}

  /** Returns the open failure, or clears an expired breaker. */
  currentFailure(): AIClassifiedFailure | null {
    if (!this.state) return null;
    if (this.now() < this.state.openUntil) return this.state.failure;
    this.state = null;
    return null;
  }

  recordFailure(failure: AIClassifiedFailure) {
    if (!CIRCUIT_BREAKING_CATEGORIES.has(failure.category)) return;
    this.state = { openUntil: this.now() + this.cooldownMs, failure };
  }

  /** Clears the breaker after a successful provider call. */
  recordSuccess() {
    this.state = null;
  }
}

/**
 * Classifies an error thrown by any AI call without trusting error prose alone.
 *
 * Status codes from OpenAI SDK errors are checked first because their message
 * text is provider-specific. Message matching is the fallback for wrapped or
 * proxied errors that lose their status.
 */
export function classifyAIError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AIClassifiedFailure {
  const detail = sanitizeAIError(error, env);
  const status = readStatus(error);
  // Node network errors keep their code on the object, not in the message.
  const code = readErrorCode(error);
  const message = code ? `${detail} ${code}` : detail;
  const category = classify(status, message.toLowerCase());

  return {
    category,
    detail,
    retryWithSameTextUseful: category === 'response_format'
      || category === 'refusal',
  };
}

function classify(status: number | undefined, message: string): AIFailureCategory {
  if (status === 401 || /invalid_api_key|incorrect api key|unauthorized/.test(message)) {
    return 'authentication';
  }
  // 402 means payment is required, which is a balance problem regardless of the
  // wording the provider chose. For 429/403 a quota signal is required so a
  // plain rate limit or permission error is not mislabeled as a credit outage.
  if (status === 402 || hasQuotaSignal(message)) {
    return 'quota';
  }
  if (status === 429) return 'rate_limit';
  if (status === 403) return 'provider';
  if (status === 404) return 'configuration';
  if (status !== undefined && status >= 500) return 'provider';
  if (/timeout|timed out|etimedout|aborted/.test(message)) return 'timeout';
  if (/enotfound|econnrefused|econnreset|network|fetch failed|socket hang up/.test(message)) {
    return 'network';
  }  if (/missing [a-z0-9_]+api_key|requires [a-z0-9_]+_?model|unsupported ai_api_provider|unsupported nine_router_api/.test(message)) {
    return 'configuration';
  }
  if (/refused the request/.test(message)) return 'refusal';
  if (/invalid structured output|invalid json|did not match schema|response format/.test(message)) {
    return 'response_format';
  }
  if (status !== undefined) return 'provider';
  return 'unreachable';
}

function hasQuotaSignal(message: string) {
  return /no credits remaining|insufficient_quota|exceeded your current quota|billing|quota/.test(message);
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Reads a Node/libuv error code (`ECONNREFUSED`, `ETIMEDOUT`, ...) if present. */
function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.toLowerCase() : undefined;
}
