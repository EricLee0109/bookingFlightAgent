import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HybridSearchSession } from '../storage/hybrid-search-session-store';

export const CustomerPassengerDraftSchema = z.object({
  lastName: z.string().trim().min(1).max(100).optional(),
  firstName: z.string().trim().min(1).max(150).optional(),
  gender: z.enum(['M', 'F']).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
const CustomerPassengerInfoSchema = CustomerPassengerDraftSchema.required();
export const HybridPassengerFlowSchema = z.object({
  ownerTelegramUserId: z.number().int().positive(),
  token: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  stage: z.enum(['choose', 'enter', 'browse', 'review', 'confirmed', 'update_review', 'awaiting_selection', 'cancelled']),
  selection: z.object({ caseId: z.string().regex(/^BK-\d{8}-\d{6}$/), snapshotId: z.string().min(1), candidateId: z.string().min(1), requestKey: z.string().length(64) }).strict(),
  draft: CustomerPassengerDraftSchema,
  pendingFields: z.array(z.enum(['lastName', 'firstName', 'gender', 'dob'])),
  unresolvedFields: z.array(z.enum(['lastName', 'firstName', 'gender', 'dob'])).optional(),
  profileUpdateBefore: CustomerPassengerInfoSchema.optional(),
  sourceProfileId: z.number().int().positive().optional(),
  sourceProfileVersion: z.number().int().positive().optional(),
  browseQuery: z.string().max(150).optional(),
  browsePage: z.number().int().nonnegative().optional(),
  offeredProfileIds: z.array(z.number().int().positive()).max(5).optional(),
  confirmed: z.object({ info: CustomerPassengerInfoSchema, revision: z.number().int(), confirmedAt: z.string(), selection: z.object({ caseId: z.string(), snapshotId: z.string(), candidateId: z.string(), requestKey: z.string() }).strict() }).strict().optional(),
  saveDecision: z.enum(['pending', 'saved', 'skipped']).optional(),
}).strict();
export type HybridPassengerFlow = z.infer<typeof HybridPassengerFlowSchema>;

/** Bind a selected flight to the exact verified search draft and criterion. */
export function hybridRequestKey(session: HybridSearchSession) {
  return createHash('sha256').update(JSON.stringify([session.draftRequest, session.lastCompareCriterion ?? null])).digest('hex');
}
