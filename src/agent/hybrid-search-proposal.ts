import { z } from 'zod';
import { AIRPORT_CATALOG } from './airport-catalog';
import { AIRLINE_CATALOG, normalizePreferredAirlineCodes } from './airline-catalog';
import { normalizeAirportText, resolveAirportByCode } from './airport-resolver';
import {
  parseHybridTimeConstraintFromVietnameseText, resolveHybridDepartureDate,
  type HybridSearchFlightRequest,
} from './hybrid-flight-request';

export const PROPOSAL_FIELDS = ['intent', 'fromAirport', 'toAirport', 'departureDate', 'time', 'airlines', 'ranking', 'tripType'] as const;
export type ProposalField = typeof PROPOSAL_FIELDS[number];
export type ProposalIssue = { field: ProposalField; reason: 'missing' | 'missing_evidence' | 'unknown' | 'conflict' | 'ambiguous' };
export type ProposalFieldResult = { field: ProposalField; status: 'valid' | ProposalIssue['reason']; codes?: string[] };
export const ProposalEvidenceSchema = z.object({
  intent: z.string().max(240).nullable().optional(),
  refresh: z.string().max(240).nullable().optional(),
  fromAirport: z.string().max(240).nullable().optional(),
  toAirport: z.string().max(240).nullable().optional(),
  departureDate: z.string().max(240).nullable().optional(),
  time: z.string().max(240).nullable().optional(),
  airlines: z.string().max(240).nullable().optional(),
  ranking: z.string().max(240).nullable().optional(),
  tripType: z.string().max(240).nullable().optional(),
  clearFields: z.string().max(240).nullable().optional(),
}).strict();
export const ProposalMetadataShape = {
  requestMode: z.enum(['new_search', 'update_search', 'unsure']).optional(),
  evidence: ProposalEvidenceSchema.optional(),
};
export type SearchProposal = Partial<HybridSearchFlightRequest> & {
  requestMode?: 'new_search' | 'update_search' | 'unsure';
  evidence?: z.infer<typeof ProposalEvidenceSchema>;
  clearFields?: string[];
  refresh?: boolean;
  criterion?: 'cheapest' | 'earliest' | 'latest';
};
export type PendingSearchClarification = {
  fields: ProposalField[];
  /** Only locally validated facts from the request awaiting an intent decision. */
  intentDraft?: Partial<HybridSearchFlightRequest>;
};

/** Recognize explicit control answers without interpreting flight business data. */
function explicitSearchMode(text: string) {
  const isNew = /\b(?:tim moi|tim chuyen moi|yeu cau moi)\b/.test(text);
  const isUpdate = /\b(?:doi|cap nhat|thay doi|chi lay|chi hang)\b/.test(text);
  return isNew && isUpdate ? 'unsure' : isNew ? 'new_search' : isUpdate ? 'update_search' : undefined;
}

/** A short confirmation may adopt staged facts, but a different request may not. */
function isIntentOnlyAnswer(text: string) {
  const remainder = text
    .replace(/\b(?:tim (?:chuyen )?moi|yeu cau moi|cap nhat)\b/g, ' ')
    .replace(/\b(?:minh|toi|muon|cho|giup|ban|vang|dung|roi|nhe|nha|a|di|la|vay|thi|yeu cau|chuyen|hien tai|cu)\b/g, ' ')
    .replace(/[\s,.!?]+/g, ' ').trim();
  return remainder.length === 0;
}

/** Locate only fields actually validated in the staged request. */
function hasDraftField(draft: Partial<HybridSearchFlightRequest>, field: ProposalField) {
  if (field === 'fromAirport') return Boolean(draft.fromAirportCode);
  if (field === 'toAirport') return Boolean(draft.toAirportCode);
  if (field === 'departureDate') return Boolean(draft.departureDate);
  if (field === 'time') return draft.preferredTime !== undefined || draft.timeConstraint !== undefined;
  if (field === 'airlines') return draft.preferredAirlineCodes !== undefined;
  if (field === 'ranking') return draft.resultRanking !== undefined;
  return field === 'tripType' && draft.tripType !== undefined;
}

/** Use complete alias tokens and collect every match, never catalog ordering. */
export function airportCodesInText(text: string): string[] {
  const value = ' ' + normalizeEvidenceText(text).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  return AIRPORT_CATALOG.filter(airport => airport.aliases.some(alias => {
    const key = normalizeEvidenceText(alias).replace(/[^a-z0-9]+/g, ' ').trim();
    return key && value.includes(' ' + key + ' ');
  })).map(airport => airport.code);
}

