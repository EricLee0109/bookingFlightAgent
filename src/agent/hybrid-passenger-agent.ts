import {
  Agent,
  Runner,
  tool,
  type Model,
} from '@openai/agents';
import { z } from 'zod';
import type { CustomerPassengerInfo } from '../passengers/customer-passenger-types';
import {
  createAIConnection,
  getAIModel,
} from './ai-provider';

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_MODEL_TIMEOUT_MS = 15_000;
const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;

export type HybridPassengerIntent =
  | 'provide'
  | 'greeting'
  | 'search'
  | 'lookup'
  | 'cancel'
  | 'unknown';

export type HybridPassengerAgentOptions = {
  /** Existing draft is context only. It is never treated as current evidence. */
  draft?: Partial<CustomerPassengerInfo>;
  pendingFields?: Array<keyof CustomerPassengerInfo>;
  /** A real Agents SDK model or a provider model name. */
  model?: Model | string;
  now?: Date;
  modelTimeoutMs?: number;
  /** Enables the owner-scoped saved-passenger lookup intent. */
  browseMode?: boolean;
};

export type HybridPassengerInterpretation = {
  intent: HybridPassengerIntent;
  patch: Partial<CustomerPassengerInfo>;
  issues: string[];
  /** Fields explicitly proposed by the model but rejected by current-message validation. */
  invalidFields?: Array<keyof CustomerPassengerInfo>;
  /** Present only for a validated browse-mode lookup. */
  query?: string;
};

type PassengerProposal = z.infer<typeof PassengerProposalSchema>;

const PassengerProposalSchema = z.object({
  intent: z.enum([
    'provide',
    'greeting',
    'search',
    'lookup',
    'cancel',
    'unknown',
  ]),
  /** Full names are accepted as evidence, then split deterministically. */
  fullName: z.string().trim().max(240).nullable().optional(),
  lastName: z.string().trim().max(100).nullable().optional(),
  firstName: z.string().trim().max(150).nullable().optional(),
  gender: z.enum(['M', 'F']).nullable().optional(),
  dob: z.string().trim().max(32).nullable().optional().describe('Date of birth as YYYY-MM-DD. Interpret Vietnamese numeric dates as DD/MM/YYYY; require a four-digit year and current-message evidence.'),
  /** Used only by browse-mode owner-scoped lookup. */
  query: z.string().trim().max(150).nullable().optional(),
  unsupported: z.enum(['multiple_passengers', 'child_or_infant']).nullable().optional(),
}).strict();

const SAFE_ISSUES = {
  empty: 'Bạn gửi giúp mình thông tin hành khách nhé.',
  model: 'Mình chưa đọc được thông tin hành khách từ tin nhắn này. Bạn gửi lại giúp mình nhé.',
  timeout: 'Mình chưa nhận được phản hồi để xử lý thông tin hành khách. Bạn thử gửi lại nhé.',
  rateLimit: 'Hệ thống đang bận. Bạn thử lại sau một chút nhé.',
  name: 'Mình chưa xác thực được họ tên từ tin nhắn hiện tại. Bạn gửi họ tên đầy đủ nhé.',
  gender: 'Mình chưa xác thực được giới tính. Bạn trả lời rõ “Nam” hoặc “Nữ” nhé.',
  dob: 'Ngày sinh cần đủ ngày, tháng và năm hợp lệ, không ở tương lai. Bạn gửi theo dạng DD/MM/YYYY nhé.',
  multiple: 'Mình chỉ xử lý một hành khách mỗi lần. Bạn gửi thông tin của một người nhé.',
  child: 'Luồng này chưa xử lý hành khách là trẻ em hoặc em bé. Bạn trao đổi với nhân viên để được hỗ trợ nhé.',
  lookupUnavailable: 'Mình chưa thể tìm khách đã lưu ở bước này. Bạn gửi thông tin khách mới nhé.',
  lookup: 'Bạn gửi tên hoặc từ khóa có trong tin nhắn hiện tại để tìm khách đã lưu nhé.',
  unknown: 'Mình chưa rõ bạn muốn cập nhật thông tin hành khách nào. Bạn gửi họ tên, giới tính hoặc ngày sinh nhé.',
} as const;

