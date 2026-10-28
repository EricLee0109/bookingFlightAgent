import { selectedCandidate, selectionValid } from './hybrid-customer-selection';
export { invalidateCustomerSelectionAfterSearch } from './hybrid-customer-selection';
import { randomUUID } from 'node:crypto';
import { HybridPassengerFlowSchema, type HybridPassengerFlow } from '../passengers/hybrid-passenger-state';
import { CustomerPassengerStore } from '../passengers/customer-passenger-store';
import type { CustomerPassengerInfo } from '../passengers/customer-passenger-types';
import { interpretHybridPassengerMessage } from '../agent/hybrid-passenger-agent';
import { readAgentOrchestrationMode } from '../agent/booking-agent-policy';
import { HybridSearchSessionStore, type HybridSearchSession, type HybridSearchSessionStoreLike } from '../storage/hybrid-search-session-store';
import { readLocalFlightCase, updateLocalFlightCase, type LocalFlightCase } from '../storage/local-case-store';
import { readLocalAgentSettings, type AgentSettings } from '../storage/local-settings-store';

export type CustomerFlowReply = { handled: boolean; response?: string; replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }; duplicate?: boolean };
export type CustomerFlowIdentity = { chatId: number; userId: number; chatType: string; updateId: string };
export type CustomerFlowOptions = {
  sessionStore?: HybridSearchSessionStoreLike;
  customerStoreFactory?: () => CustomerPassengerStore;
  interpret?: typeof interpretHybridPassengerMessage;
  settingsReader?: () => Promise<AgentSettings>;
  now?: Date;
  /** Deployment validation seam; the approved minimum is exactly 18. */
  minimumAge?: number;
  onProcessingStarted?: () => void | Promise<void>;
};
const staleText = 'Lựa chọn này đã cũ hoặc không thuộc yêu cầu hiện tại. Bạn mở danh sách mới nhất và chọn lại nhé.';
const fieldNames = { lastName: 'họ', firstName: 'tên đệm và tên', gender: 'giới tính (nam/nữ)', dob: 'ngày sinh đầy đủ DD/MM/YYYY' };
const reply = (response: string): CustomerFlowReply => ({ handled: true, response });
/** Build a compact revision-bound Telegram action. */
function button(flow: HybridPassengerFlow, text: string, action: string, arg = '') { return { text, callback_data: `hc:${action}:${flow.token}${arg ? ':' + arg : ''}` }; }
/** Expire previously rendered controls without changing the passenger draft. */
function rotate(flow: HybridPassengerFlow) { flow.token = randomUUID(); }
/** Revoke confirmation whenever the selected details are edited. */
function invalidate(flow: HybridPassengerFlow) { flow.confirmed = undefined; flow.saveDecision = undefined; flow.revision++; rotate(flow); }
/** Copy only validated booking fields, excluding repository metadata. */
function passengerInfo(profile: CustomerPassengerInfo): CustomerPassengerInfo { return { lastName: profile.lastName, firstName: profile.firstName, gender: profile.gender, dob: profile.dob }; }
/** Render the exact surname/name split and birth date for customer review. */
function formatInfo(info: Partial<CustomerPassengerInfo>) {
  return [`Họ: ${info.lastName ?? 'chưa có'}`, `Tên đệm và tên: ${info.firstName ?? 'chưa có'}`, `Giới tính: ${info.gender === 'M' ? 'Nam' : info.gender === 'F' ? 'Nữ' : 'chưa có'}`, `Ngày sinh: ${info.dob ? info.dob.split('-').reverse().join('/') : 'chưa có'}`].join('\n');
}
/** Collect missing/unresolved fields and enforce calendar and age policy. */
function validateDraft(flow: HybridPassengerFlow, flightCase: LocalFlightCase, options: CustomerFlowOptions) {
  const missing = (Object.keys(fieldNames) as Array<keyof CustomerPassengerInfo>).filter(key => !flow.draft[key]);
  const issues: string[] = [];
  const minimumAge = options.minimumAge ?? Number(process.env.HYBRID_PASSENGER_MINIMUM_AGE?.trim() || '18');
  if (minimumAge !== 18) issues.push('Cấu hình độ tuổi chưa hợp lệ. Luồng này yêu cầu từ đủ 18 tuổi vào ngày bay; thông tin được giữ ở bản nháp.');
  for (const field of flow.unresolvedFields ?? []) if (!missing.includes(field)) missing.push(field);
  if (flow.draft.dob) {
    const parsed = new Date(flow.draft.dob + 'T00:00:00Z');
    const now = options.now ?? new Date();
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== flow.draft.dob || parsed > now) {
      issues.push('Ngày sinh chưa hợp lệ. Bạn gửi đủ ngày/tháng/năm nhé.');
      if (!missing.includes('dob')) missing.push('dob');
    } else if (minimumAge === 18) {
      const date = flightCase.hybridSearchSnapshot!.departureDate;
      const age = Number(date.slice(0, 4)) - Number(flow.draft.dob.slice(0, 4)) - (date.slice(5) < flow.draft.dob.slice(5) ? 1 : 0);
      if (age < minimumAge) { issues.push(`Luồng hiện tại chỉ hỗ trợ một hành khách từ đủ ${minimumAge} tuổi vào ngày bay.`); if (!missing.includes('dob')) missing.push('dob'); }
    }
  }
  flow.pendingFields = missing;
  return issues;
}
/** Render each customer stage without invoking automation. */
function render(flightCase: LocalFlightCase, flow: HybridPassengerFlow, extra = ''): CustomerFlowReply {
  const candidate = selectedCandidate(flightCase, flow);
  const snapshot = flightCase.hybridSearchSnapshot;
  const flightText = candidate && snapshot ? `${snapshot.route.fromAirportCode} → ${snapshot.route.toAirportCode} · ${snapshot.departureDate}\n${candidate.flightNumber} · ${candidate.departureTime}–${candidate.arrivalTime ?? '?'} · ${candidate.priceText ?? (candidate.priceAmount == null ? 'chưa có giá' : candidate.priceAmount.toLocaleString('vi-VN') + ' VND')}\nGiá ghi nhận lúc ${snapshot.capturedAt}, chưa được giữ chỗ.` : '';
  let response = ''; let rows: NonNullable<CustomerFlowReply['replyMarkup']>['inline_keyboard'] = [];
  if (flow.stage === 'choose') {
    response = `${flightText}\nBạn đặt vé cho ai?`;
    rows = [[button(flow, 'Khách đã lưu', 'list'), button(flow, 'Nhập khách mới', 'new')]];
  } else if (flow.stage === 'enter') {
    response = flow.pendingFields.length ? `Bạn bổ sung ${flow.pendingFields.map(f => fieldNames[f]).join(', ')} nhé.\nCó thể gửi một tin, ví dụ: Nguyễn Văn An, nam, sinh 15/08/1990.` : 'Bạn gửi phần muốn sửa, ví dụ “họ là Nguyễn” hoặc “ngày sinh 15/08/1990”.';
    if (Object.keys(flow.draft).length) response += '\nĐã ghi nhận:\n' + formatInfo(flow.draft);
  } else if (flow.stage === 'review') {
    response = `${flightText}\n\nHành khách:\n${formatInfo(flow.draft)}\nBạn kiểm tra họ và tên đúng giấy tờ trước khi xác nhận nhé.`;
    rows.push([button(flow, 'Xác nhận thông tin', 'confirm')]);
  } else if (flow.stage === 'confirmed') {
    response = `Thông tin đã được xác nhận, chưa giữ chỗ.\n${flightText}\n\n${formatInfo(flow.confirmed!.info)}`;
    if (flow.saveDecision === 'pending') rows.push([button(flow, 'Lưu cho lần sau', 'save'), button(flow, 'Chỉ dùng lần này', 'skip')]);
    if (flow.sourceProfileId) rows.push([button(flow, 'Cập nhật hồ sơ đã lưu', 'update_preview')]);
  } else if (flow.stage === 'update_review') {
    response = `Cập nhật hồ sơ đã lưu?\nĐang lưu:\n${formatInfo(flow.profileUpdateBefore ?? {})}\n\nThay bằng:\n${formatInfo(flow.confirmed!.info)}`;
    rows.push([button(flow, 'Đồng ý cập nhật hồ sơ', 'update_profile'), button(flow, 'Không cập nhật', 'back')]);
  } else if (flow.stage === 'awaiting_selection') {
    response = 'Bạn chọn lại chuyến từ danh sách mới nhất nhé. Mình giữ phần thông tin hành khách đã nhập; xác nhận cũ không còn hiệu lực.';
  } else if (flow.stage === 'cancelled') return reply('Đã hủy bước xác nhận chuyến và hành khách. Chưa có thao tác giữ chỗ.');
  if (!['awaiting_selection', 'cancelled', 'choose'].includes(flow.stage)) rows.push([button(flow, 'Sửa hành khách', 'edit'), button(flow, 'Đổi chuyến', 'change')], [button(flow, 'Khách đã lưu', 'list'), button(flow, 'Nhập khách mới', 'new')]);
  rows.push([button(flow, 'Hủy', 'cancel')]);
  return { handled: true, response: [extra, response].filter(Boolean).join('\n'), replyMarkup: { inline_keyboard: rows } };
}
/** Persist the authoritative case draft and its session pointer. */
async function saveFlow(session: HybridSearchSession, flightCase: LocalFlightCase, flow: HybridPassengerFlow, store: HybridSearchSessionStoreLike) {
  await updateLocalFlightCase(flightCase, { hybridPassengerFlow: flow, status: flow.confirmed ? 'HYBRID_DETAILS_CONFIRMED' : 'HYBRID_PASSENGER_DRAFT', holdApproval: undefined });
  session.passengerCaseId = flightCase.caseId;
  await store.write(session.chatId, session);
}
function withProfiles<T>(options: CustomerFlowOptions, callback: (store: CustomerPassengerStore) => T): T {
  const store = options.customerStoreFactory?.() ?? new CustomerPassengerStore();
  try { store.migrate(); return callback(store); } finally { store.close(); }
}
/** List only the authenticated owner’s profiles and persist offered IDs. */
function renderProfiles(flow: HybridPassengerFlow, owner: number, options: CustomerFlowOptions, page: number): CustomerFlowReply {
  const result = withProfiles(options, store => store.list(owner, { query: flow.browseQuery, page: page + 1, pageSize: 5 }));
  if (!Number.isSafeInteger(page) || page < 0 || (page > 0 && page * 5 >= result.total)) return reply(staleText);
  flow.stage = 'browse'; flow.browsePage = page; flow.offeredProfileIds = result.profiles.map(p => p.id); rotate(flow);
  const rows = result.profiles.map(profile => [button(flow, `${profile.lastName} ${profile.firstName} · ${profile.dob.split('-').reverse().join('/')}`, 'profile', String(profile.id))]);
  const nav = [];
  if (page > 0) nav.push(button(flow, 'Trang trước', 'list', String(page - 1)));
  if ((page + 1) * 5 < result.total) nav.push(button(flow, 'Trang sau', 'list', String(page + 1)));
  if (nav.length) rows.push(nav);
  rows.push([button(flow, 'Nhập khách mới', 'new'), button(flow, 'Hủy', 'cancel')]);
  return { handled: true, response: result.total ? `Khách đã lưu của bạn · trang ${page + 1}/${Math.ceil(result.total / 5)}.\nChọn đúng người hoặc gửi tên để tìm trong danh bạ của bạn.` : 'Chưa có hồ sơ phù hợp trong danh bạ của bạn. Bạn gửi tên khác hoặc chọn Nhập khách mới nhé.', replyMarkup: { inline_keyboard: rows } };
}