/** Accent-insensitive evidence comparison retains word boundaries and punctuation. */
function normalizeEvidenceText(text: string) {
  return normalizeAirportText(text).replace(/\s+/g, ' ').trim();
}

/** Evidence is data from this message, not a model-authored explanation. */
function hasEvidence(raw: string, evidence: string | null | undefined) {
  if (!evidence?.trim()) return false;
  const needle = normalizeEvidenceText(evidence);
  const haystack = normalizeEvidenceText(raw);
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = haystack[index - 1] ?? '';
    const after = haystack[index + needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/** A location slot must name a catalog place, not merely contain one inside another place. */
function isAirportPhrase(value: string, code: string) {
  const airport = AIRPORT_CATALOG.find(item => item.code === code);
  if (!airport) return false;
  const normalized = normalizeEvidenceText(value);
  if (normalized === normalizeEvidenceText(airport.text)) return true;
  const bare = normalized
    .replace(/^(?:(?:san bay|cang hang khong|quoc te|thanh pho|tp\.?|tu|den|ra|vao|toi|o|diem di|diem den|la)\s+)+/, '')
    .replace(new RegExp('\\s*\\(' + code.toLowerCase() + '\\)\\s*$'), '')
    .replace(/\s+(?:international airport|airport)$/, '').trim();
  return airport.aliases.some(alias => normalizeEvidenceText(alias) === bare);
}

/** Check explicit direction between two named places, never infer from order alone. */
function explicitRoute(text: string) {
  const normalized = normalizeEvidenceText(text);
  const mentions: { code: string; start: number; end: number }[] = [];
  for (const airport of AIRPORT_CATALOG) for (const alias of airport.aliases) {
    const key = normalizeEvidenceText(alias);
    let start = normalized.indexOf(key);
    while (start >= 0) {
      if (!/[a-z0-9]/.test(normalized[start - 1] ?? '') && !/[a-z0-9]/.test(normalized[start + key.length] ?? '')) mentions.push({ code: airport.code, start, end: start + key.length });
      start = normalized.indexOf(key, start + 1);
    }
  }
  mentions.sort((a, b) => a.start - b.start || b.end - a.end);
  const unique = mentions.filter((mention, index) => !mentions.slice(0, index).some(prior => prior.end >= mention.end && prior.start <= mention.start));
  if (unique.length !== 2 || unique[0].code === unique[1].code) return null;
  const connector = normalized.slice(unique[0].end, unique[1].start).trim();
  if (/^(?:di|den|ra|vao|toi|->|→)\s*(?:san bay\s*)?$/.test(connector)) return { from: unique[0].code, to: unique[1].code };
  return null;
}

/** Normalize a model proposal without trusting its codes or mutating accepted state. */
export function validateSearchProposal(input: {
  patch: SearchProposal;
  previous?: Partial<HybridSearchFlightRequest>;
  pending?: PendingSearchClarification;
  text: string;
  todayIso: string;
  comparison?: boolean;
}) {
  const { patch, previous: storedPrevious, pending: storedPending, text, todayIso } = input;
  const normalizedMessage = normalizeEvidenceText(text);
  const explicitMode = explicitSearchMode(normalizedMessage);
  const confirmedMode = storedPending?.fields.includes('intent') && storedPending.intentDraft
    && isIntentOnlyAnswer(normalizedMessage) && explicitMode !== 'unsure' ? explicitMode : undefined;
  const previous = confirmedMode === 'new_search' ? storedPending!.intentDraft
    : confirmedMode === 'update_search' ? { ...storedPrevious, ...storedPending!.intentDraft } : storedPrevious;
  const pending = confirmedMode ? { fields: storedPending!.fields.filter(field => field !== 'intent' && !hasDraftField(storedPending!.intentDraft!, field)) } : storedPending;
  const rawCodes = airportCodesInText(text);
  const direction = explicitRoute(text);
  const rawAirlines = AIRLINE_CATALOG.filter(airline => airline.aliases.some(alias => hasEvidence(text, alias))).map(airline => airline.code);
  const evidence = patch.evidence ?? {};
  const issues: ProposalIssue[] = [];
  const results: ProposalFieldResult[] = [];
  let comparisonCriterion: SearchProposal['criterion'] | null | undefined = confirmedMode && storedPending?.intentDraft?.resultRanking !== undefined ? storedPending.intentDraft.resultRanking : undefined;
  const issue = (field: ProposalField, reason: ProposalIssue['reason']) => {
    if (!issues.some(item => item.field === field && item.reason === reason)) issues.push({ field, reason });
  };
  // Clear current-message intent wins over model metadata; ambiguous intent still asks.
  const completeNewMessage = direction && rawCodes.length === 2
    && /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}|ngay mai|ngay kia|hom nay)\b/.test(normalizedMessage)
    && /\b(?:tim|bay)\b/.test(normalizedMessage) && !explicitMode && !/\b(?:lam moi|tim lai|refresh)\b/.test(normalizedMessage);
  const pendingAirportReply = !pending?.fields.includes('intent') && pending?.fields.some(field => field.endsWith('Airport')) && rawCodes.length === 1
    && !/\b(?:tim|bay)\b/.test(normalizedMessage);
  const groundedMode = confirmedMode ?? explicitMode ?? (completeNewMessage ? 'new_search' : pendingAirportReply ? 'update_search' : undefined);
  const mode = groundedMode ?? (pending?.fields.includes('intent') ? 'unsure' : patch.requestMode) ?? (!previous ? 'new_search'
    : pending?.fields.length || input.comparison || patch.refresh ? 'update_search' : undefined);
  const startingNew = mode === 'new_search' && !confirmedMode;
  const draft: Partial<HybridSearchFlightRequest> = startingNew ? {} : { ...previous };
  if (!mode || mode === 'unsure') issue('intent', 'ambiguous');
  if (!groundedMode && evidence.intent != null && !hasEvidence(text, evidence.intent)) issue('intent', 'missing_evidence');
  if (patch.refresh && (!/\b(?:lam moi|tim lai|refresh)\b/.test(normalizedMessage)
    || (evidence.refresh != null && !hasEvidence(text, evidence.refresh)))) issue('intent', 'missing_evidence');


  for (const side of ['from', 'to'] as const) {
    const field = `${side}Airport` as ProposalField;
    const codeKey = `${side}AirportCode` as const;
    const textKey = `${side}AirportText` as const;
    const supplied = patch[codeKey] != null || patch[textKey] != null;
    const code = supplied ? patch[codeKey] : draft[codeKey];
    const label = supplied ? patch[textKey] : draft[textKey];
    const byCode = code ? resolveAirportByCode(code) : null;
    const textCodes = label ? airportCodesInText(label) : [];
    const source = evidence[field as 'fromAirport' | 'toAirport'];
    const sourceCodes = source ? airportCodesInText(source) : [];
    const combined = [...new Set([...textCodes, ...sourceCodes, ...(byCode ? [byCode.code] : [])])];
    if (combined.length > 1) { results.push({ field, status: 'conflict', codes: combined }); issue(field, 'conflict'); continue; }
    if ((code && !byCode) || (label && !textCodes.length && !byCode)) { issue(field, 'unknown'); continue; }
    const resolved = combined.length === 1 ? resolveAirportByCode(combined[0]) : null;
    if (!resolved) { issue(field, 'missing'); continue; }
    if ((label && !isAirportPhrase(label, resolved.code)) || (source && !isAirportPhrase(source, resolved.code))) { issue(field, 'unknown'); continue; }
    if (direction && direction[side] !== resolved.code) { issue(field, 'conflict'); continue; }
    const prior = previous?.[codeKey] ? resolveAirportByCode(previous[codeKey]!) : null;
    const needsEvidence = startingNew || prior?.code !== resolved.code || pending?.fields.includes(field);
    const roleCued = side === 'from' ? /\b(?:tu|xuat phat|diem di|san bay di)\b/.test(normalizedMessage)
      : /\b(?:den|ra|vao|toi|diem den|san bay den)\b/.test(normalizedMessage);
    if (needsEvidence && !direction && !pending?.fields.includes(field) && rawCodes.length > 0 && !roleCued) {
      issue(field, 'ambiguous'); continue;
    }
    const direct = (label && hasEvidence(text, label)) || (code && hasEvidence(text, code));
    if ((!confirmedMode || needsEvidence) && source != null && (!hasEvidence(text, source) || sourceCodes.length !== 1)) {
      issue(field, 'missing_evidence'); continue;
    }
    if (needsEvidence && !source && !direct) { issue(field, 'missing_evidence'); continue; }
    // One location answering a different pending side must never move the route.
    if (pending?.fields.some(item => item === 'fromAirport' || item === 'toAirport')
      && !pending.fields.includes(field) && prior && prior.code !== resolved.code && rawCodes.length === 1) {
      issue(field, 'conflict'); continue;
    }
    draft[codeKey] = resolved.code;
    draft[textKey] = resolved.text;
    results.push({ field, status: 'valid', codes: [resolved.code] });
  }

  if (draft.fromAirportCode && draft.fromAirportCode === draft.toAirportCode) {
    const side = patch.fromAirportCode != null && patch.toAirportCode == null && patch.toAirportText == null ? 'from' : 'to';
    issue(side === 'from' ? 'fromAirport' : 'toAirport', 'conflict');
    if (mode === 'new_search') { delete draft[side === 'from' ? 'fromAirportCode' : 'toAirportCode']; delete draft[side === 'from' ? 'fromAirportText' : 'toAirportText']; }
    else { draft[side === 'from' ? 'fromAirportCode' : 'toAirportCode'] = previous?.[side === 'from' ? 'fromAirportCode' : 'toAirportCode']; draft[side === 'from' ? 'fromAirportText' : 'toAirportText'] = previous?.[side === 'from' ? 'fromAirportText' : 'toAirportText']; }
  }
  // Catalog mentions not accounted for by the route may be a missed correction.
  const routeCodes = [draft.fromAirportCode, draft.toAirportCode];
  if (rawCodes.some(code => !routeCodes.includes(code)) && !issues.some(item => item.field.endsWith('Airport'))) {
    issue('fromAirport', 'ambiguous'); issue('toAirport', 'ambiguous');
  }

  const dateMentions = [...text.matchAll(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{4})?)\b/g)].map(match => match[0]);
  const relativeDays = [...normalizedMessage.matchAll(/\b(?:hom nay|ngay mai|ngay kia)\b/g)].map(match => match[0]);
  const dateSource = evidence.departureDate ?? (dateMentions.length || relativeDays.length ? text : undefined);
  const dateChanged = patch.departureDate != null && patch.departureDate !== previous?.departureDate;
  if (new Set(dateMentions).size > 1 || new Set(relativeDays).size > 1 || (dateMentions.length && relativeDays.length)) issue('departureDate', 'ambiguous');
  else if ((!confirmedMode || dateChanged) && evidence.departureDate != null && !hasEvidence(text, evidence.departureDate)) issue('departureDate', 'missing_evidence');
  else if (patch.departureDate || dateSource) {
    const sourceHasDate = dateSource && (/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{4})?)\b/.test(dateSource)
      || /\b(?:hom nay|ngay mai|ngay kia)\b/.test(normalizeEvidenceText(dateSource)));
    if ((dateChanged || startingNew || pending?.fields.includes('departureDate')) && !sourceHasDate) {
      issue('departureDate', 'missing_evidence');
    } else {
      const relative = normalizedMessage;
      const offset = /\bngay kia\b/.test(relative) ? 2 : /\bngay mai\b/.test(relative) ? 1 : /\bhom nay\b/.test(relative) ? 0 : null;
      const date = offset === null ? patch.departureDate ?? draft.departureDate : new Date(Date.parse(todayIso + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
      const resolved = resolveHybridDepartureDate(date, text, todayIso);
      if (!resolved.ok) issue('departureDate', 'unknown');
      else { draft.departureDate = resolved.departureDate; results.push({ field: 'departureDate', status: 'valid' }); }
    }
  }
  if (!draft.departureDate && !issues.some(item => item.field === 'departureDate')) issue('departureDate', 'missing');

  const timeKeys = ['preferredTime', 'specificTime', 'timeConstraint'] as const;
  const proposedTime = timeKeys.some(key => patch[key] != null);
  const parsedTime = parseHybridTimeConstraintFromVietnameseText(text);
  const bucketText = normalizeEvidenceText(evidence.time ?? text);
  const bucketSource = evidence.time != null || /^(?:sang|chieu|toi|dem|sang som)$/.test(bucketText)
    || /\b(?:buoi|bay|vao|chuyen|ban) (?:sang|chieu|toi|dem)\b|sang som|rang sang/.test(bucketText);
  const bucket = !bucketSource ? null : /sang som|rang sang/.test(bucketText) ? 'early_morning' : /\bsang\b/.test(bucketText) ? 'morning'
    : /\bchieu\b/.test(bucketText) ? 'afternoon' : (/\b(?:buoi toi|ban dem)\b/.test(bucketText) || /^(?:toi|dem)$/.test(bucketText)) ? 'night' : null;
  const timeSource = evidence.time ?? (parsedTime || bucket ? text : null);
  const timeChanged = timeKeys.some(key => patch[key] != null && JSON.stringify(patch[key]) !== JSON.stringify(previous?.[key]));
  const clocks = [...normalizeEvidenceText(text).matchAll(/(?<!\d)(\d{1,2})\s*(?:h|gio|:)\s*(\d{2})?(?!\d)/g)];
  const invalidClock = clocks.some(match => +match[1] > 23 || +(match[2] ?? 0) > 59);
  const conflictingClocks = clocks.length > 1 && parsedTime?.kind !== 'between';
  const negatedTime = /\b(?:khong|dung) (?:bay )?(?:sau|dung|tu|khoang|buoi|sang|chieu|toi|dem)\b/.test(normalizedMessage);
  if (invalidClock || conflictingClocks || negatedTime) issue('time', 'ambiguous');
  else if ((proposedTime || parsedTime || bucket) && (timeChanged || parsedTime || bucket || startingNew || pending?.fields.includes('time'))) {
    if (!timeSource || !hasEvidence(text, timeSource)) issue('time', 'missing_evidence');
    else if (parsedTime) {
      draft.preferredTime = 'specific_time'; draft.specificTime = parsedTime.exactTime; draft.timeConstraint = parsedTime;
      results.push({ field: 'time', status: 'valid' });
    } else {
      if (!bucket || /\b(?:khong|dung)\b/.test(bucketText)
        || (patch.preferredTime && bucket !== patch.preferredTime) || patch.specificTime || patch.timeConstraint) issue('time', 'ambiguous');
      else { draft.preferredTime = bucket; draft.specificTime = null; draft.timeConstraint = null; results.push({ field: 'time', status: 'valid' }); }
    }
  }
  if (evidence.time && !parsedTime && !bucket) issue('time', 'ambiguous');
  if (/dung (?:bay )?qua som|gio dep|tot nhat/.test(normalizeEvidenceText(text)) && !parsedTime) issue('time', 'ambiguous');

  const negatedAirline = rawAirlines.length > 0 && /\b(?:khong (?:bay|lay|chon|di)?|ngoai tru|tru hang)\s/.test(normalizedMessage);
  if (negatedAirline) issue('airlines', 'ambiguous');
  if (patch.preferredAirlineCodes?.length && !negatedAirline) {
    try {
      const codes = normalizePreferredAirlineCodes(patch.preferredAirlineCodes, { strict: true })!;
      const changed = JSON.stringify(codes) !== JSON.stringify(previous?.preferredAirlineCodes);
      const source = evidence.airlines ?? text;
      const supported = !/khong|ngoai tru|tru hang/.test(normalizeEvidenceText(source)) && hasEvidence(text, source) && codes.every(code => AIRLINE_CATALOG.find(airline => airline.code === code)!.aliases.some(alias => hasEvidence(source, alias)));
      if ((changed || startingNew || pending?.fields.includes('airlines')) && !supported) issue('airlines', 'missing_evidence');
      else { draft.preferredAirlineCodes = codes; results.push({ field: 'airlines', status: 'valid', codes }); }
    } catch { issue('airlines', 'unknown'); }
  }
  if (rawAirlines.some(code => !draft.preferredAirlineCodes?.includes(code)) && !issues.some(item => item.field === 'airlines')) issue('airlines', 'missing');
  if (patch.resultRanking) {
    const source = evidence.ranking ?? text;
    if ((startingNew || patch.resultRanking !== previous?.resultRanking || pending?.fields.includes('ranking')) && (!hasEvidence(text, source) || !/\bre\b|thap nhat|cheapest/.test(normalizeEvidenceText(source)))) issue('ranking', 'missing_evidence');
    else {
      draft.resultRanking = patch.resultRanking;
      if (hasEvidence(text, source) && /\bre\b|thap nhat|cheapest/.test(normalizeEvidenceText(source))) comparisonCriterion = patch.resultRanking;
      results.push({ field: 'ranking', status: 'valid' });
    }
  }
  if (evidence.ranking && !patch.criterion && !patch.resultRanking) issue('ranking', 'ambiguous');
  if (!patch.criterion && /\bre\b|thap nhat|cheapest/.test(normalizedMessage) && !draft.resultRanking) issue('ranking', 'missing');
  if (patch.criterion) {
    const phrase = normalizeEvidenceText(evidence.ranking ?? text);
    const pattern = patch.criterion === 'cheapest' ? /\bre\b|thap nhat|cheapest/
      : patch.criterion === 'earliest' ? /som nhat|earliest/ : /muon nhat|latest/;
    if (!hasEvidence(text, evidence.ranking ?? text) || !pattern.test(phrase)) issue('ranking', 'missing_evidence');
    else { comparisonCriterion = patch.criterion; results.push({ field: 'ranking', status: 'valid' }); }
  }
  if (patch.tripType === 'round_trip' || patch.returnDate) issue('tripType', 'unknown');
  else draft.tripType = 'one_way';

  const clearTargets: Partial<Record<ProposalField, RegExp>> = {
    fromAirport: /diem di|san bay di/, toAirport: /diem den|san bay den/, departureDate: /ngay/,
    time: /gio|thoi gian|buoi/, airlines: /hang|airline/, ranking: /gia|re|uu tien|tieu chi/,
  };
  const clearMap: Record<string, ProposalField> = { fromAirportCode: 'fromAirport', fromAirportText: 'fromAirport', toAirportCode: 'toAirport', toAirportText: 'toAirport', departureDate: 'departureDate', preferredTime: 'time', specificTime: 'time', timeConstraint: 'time', preferredAirlineCodes: 'airlines', resultRanking: 'ranking', criterion: 'ranking' };
  for (const key of patch.clearFields ?? []) {
    const field = clearMap[key];
    if (!field) { issue('intent', 'unknown'); continue; }
    if (!hasEvidence(text, evidence.clearFields) || !/\b(?:bo|khong|bat ky|tat ca|xoa)\b/.test(normalizeEvidenceText(evidence.clearFields!)) || !clearTargets[field]?.test(normalizeEvidenceText(evidence.clearFields!))) { issue(field, 'missing_evidence'); continue; }
    if (field === 'fromAirport' || field === 'toAirport') {
      const side = field === 'fromAirport' ? 'from' : 'to';
      delete draft[side === 'from' ? 'fromAirportCode' : 'toAirportCode']; delete draft[side === 'from' ? 'fromAirportText' : 'toAirportText'];
      issue(field, 'missing');
    } else if (field === 'departureDate') { delete draft.departureDate; issue(field, 'missing'); }
    else if (field === 'time') { draft.preferredTime = null; draft.specificTime = null; draft.timeConstraint = null; }
    else if (field === 'airlines') draft.preferredAirlineCodes = null;
    else { draft.resultRanking = null; comparisonCriterion = null; }
    results.push({ field, status: 'valid' });
  }
  for (const field of pending?.fields ?? []) {
    if (field !== 'intent' && !startingNew && !results.some(result => result.field === field && result.status === 'valid') && !issues.some(item => item.field === field)) issue(field, 'missing');
  }
  // The model's missingFields list is not authoritative after local validation.
  draft.missingFields = [];
  results.push(...issues.filter(item => !results.some(result => result.field === item.field && result.status === item.reason)).map(item => ({ field: item.field, status: item.reason })));

  const repairable = issues.some(item => item.reason === 'missing_evidence' || item.reason === 'conflict'
    || (item.field.endsWith('Airport') && rawCodes.length > 0)
    || (item.field === 'departureDate' && (dateMentions.length > 0 || relativeDays.length > 0))
    || (item.field === 'airlines' && rawAirlines.length > 0)
    || (item.field === 'time' && (clocks.length > 0 || Boolean(bucket)))
    || item.field === 'intent');
  return { draft, issues, results, mode, repairable, comparisonCriterion, confirmedIntent: Boolean(confirmedMode) };
}

/** Render only unresolved fields; never include model-authored facts. */
export function formatProposalIssues(issues: ProposalIssue[]) {
  const labels: Record<ProposalField, string> = {
    intent: 'bạn muốn tìm chuyến mới hay cập nhật yêu cầu hiện tại',
    fromAirport: 'điểm đi', toAirport: 'điểm đến', departureDate: 'ngày khởi hành',
    time: 'giờ hoặc khoảng giờ bay cụ thể', airlines: 'hãng bay', ranking: 'tiêu chí ưu tiên', tripType: 'yêu cầu một chiều (pilot chưa hỗ trợ khứ hồi)',
  };
  const fields = [...new Set(issues.map(item => item.field))];
  return 'Bạn xác nhận giúp mình ' + fields.map(field => labels[field]).join(', ') + ' nhé.';
}
