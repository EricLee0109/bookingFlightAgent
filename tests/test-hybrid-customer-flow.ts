import { Usage, type Model } from '@openai/agents';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFlightSearchSnapshot } from '../src/automation/1booking/flight-search-snapshot';
import { createEmptyHybridSearchSession, HybridSearchSessionStore } from '../src/storage/hybrid-search-session-store';
import { hybridRequestKey } from '../src/passengers/hybrid-passenger-state';
import type { CustomerFlowReply } from '../src/services/hybrid-customer-passenger-service';

async function main() {
  // Run in a subprocess so tsx/native worker working-directory handles are closed before cleanup.
  if (process.env.BOOKING_CUSTOMER_FLOW_TEST_CHILD !== '1') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-customer-'));
    try {
      execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, __filename], {
        cwd: directory, stdio: 'inherit', env: { ...process.env, BOOKING_CUSTOMER_FLOW_TEST_CHILD: '1', OPENAI_API_KEY: '', NINE_ROUTER_API_KEY: '', TELEGRAM_BOT_TOKEN: '' },
      });
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    return;
  }
  const root = process.cwd(); const dir = process.cwd();
  const oldMode = process.env.AGENT_ORCHESTRATION_MODE, oldIds = process.env.TELEGRAM_OPERATOR_IDS;
  process.env.AGENT_ORCHESTRATION_MODE = 'hybrid_search'; process.env.TELEGRAM_OPERATOR_IDS = '42,43'; process.chdir(dir);
  try {
    const { CustomerPassengerStore } = await import('../src/passengers/customer-passenger-store');
    const { createLocalFlightCase, updateLocalFlightCase, readLocalFlightCase } = await import('../src/storage/local-case-store');
    const { runCustomerPassengerAction, runCustomerPassengerMessage, invalidateCustomerSelectionAfterSearch } = await import('../src/services/hybrid-customer-passenger-service');
    const { handleTelegramCustomerPassengerCallback } = await import('../src/telegram/telegram-hybrid-search');
    const store = new HybridSearchSessionStore();
    const dbPath = path.join(dir, 'customers.sqlite');
    const customerStoreFactory = () => new CustomerPassengerStore(dbPath);
    const settingsReader = async () => ({ agentEnabled: true, autoSearchFlights: true, autoHoldBooking: true, requireConfirmationBeforeHold: false, debugMode: false });
    const options = { sessionStore: store, customerStoreFactory, settingsReader, now: new Date('2026-09-16T08:00:00Z'), minimumAge: 18 };
    let sequence = 0;
    const identity = (user = 42, chat = 42, chatType = 'private') => ({ userId: user, chatId: chat, chatType, updateId: 'customer-' + ++sequence });
    const key = (result: CustomerFlowReply, text: string) => { const b = result.replyMarkup?.inline_keyboard.flat().find(b => b.text === text); assert.ok(b, 'Missing button: ' + text + '\n' + result.response); assert.ok(Buffer.byteLength(b.callback_data) <= 64); return b.callback_data; };
    const act = (data: string, who = identity()) => runCustomerPassengerAction(who, data, options);
    const info = { lastName: 'Nguyễn', firstName: 'Văn An', gender: 'M' as const, dob: '1990-08-15' };
    async function seed(chat: number) {
      const flightCase = await createLocalFlightCase('offline fixture', chat);
      const snapshot = createFlightSearchSnapshot({ snapshotId: 'FS-' + chat, capturedAt: options.now, route: { fromAirportCode: 'SGN', fromAirportText: 'HCM', toAirportCode: 'HAN', toAirportText: 'Hà Nội' }, departureDate: '2026-12-10', candidates: [0, 1].map(cardIndex => ({ cardIndex, airlineCode: 'VJ', airlineName: 'Vietjet Air', flightNumber: 'VJ' + (100 + cardIndex), departureTime: '19:00', arrivalTime: '21:00', bookingClass: 'ECO', rawBookingClassCode: 'ECO', priceText: '1,000,000 VND', priceAmount: 1_000_000 })) });
      await updateLocalFlightCase(flightCase, { status: 'SEARCH_DONE', hybridSearchSnapshot: snapshot });
      const session = createEmptyHybridSearchSession(chat, chat); session.caseId = flightCase.caseId; session.snapshot = snapshot; session.snapshotId = snapshot.snapshotId; session.snapshotFresh = true;
      session.draftRequest = { ...snapshot.route, departureDate: snapshot.departureDate, tripType: 'one_way' };
      session.resultView = { token: randomUUID(), snapshotId: snapshot.snapshotId, candidateIds: snapshot.candidates.map(c => c.candidateId), pageSize: 2, requestKey: hybridRequestKey(session) };
      await store.write(chat, session); return { flightCase, session, select: `hc:select:${session.resultView.token}:0` };
    }
    const seeded = await seed(42); const second = await seed(43);
    assert.match((await act(seeded.select, identity(42, -100, 'group'))).response!, /chat riêng/);
    assert.match((await act(seeded.select, identity(43, 43))).response!, /đã cũ/);
    assert.match((await act('hc:select:' + seeded.session.resultView!.token + ':99')).response!, /đã cũ/);
    let result = await act(seeded.select);
    assert.match(result.response!, /Bạn đặt vé cho ai/);
    result = await act(key(result, 'Nhập khách mới'));
    assert.match(result.response!, /ngày sinh/);
    const send = (patch: object, intent = 'provide', text = 'offline customer input') => runCustomerPassengerMessage(identity(), text, { ...options, interpret: async () => ({ intent, patch, issues: [] }) as never });
    result = await send({ lastName: info.lastName, firstName: info.firstName });
    assert.match(result.response!, /giới tính/);
    const beforeGreeting = (await readLocalFlightCase(seeded.flightCase.caseId))!.hybridPassengerFlow!;
    await send({}, 'greeting', 'xin chào');
    assert.deepEqual((await readLocalFlightCase(seeded.flightCase.caseId))!.hybridPassengerFlow!.draft, beforeGreeting.draft);
    result = await send({ gender: 'M' });
    assert.match(result.response!, /ngày sinh/);
    result = await send({ dob: '1990-02-31' });
    assert.match(result.response!, /Ngày sinh chưa hợp lệ/);
    result = await send({ dob: '2020-01-01' });
    assert.match(result.response!, /18 tuổi/);
    result = await send({ dob: '2008-12-11' });
    assert.match(result.response!, /18 tuổi/);
    assert.ok(!result.replyMarkup?.inline_keyboard.flat().some(b => b.text === 'Xác nhận thông tin'));
    result = await send({ dob: '2008-12-10' });
    assert.ok(key(result, 'Xác nhận thông tin'));
    result = await send({ dob: info.dob });
    assert.match(result.response!, /Họ: Nguyễn/);
    assert.match(result.response!, /Tên đệm và tên: Văn An/);
    const confirmButton = key(result, 'Xác nhận thông tin');
    // Invalid deployment policy must fail closed even with a complete adult draft.
    const missingPolicy = await runCustomerPassengerAction(identity(), confirmButton, { ...options, minimumAge: NaN });
    assert.match(missingPolicy.response!, /Cấu hình độ tuổi chưa hợp lệ/);
    assert.equal((await readLocalFlightCase(seeded.flightCase.caseId))!.hybridPassengerFlow!.confirmed, undefined);
    result = await send({ dob: info.dob });
    const activeConfirmButton = key(result, 'Xác nhận thông tin');
    // A configured value of 12 must never weaken the approved age policy.
    const weakerPolicy = await runCustomerPassengerAction(identity(), activeConfirmButton, { ...options, minimumAge: 12 });
    assert.match(weakerPolicy.response!, /Cấu hình độ tuổi chưa hợp lệ/);
    result = await send({ dob: info.dob });
    const finalConfirmButton = key(result, 'Xác nhận thông tin');
    const confirmedIdentity = identity(); result = await act(finalConfirmButton, confirmedIdentity);
    assert.match(result.response!, /Thông tin đã được xác nhận, chưa giữ chỗ/);
    assert.equal((await act(finalConfirmButton, confirmedIdentity)).duplicate, true);
    assert.match((await act(confirmButton)).response!, /đã cũ/);
    let currentCase = (await readLocalFlightCase(seeded.flightCase.caseId))!;
    assert.equal(currentCase.status, 'HYBRID_DETAILS_CONFIRMED'); assert.equal(currentCase.holdApproval, undefined); assert.equal(currentCase.attachedPassengerInfo, undefined); assert.equal(currentCase.holdSubmittedAt, undefined);
    const dbCount = (user = 42) => { const db = customerStoreFactory(); try { db.migrate(); return db.list(user).total; } finally { db.close(); } };
    assert.equal(dbCount(), 0);
    const beforeSave = structuredClone(currentCase.hybridPassengerFlow!.confirmed);
    result = await act(key(result, 'Lưu cho lần sau'));
    assert.equal(dbCount(), 1);
    currentCase = (await readLocalFlightCase(seeded.flightCase.caseId))!;
    const profileId = currentCase.hybridPassengerFlow!.sourceProfileId!;
    // Reconstruct session store to prove draft/confirmation survive restart.
    result = await runCustomerPassengerAction(identity(), key(result, 'Sửa hành khách'), { ...options, sessionStore: new HybridSearchSessionStore() });
    assert.equal((await readLocalFlightCase(currentCase.caseId))!.hybridPassengerFlow!.confirmed, undefined);
    result = await send({ dob: '1991-08-15' });
    { const db = customerStoreFactory(); try { assert.equal(db.get(42, profileId)!.dob, info.dob); } finally { db.close(); } }
    result = await act(key(result, 'Xác nhận thông tin'));
    result = await act(key(result, 'Cập nhật hồ sơ đã lưu'));
    assert.match(result.response!, /Đang lưu:/); assert.match(result.response!, /Thay bằng:/);
    result = await act(key(result, 'Đồng ý cập nhật hồ sơ'));
    { const db = customerStoreFactory(); try { assert.equal(db.get(42, profileId)!.dob, '1991-08-15'); } finally { db.close(); } }
    assert.equal(beforeSave!.info.dob, info.dob);
    currentCase = (await readLocalFlightCase(currentCase.caseId))!;
    const confirmedCopy = structuredClone(currentCase.hybridPassengerFlow!.confirmed);
    { const db = customerStoreFactory(); try { const p = db.get(42, profileId)!; db.update(42, p.id, p.version, { ...info, dob: '1992-08-15' }); } finally { db.close(); } }
    assert.deepEqual((await readLocalFlightCase(currentCase.caseId))!.hybridPassengerFlow!.confirmed, confirmedCopy);
    result = await act(key(result, 'Đổi chuyến'));
    assert.match(result.response!, /giữ phần thông tin/);
    result = await act(seeded.select.replace(/:0$/, ':1'));
    assert.match(result.response!, /VJ101/); assert.match(result.response!, /1991/);
    assert.equal((await readLocalFlightCase(currentCase.caseId))!.hybridPassengerFlow!.confirmed, undefined);
    // Foreign profile IDs cannot be chosen even with this user's valid flow token.
    let otherResult = await act(second.select, identity(43, 43));
    otherResult = await act(key(otherResult, 'Khách đã lưu'), identity(43, 43));
    assert.match(otherResult.response!, /Chưa có hồ sơ/);
    const otherCase = (await readLocalFlightCase(second.flightCase.caseId))!;
    assert.match((await act(`hc:profile:${otherCase.hybridPassengerFlow!.token}:${profileId}`, identity(43, 43))).response!, /đã cũ/);
    { const db = customerStoreFactory(); try { for (let i = 0; i < 7; i++) db.create(43, { ...info, firstName: 'Khách ' + i }, 'other-' + i); } finally { db.close(); } }
    otherResult = await act(key(otherResult, 'Nhập khách mới'), identity(43, 43));
    otherResult = await act(second.select, identity(43, 43));
    // Cancel/reselect starts a clean passenger choice menu.
    otherResult = await act(key(otherResult, 'Hủy'), identity(43, 43));
    otherResult = await act(second.select, identity(43, 43));
    otherResult = await act(key(otherResult, 'Khách đã lưu'), identity(43, 43));
    assert.match(otherResult.response!, /1\/2/);
    otherResult = await act(key(otherResult, 'Trang sau'), identity(43, 43));
    assert.match(otherResult.response!, /2\/2/);
    // Owner-scoped name lookup stays separate from search and handles greetings.
    const lookup = await runCustomerPassengerMessage(identity(43, 43), 'Khách', { ...options, interpret: async () => ({ intent: 'lookup', query: 'Khách', patch: {}, issues: [] }) });
    assert.match(lookup.response!, /Khách đã lưu của bạn/);
    const browseGreeting = await runCustomerPassengerMessage(identity(43, 43), 'xin chào', { ...options, interpret: async () => ({ intent: 'greeting', patch: {}, issues: [] }) });
    assert.match(browseGreeting.response!, /Khách đã lưu của bạn/);
    const searchRouting = await runCustomerPassengerMessage(identity(43, 43), 'tìm chuyến khác', { ...options, interpret: async () => ({ intent: 'search', patch: {}, issues: [] }) });
    assert.equal(searchRouting.handled, false);
    const chosenProfile = lookup.replyMarkup!.inline_keyboard.flat().find(b => b.callback_data.includes(':profile:'))!;
    // The greeting rotates only browse controls; older candidate buttons are stale.
    assert.match((await act(chosenProfile.callback_data, identity(43, 43))).response!, /đã cũ/);
    const freshChoice = browseGreeting.replyMarkup!.inline_keyboard.flat().find(b => b.callback_data.includes(':profile:'))!;
    let chosen = await act(freshChoice.callback_data, identity(43, 43));
    assert.match(chosen.response!, /kiểm tra họ và tên/);
    chosen = await act(key(chosen, 'Nhập khách mới'), identity(43, 43));
    chosen = await runCustomerPassengerMessage(identity(43, 43), 'full customer', { ...options, interpret: async () => ({ intent: 'provide', patch: info, issues: [] }) });
    chosen = await act(key(chosen, 'Xác nhận thông tin'), identity(43, 43));
    const countBeforeSkip = dbCount(43);
    chosen = await act(key(chosen, 'Chỉ dùng lần này'), identity(43, 43));
    assert.equal(dbCount(43), countBeforeSkip);
    assert.match(chosen.response!, /không lưu thêm/);
    assert.equal((await readLocalFlightCase(second.flightCase.caseId))!.hybridPassengerFlow!.saveDecision, 'skipped');
    // Cross the actual SDK parsing seam for the customer's full single-message example.
    const { interpretHybridPassengerMessage } = await import('../src/agent/hybrid-passenger-agent');
    const sdkModel: Model = { async getResponse() { return { usage: new Usage({ requests: 1 }), output: [{ type: 'function_call', callId: 'customer-full', name: 'propose_passenger', arguments: JSON.stringify({ intent: 'provide', fullName: 'Nguyễn Văn An', gender: 'M', dob: '1990-08-15' }) }] }; }, async *getStreamedResponse() { throw Error('unused'); } };
    const sdkReply = await runCustomerPassengerMessage(identity(43, 43), 'Nguyễn Văn An, nam, sinh 15/08/1990', { ...options, interpret: (text, ctx) => interpretHybridPassengerMessage(text, { ...ctx, model: sdkModel }) });
    assert.ok(key(sdkReply, 'Xác nhận thông tin'));
    assert.match(sdkReply.response!, /Ngày sinh: 15\/08\/1990/);
    const rejected = await runCustomerPassengerMessage(identity(43, 43), 'sửa ngày sinh không rõ', { ...options, interpret: async () => ({ intent: 'provide', patch: {}, invalidFields: ['dob'], issues: ['Bạn gửi rõ ngày sinh nhé.'] }) });
    assert.ok(!rejected.replyMarkup?.inline_keyboard.flat().some(b => b.text === 'Xác nhận thông tin'));
    assert.deepEqual((await readLocalFlightCase(second.flightCase.caseId))!.hybridPassengerFlow!.unresolvedFields, ['dob']);
    // An unrelated valid gender patch cannot silently accept the old DOB again.
    const unrelated = await runCustomerPassengerMessage(identity(43, 43), 'nam', { ...options, interpret: async () => ({ intent: 'provide', patch: { gender: 'M' }, issues: [] }) });
    assert.ok(!unrelated.replyMarkup?.inline_keyboard.flat().some(b => b.text === 'Xác nhận thông tin'));
    // Recover a rejected DOB across restart when the provider copies Vietnamese date format.
    const dobModel: Model = { async getResponse() { return { usage: new Usage({ requests: 1 }), output: [{ type: 'function_call', callId: 'customer-dob-recovery', name: 'propose_passenger', arguments: JSON.stringify({ intent: 'provide', dob: '07/09/2002' }) }] }; }, async *getStreamedResponse() { throw Error('unused'); } };
    const recoveryOptions = { ...options, sessionStore: new HybridSearchSessionStore(), interpret: (text: string, ctx: Parameters<typeof interpretHybridPassengerMessage>[1]) => interpretHybridPassengerMessage(text, { ...ctx, model: dobModel }) };
    const dobRecovered = await runCustomerPassengerMessage(identity(43, 43), 'sinh 07/09/2002', { ...recoveryOptions, minimumAge: NaN });
    assert.match(dobRecovered.response!, /Ngày sinh: 07\/09\/2002/);
    assert.match(dobRecovered.response!, /Cấu hình độ tuổi chưa hợp lệ/);
    assert.doesNotMatch(dobRecovered.response!, /Ngày sinh cần đủ/);
    const recoveredFlow = (await readLocalFlightCase(second.flightCase.caseId))!.hybridPassengerFlow!;
    assert.equal(recoveredFlow.draft.dob, '2002-09-07');
    assert.deepEqual(recoveredFlow.pendingFields, []);
    assert.deepEqual(recoveredFlow.unresolvedFields, []);
    assert.equal(recoveredFlow.confirmed, undefined);
    // With an explicit test age policy, the same date reaches review and confirmation.
    const dobReview = await runCustomerPassengerMessage(identity(43, 43), '07/09/2002', recoveryOptions);
    const dobConfirmed = await act(key(dobReview, 'Xác nhận thông tin'), identity(43, 43));
    assert.match(dobConfirmed.response!, /Thông tin đã được xác nhận, chưa giữ chỗ/);
    assert.equal(dbCount(43), countBeforeSkip);

    // A new search invalidates the old confirmation while preserving its draft.
    result = await act(key(result, 'Xác nhận thông tin'));
    const beforeChange = (await readLocalFlightCase(currentCase.caseId))!.hybridPassengerFlow!.draft;
    const changedSession = (await store.read(42))!; changedSession.draftRequest!.departureDate = '2026-12-11'; await store.write(42, changedSession);
    await invalidateCustomerSelectionAfterSearch((await store.read(42))!, options.now);
    const invalidated = (await readLocalFlightCase(currentCase.caseId))!.hybridPassengerFlow!;
    assert.equal(invalidated.stage, 'awaiting_selection'); assert.equal(invalidated.confirmed, undefined); assert.deepEqual(invalidated.draft, beforeChange);
    // Actual transport refuses unauthorized users and group profile entry before DB access.
    const sent: string[] = []; const bot = { sendMessage: async (_id: number, text: string) => { sent.push(text); } } as never;
    await handleTelegramCustomerPassengerCallback(bot, { data: seeded.select, id: 'deny', from: { id: 99 }, message: { chat: { id: 99, type: 'private' } } } as never, options);
    assert.match(sent.at(-1)!, /chưa có quyền/);
    await handleTelegramCustomerPassengerCallback(bot, { data: seeded.select, id: 'group', from: { id: 42 }, message: { chat: { id: -1, type: 'group' } } } as never, options);
    assert.match(sent.at(-1)!, /chat riêng/);
    console.log('Customer flow passed: selection IDs, owner isolation, multi-turn draft, DOB, confirmation/replay, consent save, explicit update, restart, invalidation, no hold.');
  } finally {
    process.chdir(root); if (oldMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE; else process.env.AGENT_ORCHESTRATION_MODE = oldMode;
    if (oldIds === undefined) delete process.env.TELEGRAM_OPERATOR_IDS; else process.env.TELEGRAM_OPERATOR_IDS = oldIds;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