/** Execute a verified customer button action without entering the legacy hold path. */
export async function runCustomerPassengerAction(identity: CustomerFlowIdentity, data: string, options: CustomerFlowOptions = {}): Promise<CustomerFlowReply> {
  if (!data.startsWith('hc:')) return { handled: false };
  return withCustomerSession(identity, options, async (session, store) => {
    const match = /^hc:([a-z_]+):([a-f0-9-]{36})(?::(\d{1,12}))?$/.exec(data);
    if (!match) return reply(staleText);
    const [, action, token, arg] = match;
    const now = options.now ?? new Date();
    if (action === 'select') {
      const view = session.resultView; const index = Number(arg);
      if (!view || view.token !== token || arg === undefined || !Number.isSafeInteger(index) || index < 0 || index >= view.candidateIds.length || !session.caseId) return reply(staleText);
      const flightCase = await readLocalFlightCase(session.caseId);
      if (!flightCase || flightCase.telegramChatId !== identity.chatId) return reply(staleText);
      const priorCase = session.passengerCaseId ? await readLocalFlightCase(session.passengerCaseId) : null;
      const previous = HybridPassengerFlowSchema.safeParse(priorCase?.hybridPassengerFlow);
      const retained = previous.success && previous.data.ownerTelegramUserId === identity.userId && previous.data.stage !== 'cancelled' ? previous.data : undefined;
      const flow: HybridPassengerFlow = { ownerTelegramUserId: identity.userId, token: randomUUID(), revision: (retained?.revision ?? 0) + 1, stage: retained ? 'enter' : 'choose', selection: { caseId: flightCase.caseId, snapshotId: view.snapshotId, candidateId: view.candidateIds[index], requestKey: view.requestKey }, draft: retained?.draft ?? {}, pendingFields: [], unresolvedFields: retained?.unresolvedFields, sourceProfileId: retained?.sourceProfileId, sourceProfileVersion: retained?.sourceProfileVersion };
      if (!selectionValid(session, flightCase, flow, now)) return reply(staleText);
      if (retained) { const issues = validateDraft(flow, flightCase, options); flow.stage = flow.pendingFields.length || issues.length ? 'enter' : 'review'; }
      if (priorCase && priorCase.caseId !== flightCase.caseId && retained) { invalidate(retained); retained.stage = 'awaiting_selection'; await updateLocalFlightCase(priorCase, { hybridPassengerFlow: retained, status: 'HYBRID_PASSENGER_DRAFT', holdApproval: undefined }); }
      session.processedMessageIds.push(identity.updateId);
      await saveFlow(session, flightCase, flow, store);
      return render(flightCase, flow);
    }
    const flightCase = session.passengerCaseId ? await readLocalFlightCase(session.passengerCaseId) : null;
    const parsed = HybridPassengerFlowSchema.safeParse(flightCase?.hybridPassengerFlow);
    if (!flightCase || flightCase.telegramChatId !== identity.chatId || !parsed.success) return reply(staleText);
    const flow = parsed.data;
    if (flow.ownerTelegramUserId !== identity.userId || flow.token !== token || flow.stage === 'cancelled') return reply(staleText);
    if (!['cancel', 'change'].includes(action) && !selectionValid(session, flightCase, flow, now)) return reply(staleText);
    let result: CustomerFlowReply;
    if (action === 'cancel') { invalidate(flow); flow.stage = 'cancelled'; result = render(flightCase, flow); }
    else if (action === 'change') { invalidate(flow); flow.stage = 'awaiting_selection'; result = render(flightCase, flow); }
    else if (action === 'new') { invalidate(flow); flow.draft = {}; flow.unresolvedFields = []; flow.sourceProfileId = undefined; flow.sourceProfileVersion = undefined; flow.stage = 'enter'; validateDraft(flow, flightCase, options); result = render(flightCase, flow); }
    else if (action === 'edit') { invalidate(flow); flow.stage = 'enter'; result = render(flightCase, flow); }
    else if (action === 'list') { if (flow.confirmed) invalidate(flow); result = renderProfiles(flow, identity.userId, options, arg === undefined ? 0 : Number(arg)); }
    else if (action === 'profile' && flow.stage === 'browse' && flow.offeredProfileIds?.includes(Number(arg))) {
      const profile = withProfiles(options, db => db.get(identity.userId, Number(arg)));
      if (!profile) return reply(staleText);
      invalidate(flow); flow.draft = passengerInfo(profile); flow.unresolvedFields = []; flow.sourceProfileId = profile.id; flow.sourceProfileVersion = profile.version;
      const issues = validateDraft(flow, flightCase, options); flow.stage = flow.pendingFields.length || issues.length ? 'enter' : 'review'; result = render(flightCase, flow, issues.join('\n'));
    } else if (action === 'confirm' && flow.stage === 'review') {
      const issues = validateDraft(flow, flightCase, options);
      if (flow.pendingFields.length || issues.length) { flow.stage = 'enter'; rotate(flow); result = render(flightCase, flow, issues.join('\n')); }
      else {
        flow.confirmed = { info: passengerInfo(flow.draft as CustomerPassengerInfo), revision: flow.revision, confirmedAt: now.toISOString(), selection: { ...flow.selection } };
        flow.stage = 'confirmed'; flow.saveDecision = flow.sourceProfileId ? 'skipped' : 'pending'; rotate(flow); result = render(flightCase, flow);
      }
    } else if (action === 'save' && flow.stage === 'confirmed' && flow.confirmed && flow.saveDecision === 'pending') {
      const profile = withProfiles(options, db => db.create(identity.userId, flow.confirmed!.info, `${flightCase.caseId}:${flow.revision}`));
      flow.sourceProfileId = profile.id; flow.sourceProfileVersion = profile.version; flow.saveDecision = 'saved'; rotate(flow); result = render(flightCase, flow, 'Đã lưu vào danh bạ riêng của bạn.');
    } else if (action === 'skip' && flow.stage === 'confirmed' && flow.confirmed) { flow.saveDecision = 'skipped'; rotate(flow); result = render(flightCase, flow, 'Thông tin chỉ dùng cho yêu cầu này, không lưu thêm vào danh bạ.'); }
    else if (action === 'update_preview' && flow.stage === 'confirmed' && flow.confirmed && flow.sourceProfileId) {
      const profile = withProfiles(options, db => db.get(identity.userId, flow.sourceProfileId!));
      if (!profile || profile.version !== flow.sourceProfileVersion) return reply('Hồ sơ đã được thay đổi. Bạn chọn lại từ Khách đã lưu để kiểm tra trước khi cập nhật.');
      flow.profileUpdateBefore = passengerInfo(profile); flow.stage = 'update_review'; rotate(flow);
      result = { handled: true, response: `Cập nhật hồ sơ đã lưu?\nĐang lưu:\n${formatInfo(profile)}\n\nThay bằng:\n${formatInfo(flow.confirmed.info)}\nThông tin đã xác nhận của case này không thay đổi.`, replyMarkup: { inline_keyboard: [[button(flow, 'Đồng ý cập nhật hồ sơ', 'update_profile')], [button(flow, 'Không cập nhật', 'back')]] } };
    } else if (action === 'update_profile' && flow.stage === 'update_review' && flow.confirmed && flow.sourceProfileId && flow.sourceProfileVersion) {
      const profile = withProfiles(options, db => db.update(identity.userId, flow.sourceProfileId!, flow.sourceProfileVersion!, flow.confirmed!.info));
      flow.sourceProfileVersion = profile.version; flow.stage = 'confirmed'; rotate(flow); result = render(flightCase, flow, 'Đã cập nhật hồ sơ riêng sau khi bạn xác nhận.');
    } else if (action === 'back' && flow.stage === 'update_review') { flow.stage = 'confirmed'; rotate(flow); result = render(flightCase, flow); }
    else return reply(staleText);
    session.processedMessageIds.push(identity.updateId);
    await saveFlow(session, flightCase, flow, store);
    return result;
  });
}

