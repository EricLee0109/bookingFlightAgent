import assert from 'node:assert/strict';
import type { ClientOptions } from 'openai';
import { Usage, type Model, type ModelResponse } from '@openai/agents';
import {
  interpretHybridPassengerMessage,
  type HybridPassengerIntent,
} from '../src/agent/hybrid-passenger-agent';
import { readAIConnectionConfig } from '../src/agent/ai-provider';

type Proposal = {
  intent: HybridPassengerIntent;
  fullName?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  gender?: 'M' | 'F' | null;
  dob?: string | null;
  query?: string | null;
  unsupported?: 'multiple_passengers' | 'child_or_infant' | null;
};

function fakeModel(
  response: Proposal | 'text' | 'timeout',
  calls: { value: number } = { value: 0 },
): Model {
  return {
    async getResponse(): Promise<ModelResponse> {
      calls.value += 1;
      if (response === 'timeout') {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return {
          usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }),
          output: [],
        } as ModelResponse;
      }
      if (response === 'text') {
        return {
          usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }),
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'raw model prose must stay private' }],
          }],
        } as ModelResponse;
      }
      return {
        usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }),
        output: [{
          type: 'function_call',
          callId: `passenger-${calls.value}`,
          name: 'propose_passenger',
          arguments: JSON.stringify(response),
        }],
      } as ModelResponse;
    },
    async *getStreamedResponse() {
      throw new Error('streaming is not used by this contract');
    },
  } as Model;
}

