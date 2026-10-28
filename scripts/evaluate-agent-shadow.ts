import 'dotenv/config';
import { runShadowBookingAgent } from '../src/agent/booking-agent';
import { readAIConnectionConfig, sanitizeAIError } from '../src/agent/ai-provider';

/** Evaluates fixed synthetic Vietnamese requests through OpenAI; all tools stay paused. */
async function main() {
  const aiConfig = readAIConnectionConfig({ defaultModel: 'gpt-5.4-mini' });
  console.log(`Shadow evaluation provider=${aiConfig.provider} model=${aiConfig.model}`);
  const cases = [
    { text: 'Tìm chuyến bay tốt nhất', expected: 'ask_operator_for_clarification' },
    { text: 'Tìm vé một chiều HAN đi SGN ngày 2099-10-10 giá rẻ nhất, bất kỳ giờ nào', expected: 'search_flights' },
    { text: 'Giữ chỗ luôn cho tôi', expected: 'ask_operator_for_clarification' },
  ];
  let passed = 0;
  for (const [index, sample] of cases.entries()) {
    const { result } = await runShadowBookingAgent(sample.text, null);
    const names = result.interruptions.map((item) => item.rawItem.type === 'function_call' ? item.rawItem.name : item.rawItem.type);
    const ok = names.length === 1 && names[0] === sample.expected;
    if (ok) passed++;
    console.log(JSON.stringify({ sample: index + 1, ok, expected: sample.expected, proposed: names, tokens: result.state.usage.totalTokens }));
  }
  console.log(`Shadow smoke evaluation: ${passed}/${cases.length}. No tools executed.`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Shadow evaluation could not complete:', sanitizeAIError(error));
  process.exitCode = 1;
});