const GENDER_MARKERS = new Set(['nam', 'nu', 'male', 'female', 'mr', 'ms']);
const UNSUPPORTED_CHILD_PATTERN = /(?:^|\s)(?:tre em|em be|tre nho|so sinh|tre con|child|infant|baby)(?=$|\s)/u;
const UNSUPPORTED_MULTIPLE_PATTERN = /(?:\b(?:hai|2|nhieu|two|multiple)\s+(?:hanh khach|khach|nguoi|passengers?)\b|\bpassengers\b|\b(?:hanh khach|khach)\s+(?:khac|nay va|va)\b)/u;

/**
 * Interprets one customer message with exactly one bounded SDK decision.
 *
 * The model only proposes a typed record. Every passenger field returned to
 * callers is checked against the current message by this module. The draft
 * and pending fields help the model understand a short follow-up, but they
 * never supply evidence for a new patch.
 */
export async function interpretHybridPassengerMessage(
  text: string,
  options: HybridPassengerAgentOptions = {},
): Promise<HybridPassengerInterpretation> {
  const currentText = text.trim();
  if (!currentText) {
    return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.empty] };
  }

  let timeoutMs: number;
  try {
    timeoutMs = resolveModelTimeout(options.modelTimeoutMs);
  } catch {
    return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.model] };
  }

  const capture: { proposal?: PassengerProposal } = {};
  try {
    const requestedModel = options.model ?? getAIModel(DEFAULT_MODEL);
    const connection = typeof requestedModel === 'string'
      ? createAIConnection({
        model: requestedModel,
        defaultModel: DEFAULT_MODEL,
        maxRetries: 0,
      })
      : undefined;
    const boundedModel = typeof requestedModel === 'string'
      ? requestedModel
      : createBoundedModel(requestedModel, timeoutMs);
    const agent = new Agent({
      name: 'HybridPassengerInterpreter',
      model: boundedModel,
      modelSettings: {
        parallelToolCalls: false,
        toolChoice: 'required',
        timeoutMs,
        // No SDK recovery is allowed for this customer-facing interpretation.
        retry: { maxRetries: 0, policy: () => false },
      },
      toolUseBehavior: 'stop_on_first_tool',
      instructions: buildPassengerInstructions(options),
      tools: [
        // This is deliberately the only tool. It records the structured
        // proposal locally; it never searches, browses, reads a profile, or
        // writes customer text/history.
        createProposalTool(capture),
      ],
    });
    agent.modelSettings.timeoutMs = timeoutMs;
    const runner = new Runner({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: 'hybrid-passenger-interpreter',
      ...(connection ? { modelProvider: connection.modelProvider } : {}),
    });
    await runner.run(agent, currentText, { maxTurns: 1 });
  } catch (error) {
    return {
      intent: 'unknown',
      patch: {},
      issues: [classifyModelFailure(error)],
    };
  }

  if (!capture.proposal) {
    return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.model] };
  }

  return validateProposal(currentText, capture.proposal, options);
}

function createProposalTool(capture: { proposal?: PassengerProposal }) {
  return tool({
    name: 'propose_passenger',
    description: [
      'Return exactly one structured interpretation of the current customer message.',
      'Always call this tool once. Do not return a prose answer.',
      'Only copy passenger fields explicitly present in the current message.',
      'The supplied draft is context for short follow-ups, never evidence for a new field.',
      'Never infer gender from a name. Gender must have an explicit Nam/Nữ or equivalent marker.',
      'A full Vietnamese name may be returned as fullName; code will propose first token as lastName and the remainder as firstName for customer correction.',
      'For multiple passengers or child/infant requests, set unsupported and do not provide passenger fields.',
      'Use lookup only when browse mode is enabled; query must be the literal name or search text from the current message.',
    ].join(' '),
    parameters: PassengerProposalSchema,
    execute: async (input: PassengerProposal) => {
      capture.proposal = input;
      return 'structured passenger proposal recorded';
    },
  });
}

