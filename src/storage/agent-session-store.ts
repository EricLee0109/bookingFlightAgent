import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ShadowAgentSession = {
  caseId?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  updatedAt: string;
  // SDK state is opaque continuation data, not an application audit log.
  pausedState?: string;
};

/** Keeps per-chat shadow conversations in a separate private local state directory. */
export class AgentSessionStore {
  constructor(private readonly directory = path.resolve('data/agent-sessions')) {}

  /** Hashes the transport identity so it cannot become a user-controlled path. */
  private filePath(chatId: number) {
    return path.join(this.directory, `${createHash('sha256').update(String(chatId)).digest('hex')}.json`);
  }

  /** Reads only one chat, surfacing corrupt state instead of silently replacing it. */
  async read(chatId: number): Promise<ShadowAgentSession | null> {
    try { return JSON.parse(await fs.readFile(this.filePath(chatId), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Atomically publishes a completed or paused SDK decision for later inspection. */
  async write(chatId: number, session: ShadowAgentSession) {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.filePath(chatId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(session));
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
