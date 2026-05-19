import fs from 'node:fs/promises';
import path from 'node:path';

export type AgentSettings = {
  agentEnabled: boolean;
  autoSearchFlights: boolean;
  autoHoldBooking: boolean;
  requireConfirmationBeforeHold: boolean;
  debugMode: boolean;
};

const SETTINGS_PATH = path.resolve(
  process.cwd(),
  'src/config/agent-settings.json',
);

const DEFAULT_SETTINGS: AgentSettings = {
  agentEnabled: true,
  autoSearchFlights: true,
  autoHoldBooking: false,
  requireConfirmationBeforeHold: true,
  debugMode: true,
};

/**
 * Reads the local JSON settings for the internal automation agent.
 *
 * This store owns settings persistence only. Telegram commands may call it, but
 * settings business rules should not be duplicated in transport code.
 */
export async function readLocalAgentSettings(): Promise<AgentSettings> {
  try {
    const rawSettings = await fs.readFile(SETTINGS_PATH, 'utf8');
    return {
      ...DEFAULT_SETTINGS,
      ...JSON.parse(rawSettings),
    };
  } catch {
    await writeLocalAgentSettings(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Writes the full local settings object to disk.
 *
 * This helper centralizes JSON formatting so command handlers do not touch the
 * file system directly.
 */
export async function writeLocalAgentSettings(settings: AgentSettings) {
  await fs.mkdir(path.dirname(SETTINGS_PATH), {
    recursive: true,
  });
  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Applies a partial settings update and returns the saved result.
 *
 * Telegram settings commands should use this helper for simple toggle changes.
 */
export async function updateLocalAgentSettings(
  patch: Partial<AgentSettings>,
) {
  const settings = await readLocalAgentSettings();
  const nextSettings = {
    ...settings,
    ...patch,
  };

  await writeLocalAgentSettings(nextSettings);

  return nextSettings;
}
