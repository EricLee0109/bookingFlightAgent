import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HybridPassengerFlowSchema, hybridRequestKey, type HybridPassengerFlow } from '../passengers/hybrid-passenger-state';
import type { HybridSearchSession } from '../storage/hybrid-search-session-store';
import { readLocalFlightCase, updateLocalFlightCase, type LocalFlightCase } from '../storage/local-case-store';
import { filterFlightSearchSnapshot } from '../automation/1booking/flight-search-snapshot';

/** Read flight facts from the case snapshot, never from model output. */
export function selectedCandidate(flightCase: LocalFlightCase, flow: HybridPassengerFlow) {
  const snapshot = flightCase.hybridSearchSnapshot;
  if (flightCase.caseId !== flow.selection.caseId || snapshot?.snapshotId !== flow.selection.snapshotId) return undefined;
  return snapshot.candidates.find(c => c.candidateId === flow.selection.candidateId);
}
/** Recheck route, time eligibility and identity against the current search. */
export function selectionValid(session: HybridSearchSession, flightCase: LocalFlightCase, flow: HybridPassengerFlow, now: Date) {
  if (!session.snapshotFresh || session.caseId !== flightCase.caseId || session.snapshotId !== flow.selection.snapshotId
    || hybridRequestKey(session) !== flow.selection.requestKey || session.pendingClarification?.fields.length
    || !selectedCandidate(flightCase, flow) || !session.snapshot || !session.draftRequest) return false;
  const draft = session.draftRequest;
  if (session.snapshot.route.fromAirportCode !== draft.fromAirportCode || session.snapshot.route.toAirportCode !== draft.toAirportCode || session.snapshot.departureDate !== draft.departureDate) return false;
  try {
    const result = filterFlightSearchSnapshot(session.snapshot, {
      snapshotId: flow.selection.snapshotId, candidateIds: [flow.selection.candidateId],
      preferredTime: draft.preferredTime ?? undefined, specificTime: draft.specificTime,
      timeConstraint: draft.timeConstraint ? { ...draft.timeConstraint, startInclusive: draft.timeConstraint.startInclusive !== false, endInclusive: draft.timeConstraint.endInclusive !== false } : null, preferredAirlineCodes: draft.preferredAirlineCodes,
    }, { now });
    return result.selectedCandidates.length === 1
      && isDeepStrictEqual(result.selectedCandidates[0], selectedCandidate(flightCase, flow));
  } catch { return false; }
}
/** Called inside the shared search-session lock after a search turn. */
export async function invalidateCustomerSelectionAfterSearch(session: HybridSearchSession, now: Date) {
  if (!session.passengerCaseId) return;
  const flightCase = await readLocalFlightCase(session.passengerCaseId);
  const parsed = HybridPassengerFlowSchema.safeParse(flightCase?.hybridPassengerFlow);
  if (!flightCase || flightCase.telegramChatId !== session.chatId || !parsed.success) return;
  const flow = parsed.data;
  if (['cancelled', 'awaiting_selection'].includes(flow.stage) || selectionValid(session, flightCase, flow, now)) return;
  flow.confirmed = undefined; flow.saveDecision = undefined; flow.revision++; flow.token = randomUUID(); flow.stage = 'awaiting_selection';
  await updateLocalFlightCase(flightCase, { hybridPassengerFlow: flow, status: 'HYBRID_PASSENGER_DRAFT', holdApproval: undefined });
}