/** Interpret a private follow-up and update only its validated passenger draft. */
export async function runCustomerPassengerMessage(identity: CustomerFlowIdentity, text: string, options: CustomerFlowOptions = {}): Promise<CustomerFlowReply> {
  return withCustomerSession(identity, options, async (session, store) => {
    const flightCase = session.passengerCaseId ? await readLocalFlightCase(session.passengerCaseId) : null;
    const parsed = HybridPassengerFlowSchema.safeParse(flightCase?.hybridPassengerFlow);
    if (!flightCase || flightCase.telegramChatId !== identity.chatId || !parsed.success || ['awaiting_selection', 'cancelled'].includes(parsed.data.stage)) return { handled: false };
    const flow = parsed.data;
    if (flow.ownerTelegramUserId !== identity.userId) return reply(staleText);
    if (!selectionValid(session, flightCase, flow, options.now ?? new Date())) { invalidate(flow); flow.stage = 'awaiting_selection'; await saveFlow(session, flightCase, flow, store); return render(flightCase, flow); }
    await options.onProcessingStarted?.();
    const proposal = await (options.interpret ?? interpretHybridPassengerMessage)(text, { draft: flow.draft, pendingFields: flow.pendingFields, browseMode: flow.stage === 'browse', now: options.now });
    if (proposal.intent === 'search') return { handled: false };
    if (flow.stage === 'browse' && (proposal.intent === 'lookup' || proposal.intent === 'greeting')) {
      if (proposal.intent === 'lookup' && proposal.query) flow.browseQuery = proposal.query;
      const result = renderProfiles(flow, identity.userId, options, proposal.intent === 'greeting' ? flow.browsePage ?? 0 : 0);
      session.processedMessageIds.push(identity.updateId); await saveFlow(session, flightCase, flow, store); return result;
    }
    if (proposal.intent === 'cancel') { invalidate(flow); flow.stage = 'cancelled'; }
    else if (proposal.intent === 'provide' && (Object.keys(proposal.patch).length || proposal.issues.length)) {
      invalidate(flow); flow.draft = { ...flow.draft, ...proposal.patch };
      flow.unresolvedFields = [...new Set([...(flow.unresolvedFields ?? []).filter(field => proposal.patch[field] === undefined), ...(proposal.invalidFields ?? [])])];
      const issues = validateDraft(flow, flightCase, options); proposal.issues.push(...issues);
      flow.stage = flow.pendingFields.length || proposal.issues.length ? 'enter' : 'review';
    }
    session.processedMessageIds.push(identity.updateId); await saveFlow(session, flightCase, flow, store);
    return render(flightCase, flow, proposal.intent === 'greeting' ? 'Chào bạn! Mình vẫn giữ thông tin bạn đang nhập.' : proposal.issues.join('\n'));
  }, true);
}

