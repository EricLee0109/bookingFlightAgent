import { runShadowBookingAgent } from '../agent/booking-agent';
import { readAIConnectionConfig } from '../agent/ai-provider';
import { readAgentOrchestrationMode } from '../agent/booking-agent-policy';
import { AgentSessionStore } from '../storage/agent-session-store';
import { readLocalFlightCase } from '../storage/local-case-store';
import { appendLocalLog } from '../storage/local-log-store';
import { getLatestFlightSearchCase } from './telegram-flight-selection-context';
import { getTelegramPassengerContext } from './telegram-passenger-context';

const activeChats = new Set<number>();

/** Observes authorized messages without delaying, altering or replying to legacy work. */
export async function observeTelegramAgentDecision(chatId: number, text: string) {
  if (readAgentOrchestrationMode() !== 'shadow' || activeChats.has(chatId)) return;
  activeChats.add(chatId);
  const startedAt = Date.now();
  try {
    const store = new AgentSessionStore();
    const session = await store.read(chatId);
    const caseId = getTelegramPassengerContext(chatId)?.activeCaseId
      ?? getLatestFlightSearchCase(chatId)?.latestSearchCaseId ?? session?.caseId;
    const loaded = caseId ? await readLocalFlightCase(caseId) : null;
    const flightCase = loaded?.telegramChatId === chatId ? loaded : null;
    const { result, input } = await runShadowBookingAgent(text, flightCase, {
      history: session?.caseId === flightCase?.caseId ? session?.history : [],
    });
    const history = session?.caseId === flightCase?.caseId ? session?.history ?? [] : [];
    const proposedQuestion = result.interruptions.find((item) => item.rawItem.type === 'function_call'
      && item.rawItem.name === 'ask_operator_for_clarification');
    const question = proposedQuestion?.rawItem.type === 'function_call'
      ? JSON.parse(proposedQuestion.rawItem.arguments).question : undefined;
    await store.write(chatId, {
      caseId: flightCase?.caseId,
      // Shadow questions were never shown to the operator, so do not add them as assistant replies.
      history: [...history, { role: 'user' as const, content: input }].slice(-8),
      pausedState: result.interruptions.length ? result.state.toString() : undefined,
      updatedAt: new Date().toISOString(),
    });
    const aiConfig = readAIConnectionConfig({ defaultModel: 'gpt-5.4-mini' });
    await appendLocalLog({ level: 'info', event: 'booking_agent_shadow_decision', caseId: flightCase?.caseId,
      message: 'Recorded SDK proposal; no tools executed.', meta: {
        provider: aiConfig.provider,
        model: aiConfig.model,
        latencyMs: Date.now() - startedAt,
        proposedTools: result.interruptions.map((item) => item.rawItem.type === 'function_call' ? item.rawItem.name : item.rawItem.type),
        clarificationProposed: typeof question === 'string',
        usage: result.state.usage,
      } });
  } catch {
    await appendLocalLog({ level: 'warn', event: 'booking_agent_shadow_failed',
      message: 'Shadow decision failed; legacy processing continues.', meta: { latencyMs: Date.now() - startedAt } }).catch(() => undefined);
  } finally { activeChats.delete(chatId); }
}