function buildPassengerInstructions(options: HybridPassengerAgentOptions) {
  const draft = options.draft ?? {};
  const pending = options.pendingFields ?? [];
  const browseMode = options.browseMode === true;
  return [
    'You interpret one Vietnamese travel customer message for one passenger.',
    'Use the propose_passenger function exactly once; do not answer with prose.',
    'Classify greeting, search follow-up, cancellation, one-passenger information, saved-passenger lookup, or unknown.',
    'Only current-message text is evidence. Do not copy missing values from the draft, a flight date, or any previous value.',
    'Never infer gender from a person name. Return M or F only when the message explicitly says Nam/Nữ (or an equivalent gender marker).',
    'Return DOB as YYYY-MM-DD. Interpret Vietnamese numeric dates as day/month/year, never month/day/year. Require a full four-digit year; do not repair or invent an invalid date.',
    'For a full Vietnamese name, return fullName and let the application split the first token as lastName and the remainder as firstName as a proposal for customer correction.',
    'Explicit surname edits such as “họ là ...”, “sửa họ ...”, or “surname ...” may return lastName alone or with firstName.',
    'A multiple-passenger or child/infant request must set unsupported and return no passenger fields.',
    browseMode
      ? 'Browse mode is enabled. For a saved-passenger search, use lookup and return only a literal query from this message; do not invent or list profiles.'
      : 'Browse mode is disabled. Do not use lookup; classify a search follow-up as search.',
    `Existing draft (context only): ${JSON.stringify(draft)}`,
    `Fields currently requested: ${pending.length ? pending.join(', ') : 'none'}`,
  ].join('\n');
}

function validateProposal(
  currentText: string,
  proposal: PassengerProposal,
  options: HybridPassengerAgentOptions,
): HybridPassengerInterpretation {
  const unsupported = proposal.unsupported ?? detectUnsupportedRequest(currentText);
  if (unsupported === 'multiple_passengers') {
    return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.multiple] };
  }
  if (unsupported === 'child_or_infant') {
    return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.child] };
  }

  if (proposal.intent === 'greeting'
    || proposal.intent === 'search'
    || proposal.intent === 'cancel') {
    // Never let a model attach passenger data to a non-provisioning intent.
    return { intent: proposal.intent, patch: {}, issues: [] };
  }

  if (proposal.intent === 'lookup') {
    if (!options.browseMode) {
      return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.lookupUnavailable] };
    }
    const query = cleanScalar(proposal.query);
    if (!query || query.length > 150 || !hasLiteralEvidence(currentText, query)) {
      return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.lookup] };
    }
    return { intent: 'lookup', patch: {}, issues: [], query };
  }

  if (proposal.intent !== 'provide') {
    return { intent: 'unknown', patch: {}, issues: [SAFE_ISSUES.unknown] };
  }

  const issues: string[] = [];
  const patch: Partial<CustomerPassengerInfo> = {};
  const invalidFields: Array<keyof CustomerPassengerInfo> = [];
  const fullName = cleanScalar(proposal.fullName);
  let lastName = cleanScalar(proposal.lastName);
  let firstName = cleanScalar(proposal.firstName);

  if (!lastName && !firstName && fullName) {
    if (!hasLiteralEvidence(currentText, fullName)) {
      addIssue(issues, SAFE_ISSUES.name);
      addInvalidField(invalidFields, 'lastName');
      addInvalidField(invalidFields, 'firstName');
    } else {
      const split = splitFullName(fullName);
      if (!split) {
        if (isExplicitSurnameEdit(currentText) && isValidNamePart(fullName)) {
          lastName = fullName;
        } else {
          addIssue(issues, SAFE_ISSUES.name);
          addInvalidField(invalidFields, 'lastName');
          addInvalidField(invalidFields, 'firstName');
        }
      } else {
        lastName = split.lastName;
        firstName = split.firstName;
      }
    }
  }

  if (lastName !== undefined) {
    if (isValidNamePart(lastName) && hasLiteralEvidence(currentText, lastName)) {
      patch.lastName = lastName;
    } else {
      addIssue(issues, SAFE_ISSUES.name);
      addInvalidField(invalidFields, 'lastName');
    }
  }
  if (firstName !== undefined) {
    if (isValidNamePart(firstName) && hasLiteralEvidence(currentText, firstName)) {
      patch.firstName = firstName;
    } else {
      addIssue(issues, SAFE_ISSUES.name);
      addInvalidField(invalidFields, 'firstName');
    }
  }

  const gender = proposal.gender ?? undefined;
  if (gender !== undefined) {
    if (hasExplicitGenderEvidence(currentText, gender, options.pendingFields)) {
      patch.gender = gender;
    } else {
      addIssue(issues, SAFE_ISSUES.gender);
      addInvalidField(invalidFields, 'gender');
    }
  }

  const dob = cleanScalar(proposal.dob);
  if (dob !== undefined) {
    const normalizedDob = normalizeDobProposal(dob, currentText, options.now ?? new Date());
    if (normalizedDob) {
      patch.dob = normalizedDob;
    } else {
      addIssue(issues, SAFE_ISSUES.dob);
      addInvalidField(invalidFields, 'dob');
    }
  }

  if (!Object.keys(patch).length && !issues.length) {
    addIssue(issues, SAFE_ISSUES.unknown);
  }

  return {
    intent: 'provide',
    patch,
    issues,
    ...(invalidFields.length ? { invalidFields } : {}),
  };
}

function resolveModelTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_MODEL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_MODEL_TIMEOUT_MS) {
    throw new Error('invalid model timeout');
  }
  return timeoutMs;
}

function classifyModelFailure(error: unknown) {
  if (isRateLimitError(error)) return SAFE_ISSUES.rateLimit;
  if (isTimeoutError(error)) return SAFE_ISSUES.timeout;
  return SAFE_ISSUES.model;
}

function isRateLimitError(error: unknown) {
  const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  return candidate?.status === 429
    || candidate?.statusCode === 429
    || /\b429\b|rate[ -]?limit|too many requests/i.test(String(candidate?.message ?? error));
}

function isTimeoutError(error: unknown) {
  const candidate = error as { name?: unknown; message?: unknown } | null;
  return /timeout|timed out|aborted|abort/i.test(
    `${String(candidate?.name ?? '')} ${String(candidate?.message ?? error)}`,
  );
}

function detectUnsupportedRequest(text: string): 'multiple_passengers' | 'child_or_infant' | undefined {
  const normalized = normalizeEvidence(text);
  if (UNSUPPORTED_CHILD_PATTERN.test(normalized)) return 'child_or_infant';
  if (UNSUPPORTED_MULTIPLE_PATTERN.test(normalized)) return 'multiple_passengers';
  return undefined;
}

function cleanScalar(value: string | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned || undefined;
}

function splitFullName(value: string) {
  const tokens = value.split(/\s+/u).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 8 || !tokens.every(isNameToken)) return null;
  return {
    lastName: tokens[0],
    firstName: tokens.slice(1).join(' '),
  };
}

function isExplicitSurnameEdit(text: string) {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .trim();
  return /(?:^|\s)(?:ho|surname|family name)\s*(?:la|:|thanh|sua)\s+\p{L}/iu.test(normalized)
    || /(?:doi|sua)\s+ho\s+(?:la|thanh)\s+\p{L}/iu.test(normalized);
}

function isValidNamePart(value: string) {
  const tokens = value.split(/\s+/u).filter(Boolean);
  return tokens.length >= 1 && tokens.length <= 8 && tokens.every(isNameToken);
}

