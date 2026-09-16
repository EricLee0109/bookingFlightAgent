import type { LocalFlightCase } from '../storage/local-case-store';

export type AgentOrchestrationMode = 'legacy' | 'shadow' | 'hybrid_search';

/** Rejects unsupported rollout modes instead of silently enabling live tools. */
export function readAgentOrchestrationMode(value = process.env.AGENT_ORCHESTRATION_MODE): AgentOrchestrationMode {
  if (!value || value === 'legacy') return 'legacy';
  if (value === 'shadow') return 'shadow';
  if (value === 'hybrid_search') return 'hybrid_search';
  throw new Error('AGENT_ORCHESTRATION_MODE must be legacy, shadow, or hybrid_search.');
}

/** Chooses tools from trusted state, never from the operator or model claims. */
export function availableBookingTools(flightCase: LocalFlightCase | null) {
  const names = ['ask_operator_for_clarification', 'inspect_case'];
  if (!flightCase || ['CASE_CREATED', 'NEEDS_INPUT', 'SEARCH_FAILED', 'CASE_FAILED', 'OPTIONS_SENT', 'SEARCH_DONE'].includes(flightCase.status)) names.push('search_flights');
  if (flightCase && ['OPTIONS_SENT', 'SEARCH_DONE'].includes(flightCase.status)) names.push('compare_flights', 'select_flight');
  if (flightCase && ['AWAITING_PASSENGER_INFO', 'PASSENGER_INFO_NEEDS_REVIEW', 'PASSENGER_INFO_FAILED'].includes(flightCase.status)) names.push('resolve_passenger');
  if (flightCase?.status === 'PASSENGER_INFO_CONFIRMED' && !flightCase.holdSubmittedAt) names.push('hold_booking');
  return names;
}

/** Projects only operational fields into model context; passenger records stay local. */
export function bookingAgentCaseSnapshot(flightCase: LocalFlightCase | null) {
  if (!flightCase) return null;
  return {
    caseId: flightCase.caseId, status: flightCase.status,
    searchInput: flightCase.searchInput,
    candidates: flightCase.flightCandidates?.slice(0, 30),
    selectedFlight: flightCase.selectedFlight,
    passengerAttached: !!flightCase.attachedPassengerInfo,
    passengerHasDob: !!flightCase.attachedPassengerInfo?.dob,
    holdSubmitted: !!flightCase.holdSubmittedAt,
  };
}

/** Removes contacts and DOB-like replies before shadow evaluation or persistence. */
export function redactAgentMessage(text: string, passengerFlow: boolean) {
  let result = text.slice(0, 4000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+\d(?:[ ()-]?\d){8,14}|\b0(?:[ .()-]?\d){8,10}\b)/g, '[phone]')
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_-]+/g, '[secret]');
  if (passengerFlow) result = result.replace(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g, '[date-of-birth]');
  return result;
}