/** Authorize private entry and serialize actions with search-session work. */
async function withCustomerSession(identity: CustomerFlowIdentity, options: CustomerFlowOptions, callback: (session: HybridSearchSession, store: HybridSearchSessionStoreLike) => Promise<CustomerFlowReply>, allowFallthrough = false): Promise<CustomerFlowReply> {
  if (readAgentOrchestrationMode() !== 'hybrid_search') return { handled: false };
  if (identity.chatType !== 'private') return allowFallthrough ? { handled: false } : reply('Bạn mở chat riêng với bot, tìm và chọn chuyến tại đó để nhập thông tin hành khách nhé.');
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) return reply(staleText);
  const settings = await (options.settingsReader ?? readLocalAgentSettings)().catch(() => null);
  if (!settings?.agentEnabled) return reply('Agent hiện đang tắt.');
  const store = options.sessionStore ?? new HybridSearchSessionStore();
  const run = async () => {
    const session = await store.read(identity.chatId);
    if (!session || (allowFallthrough && !session.passengerCaseId)) return allowFallthrough ? { handled: false } : reply(staleText);
    if (identity.chatId !== identity.userId) return reply(staleText);
    if (session.processedMessageIds.includes(identity.updateId)) return { handled: true, duplicate: true };
    try { return await callback(session, store); }
    catch { return reply('Mình chưa xử lý được thao tác này. Dữ liệu chưa được xác nhận thêm; bạn thử lại hoặc mở danh sách mới nhất nhé.'); }
  };
  return store.runExclusive ? store.runExclusive(identity.chatId, run) : run();
}