function isNameToken(value: string) {
  return /^(?:[\p{L}][\p{L}'’\-]*)$/u.test(value);
}

/** Compares normalized literal tokens, preserving the current-message boundary. */
function hasLiteralEvidence(text: string, value: string) {
  const haystack = normalizeEvidence(text);
  const needle = normalizeEvidence(value);
  if (!haystack || !needle) return false;
  return haystack === needle
    || haystack.startsWith(`${needle} `)
    || haystack.endsWith(` ${needle}`)
    || haystack.includes(` ${needle} `);
}

function normalizeEvidence(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLocaleLowerCase('vi-VN')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasExplicitGenderEvidence(text: string, expected: 'M' | 'F', pendingFields: HybridPassengerAgentOptions['pendingFields']) {
  const normalizedText = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLocaleLowerCase('vi-VN');
  const clauses = normalizedText.split(/[,:;|]/u).map((part) => part.trim()).filter(Boolean);
  const found = new Set<'M' | 'F'>();
  for (const clause of clauses) {
    const tokens = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (tokens.length === 0) continue;
    const addMarker = (token: string) => {
      if (token === 'nam' || token === 'male' || token === 'mr') found.add('M');
      if (token === 'nu' || token === 'female' || token === 'ms') found.add('F');
    };
    // A bare one-token reply or a comma-separated one-token clause is
    // explicit. A marker embedded in a name such as “Nguyễn Văn Nam” is not.
    if (tokens.length === 1 && GENDER_MARKERS.has(tokens[0]) && (clauses.length > 1 || pendingFields?.includes('gender'))) addMarker(tokens[0]);
    tokens.forEach((token, index) => {
      if (!GENDER_MARKERS.has(token)) return;
      const prefix = tokens.slice(0, index).join(' ');
      if (prefix === 'gioi tinh'
        || prefix === 'gioi tinh la'
        || prefix === 'gender'
        || prefix === 'gender la'
        || prefix === 'sex'
        || prefix === 'sex la') addMarker(token);
    });
  }
  return found.size === 1 && found.has(expected);
}

/** Normalize provider formatting, then require the same single real date in this message. */
function normalizeDobProposal(value: string, text: string, now: Date): string | undefined {
  const proposed = parseFullDob(value);
  if (!proposed || !Number.isFinite(now.getTime())) return undefined;
  if (proposed > now.toISOString().slice(0, 10)) return undefined;
  const evidence = extractDateEvidence(text);
  if (evidence.invalid || evidence.dates.size !== 1 || !evidence.dates.has(proposed)) return undefined;
  return proposed;
}

/** One date grammar for proposals and evidence; never delegates numeric order to Date.parse. */
function parseFullDob(value: string): string | undefined {
  const normalized = normalizeDateText(value).trim();
  const iso = /^(\d{4})-([0-9]{1,2})-([0-9]{1,2})$/u.exec(normalized);
  const local = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/u.exec(normalized);
  const words = /^(\d{1,2})\s+thang\s+(\d{1,2})\s+nam\s+(\d{4})$/u.exec(normalized);
  const parts = iso ? [iso[1], iso[2], iso[3]] : local ? [local[4], local[3], local[1]] : words ? [words[3], words[2], words[1]] : undefined;
  if (!parts) return undefined;
  const [year, month, day] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const canonical = [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  const date = new Date(canonical + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === canonical ? canonical : undefined;
}

/** Keep invalid competing full dates visible instead of silently discarding them. */
function extractDateEvidence(text: string) {
  const dates = new Set<string>();
  let invalid = false;
  const normalized = normalizeDateText(text);
  const pattern = /\b(?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{1,2}\s+thang\s+\d{1,2}\s+nam\s+\d{4})\b/gu;
  for (const match of normalized.matchAll(pattern)) {
    const date = parseFullDob(match[0]);
    if (date) dates.add(date); else invalid = true;
  }
  return { dates, invalid };
}

/** Accent folding only; field values are never inferred from the existing draft. */
function normalizeDateText(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function addIssue(issues: string[], issue: string) {
  if (!issues.includes(issue)) issues.push(issue);
}

function addInvalidField(
  fields: Array<keyof CustomerPassengerInfo>,
  field: keyof CustomerPassengerInfo,
) {
  if (!fields.includes(field)) fields.push(field);
}

/** Adds an application timeout to injected SDK models while preserving aborts. */
function createBoundedModel(inner: Model, timeoutMs: number): Model {
  return {
    supportsPromptModelSelection: inner.supportsPromptModelSelection,
    async getResponse(request) {
      const controller = new AbortController();
      const timeoutError = new Error('Hybrid passenger model timeout.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const removeParentAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', removeParentAbort, { once: true });
      const responsePromise = inner.getResponse({
        ...request,
        signal: combineSignals(request.signal, controller.signal),
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
      try {
        return await Promise.race([responsePromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener('abort', removeParentAbort);
      }
    },
    async *getStreamedResponse(request) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('Hybrid passenger model timeout.')),
        timeoutMs,
      );
      const removeParentAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', removeParentAbort, { once: true });
      try {
        yield* inner.getStreamedResponse({
          ...request,
          signal: combineSignals(request.signal, controller.signal),
        });
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', removeParentAbort);
      }
    },
  };
}

function combineSignals(parent: AbortSignal | undefined, timeout: AbortSignal) {
  if (!parent) return timeout;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (parent.aborted) abort(parent);
  else parent.addEventListener('abort', () => abort(parent), { once: true });
  if (timeout.aborted) abort(timeout);
  else timeout.addEventListener('abort', () => abort(timeout), { once: true });
  return controller.signal;
}