async function withEnvironment<T>(
  values: NodeJS.ProcessEnv,
  callback: () => Promise<T>,
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

async function main() {
  const now = new Date('2026-09-16T00:00:00.000Z');

  const ordinary = await interpretHybridPassengerMessage(
    'Nguyễn Văn An, Nam, sinh 02/03/1990',
    {
      now,
      model: fakeModel({
        intent: 'provide',
        fullName: 'Nguyễn Văn An',
        gender: 'M',
        dob: '1990-03-02',
      }),
    },
  );
  assert.equal(ordinary.intent, 'provide');
  assert.deepEqual(ordinary.patch, {
    lastName: 'Nguyễn',
    firstName: 'Văn An',
    gender: 'M',
    dob: '1990-03-02',
  });
  assert.deepEqual(ordinary.issues, []);

  const shortGender = await interpretHybridPassengerMessage('Nữ', {
    draft: {
      lastName: 'NGUYEN',
      firstName: 'THI LANH',
      gender: 'M',
      dob: '1980-01-01',
    },
    pendingFields: ['gender'],
    model: fakeModel({ intent: 'provide', gender: 'F' }),
    now,
  });
  assert.deepEqual(shortGender.patch, { gender: 'F' });
  assert.deepEqual(shortGender.invalidFields, undefined);

  const shortDob = await interpretHybridPassengerMessage('02/03/1990', {
    draft: { dob: '1980-01-01' },
    pendingFields: ['dob'],
    model: fakeModel({ intent: 'provide', dob: '1990-03-02' }),
    now,
  });
  assert.deepEqual(shortDob.patch, { dob: '1990-03-02' });

  // A provider may copy the user's DD/MM/YYYY even though storage uses ISO.
  for (const text of ['Giới tính: Nam, Ngày sinh: 07/09/2002', '07/09/2002', 'sinh 07/09/2002']) {
    for (const dob of ['07/09/2002', '2002-09-07']) {
      const repairedDob = await interpretHybridPassengerMessage(text, {
        draft: { lastName: 'Nguyễn', firstName: 'Văn An', gender: 'M' },
        pendingFields: ['dob'], now, model: fakeModel({ intent: 'provide', dob }),
      });
      assert.deepEqual(repairedDob.patch, { dob: '2002-09-07' }, 'DOB must accept equivalent provider format: ' + dob);
      assert.deepEqual(repairedDob.issues, []);
    }
  }

  for (const [text, dob, expected] of [
    ['sinh 7/09/2002', '7/9/2002', '2002-09-07'],
    ['sinh 07.9.2002', '2002-09-07', '2002-09-07'],
    ['sinh 07-09-2002', '07-09-2002', '2002-09-07'],
    ['sinh ngày 7 tháng 9 năm 2002', '7 tháng 9 năm 2002', '2002-09-07'],
    ['sinh 29/02/2000', '29/02/2000', '2000-02-29'],
    ['sinh 31/02/2002', '31/02/2002', undefined],
    ['sinh 29/02/2001', '29/02/2001', undefined],
    ['sinh 07/09/2002', '2002-07-09', undefined],
    ['sinh 07/09/2002', '09/07/2002', undefined],
    ['sinh 07/09/02', '2002-09-07', undefined],
    ['sinh 07/09/2099', '07/09/2099', undefined],
    ['sinh 07/09/2002 hoặc 08/09/2002', '07/09/2002', undefined],
    ['sinh 31/02/2002 hoặc 07/09/2002', '07/09/2002', undefined],
    ['tôi đã gửi rồi', '07/09/2002', undefined],
  ] as const) {
    const checked = await interpretHybridPassengerMessage(text, {
      now, draft: { dob: '2002-09-07' }, pendingFields: ['dob'],
      model: fakeModel({ intent: 'provide', dob }),
    });
    assert.equal(checked.patch.dob, expected, 'DOB canonical evidence: ' + text);
    assert.equal(checked.invalidFields?.includes('dob') ?? false, expected === undefined);
  }

  const surnameEdit = await interpretHybridPassengerMessage('Sửa họ là Trần', {
    model: fakeModel({ intent: 'provide', lastName: 'Trần' }),
    now,
  });
  assert.deepEqual(surnameEdit.patch, { lastName: 'Trần' });

  const surnameEditAsFullName = await interpretHybridPassengerMessage('Họ là Trần', {
    model: fakeModel({ intent: 'provide', fullName: 'Trần' }),
    now,
  });
  assert.deepEqual(surnameEditAsFullName.patch, { lastName: 'Trần' });

  for (const intent of ['greeting', 'search', 'cancel'] as const) {
    const result = await interpretHybridPassengerMessage('xin chào', {
      model: fakeModel({
        intent,
        fullName: 'Nguyễn Văn An',
        gender: 'M',
        dob: '1990-03-02',
      }),
      now,
    });
    assert.equal(result.intent, intent);
    assert.deepEqual(result.patch, {});
  }

  for (const [text, unsupported] of [
    ['hai hành khách: Nguyễn Văn An và Trần Thị Bình', 'multiple_passengers'],
    ['Đặt vé cho trẻ em', 'child_or_infant'],
  ] as const) {
    const result = await interpretHybridPassengerMessage(text, {
      model: fakeModel({ intent: 'provide', unsupported }),
      now,
    });
    assert.equal(result.intent, 'unknown');
    assert.deepEqual(result.patch, {});
    assert.equal(result.issues.length, 1);
    assert.doesNotMatch(result.issues[0], /raw|unsupported/iu);
  }

  const invalidDate = await interpretHybridPassengerMessage('sinh 30/02/1990', {
    model: fakeModel({ intent: 'provide', dob: '1990-02-30' }),
    now,
  });
  assert.deepEqual(invalidDate.patch, {});
  assert.deepEqual(invalidDate.invalidFields, ['dob']);
  assert.match(invalidDate.issues.join(' '), /Ngày sinh/);

  const fabricatedDate = await interpretHybridPassengerMessage('sinh 01/01/1990', {
    model: fakeModel({ intent: 'provide', dob: '2099-01-01' }),
    now,
  });
  assert.deepEqual(fabricatedDate.patch, {});
  assert.deepEqual(fabricatedDate.invalidFields, ['dob']);

  const nameOnly = await interpretHybridPassengerMessage('Nam', { pendingFields: ['firstName'], model: fakeModel({ intent: 'provide', firstName: 'Nam', gender: 'M' }), now });
  assert.equal(nameOnly.patch.firstName, 'Nam');
  assert.equal(nameOnly.patch.gender, undefined);
  const adultName = await interpretHybridPassengerMessage('Nguyễn Văn Bé, nam, sinh 15/08/1990', { model: fakeModel({ intent: 'provide', fullName: 'Nguyễn Văn Bé', gender: 'M', dob: '1990-08-15' }), now });
  assert.equal(adultName.patch.firstName, 'Văn Bé');
  assert.equal(adultName.issues.length, 0);

  const inferredGender = await interpretHybridPassengerMessage('Nguyễn Văn Nam', {
    model: fakeModel({ intent: 'provide', fullName: 'Nguyễn Văn Nam', gender: 'F' }),
    now,
  });
  assert.equal(inferredGender.patch.gender, undefined);
  assert.ok(inferredGender.invalidFields?.includes('gender'));
  assert.equal(inferredGender.patch.lastName, 'Nguyễn');
  assert.equal(inferredGender.patch.firstName, 'Văn Nam');

  const contradictoryGender = await interpretHybridPassengerMessage('Nam, Nguyễn Văn An', {
    model: fakeModel({ intent: 'provide', fullName: 'Nguyễn Văn An', gender: 'F' }),
    now,
  });
  assert.equal(contradictoryGender.patch.gender, undefined);
  assert.ok(contradictoryGender.invalidFields?.includes('gender'));

  for (const text of ['Mình tên là Nam', 'Tên là Nữ']) {
    const nameWordGender = await interpretHybridPassengerMessage(text, {
      model: fakeModel({
        intent: 'provide',
        firstName: text.endsWith('Nam') ? 'Nam' : 'Nữ',
        gender: text.endsWith('Nam') ? 'M' : 'F',
      }),
      now,
    });
    assert.equal(nameWordGender.patch.gender, undefined);
    assert.ok(nameWordGender.invalidFields?.includes('gender'));
  }

  const ambiguousDates = await interpretHybridPassengerMessage(
    'sinh 02/03/1990, ngày khác 03/04/1991',
    {
      model: fakeModel({ intent: 'provide', dob: '1990-03-02' }),
      now,
    },
  );
  assert.equal(ambiguousDates.patch.dob, undefined);
  assert.deepEqual(ambiguousDates.invalidFields, ['dob']);

  const fabricatedName = await interpretHybridPassengerMessage('Nguyễn Văn An', {
    model: fakeModel({ intent: 'provide', lastName: 'FAKE', firstName: 'PERSON' }),
    now,
  });
  assert.deepEqual(fabricatedName.patch, {});
  assert.deepEqual(fabricatedName.invalidFields, ['lastName', 'firstName']);
  assert.doesNotMatch(fabricatedName.issues.join(' '), /FAKE|PERSON/);

  const browseLookup = await interpretHybridPassengerMessage('Tìm Nguyễn', {
    browseMode: true,
    model: fakeModel({ intent: 'lookup', query: 'Nguyễn' }),
    now,
  });
  assert.equal(browseLookup.intent, 'lookup');
  assert.equal(browseLookup.query, 'Nguyễn');
  assert.deepEqual(browseLookup.patch, {});

  const fabricatedLookup = await interpretHybridPassengerMessage('Tìm Nguyễn', {
    browseMode: true,
    model: fakeModel({ intent: 'lookup', query: 'Trần' }),
    now,
  });
  assert.equal(fabricatedLookup.intent, 'unknown');
  assert.equal(fabricatedLookup.query, undefined);
  assert.deepEqual(fabricatedLookup.patch, {});

  const noTool = await interpretHybridPassengerMessage('Nguyễn Văn An', {
    model: fakeModel('text'),
    now,
  });
  assert.deepEqual(noTool.patch, {});
  assert.equal(noTool.intent, 'unknown');
  assert.doesNotMatch(noTool.issues.join(' '), /raw model prose/);

  const timeoutCalls = { value: 0 };
  const timeoutStarted = Date.now();
  const timedOut = await interpretHybridPassengerMessage('Nguyễn Văn An', {
    model: fakeModel('timeout', timeoutCalls),
    modelTimeoutMs: 20,
    now,
  });
  assert.ok(Date.now() - timeoutStarted < 90);
  assert.equal(timeoutCalls.value, 1);
  assert.match(timedOut.issues.join(' '), /phản hồi|thử lại/);
  assert.deepEqual(timedOut.patch, {});

  const routerEnv: NodeJS.ProcessEnv = {
    AI_API_PROVIDER: '9router',
    NINE_ROUTER_API_KEY: 'router-test-key',
    NINE_ROUTER_BASE_URL: 'http://router.test/v1/',
    NINE_ROUTER_MODEL: 'cx/gpt-5.6-luna',
    NINE_ROUTER_API: 'chat_completions',
    OPENAI_API_KEY: 'must-not-be-used',
  };
  assert.equal(
    readAIConnectionConfig({ env: routerEnv }).model,
    'cx/gpt-5.6-luna',
  );
  const previousFetch = globalThis.fetch;
  let rateLimitCalls = 0;
  try {
    await withEnvironment(routerEnv, async () => {
      globalThis.fetch = (async () => {
        rateLimitCalls += 1;
        return new Response(JSON.stringify({ error: { message: 'raw router secret', type: 'rate_limit_error' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const rateLimited = await interpretHybridPassengerMessage('Nguyễn Văn An', {
        model: 'fixture-model',
        now,
      });
      assert.equal(rateLimitCalls, 1, 'provider retries must remain disabled');
      assert.deepEqual(rateLimited.patch, {});
      assert.doesNotMatch(rateLimited.issues.join(' '), /raw router secret|router-test-key|must-not-be-used/);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  console.log('Hybrid passenger agent contracts passed: bounded SDK proposal, evidence validation, browse lookup, safe failures, and provider isolation.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
