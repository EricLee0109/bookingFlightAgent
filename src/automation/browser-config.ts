import { existsSync } from 'node:fs';
import { arch, release } from 'node:os';
import {
  chromium,
  type Browser,
  type LaunchOptions,
  type Page,
} from 'playwright';

export const ONE_BOOKING_VIEWPORT = {
  width: 1440,
  height: 900,
};

export type PlaywrightSettingSource =
  | 'override'
  | 'environment'
  | 'default'
  | 'invalid-environment-default';

export type PlaywrightBooleanSetting = {
  value: boolean;
  source: PlaywrightSettingSource;
  configuredValue: string;
  warning?: string;
};

export type PlaywrightBrowserLaunch = {
  browser: Browser;
  launchId: string;
};

export type PlaywrightPageDiagnosticOptions = {
  launchId: string;
  purpose: string;
};

const PLAYWRIGHT_CHANNEL = 'chromium';
const DIAGNOSTIC_TEXT_LIMIT = 500;
let launchSequence = 0;

/**
 * Resolves headless mode without silently treating a typo as a valid value.
 * Headless remains the safe default for Linux, WSL, VMware, VPS and cloud.
 */
export function resolvePlaywrightHeadlessMode(
  headlessOverride?: boolean,
  configuredValue = process.env.PLAYWRIGHT_HEADLESS,
): PlaywrightBooleanSetting {
  if (headlessOverride !== undefined) {
    return {
      value: headlessOverride,
      source: 'override',
      configuredValue: String(headlessOverride),
    };
  }

  return resolveBooleanEnvironmentSetting(
    'PLAYWRIGHT_HEADLESS',
    configuredValue,
    true,
  );
}

/** Enables additional page/network diagnostics while keeping normal logs concise. */
export function resolvePlaywrightDiagnosticsMode(
  configuredValue = process.env.PLAYWRIGHT_DIAGNOSTICS,
): PlaywrightBooleanSetting {
  return resolveBooleanEnvironmentSetting(
    'PLAYWRIGHT_DIAGNOSTICS',
    configuredValue,
    false,
  );
}

/** Builds the shared Chromium launch options for automation and tests. */
export function getPlaywrightLaunchOptions(
  headlessOverride?: boolean,
): LaunchOptions {
  return {
    headless: resolvePlaywrightHeadlessMode(headlessOverride).value,
    channel: PLAYWRIGHT_CHANNEL,
  };
}

/**
 * Launches Chromium with a traceable ID and safe runtime diagnostics.
 * Credentials, cookies, headers and storage-state contents are never logged.
 */
export async function launchConfiguredChromium(
  options: {
    purpose: string;
    headlessOverride?: boolean;
  },
): Promise<PlaywrightBrowserLaunch> {
  const headless = resolvePlaywrightHeadlessMode(options.headlessOverride);
  const diagnostics = resolvePlaywrightDiagnosticsMode();
  const launchOptions = getPlaywrightLaunchOptions(options.headlessOverride);
  const launchId = createPlaywrightLaunchId();
  const startedAt = Date.now();
  const executablePath = chromium.executablePath();
  const isWsl = isWindowsSubsystemForLinux();

  for (const warning of [headless.warning, diagnostics.warning]) {
    if (warning) {
      logPlaywrightDiagnostic('warn', 'Configuration warning', {
        launchId,
        purpose: options.purpose,
        warning,
      });
    }
  }

  if (!headless.value && process.platform === 'linux' && !process.env.DISPLAY) {
    logPlaywrightDiagnostic('warn', 'Headed Linux launch may fail', {
      launchId,
      purpose: options.purpose,
      reason: 'PLAYWRIGHT_HEADLESS=false but DISPLAY is not set.',
      action: 'Use PLAYWRIGHT_HEADLESS=true or run inside a graphical session.',
    });
  }

  logPlaywrightDiagnostic('log', 'Launch starting', {
    launchId,
    purpose: options.purpose,
    pid: process.pid,
    platform: process.platform,
    architecture: arch(),
    osRelease: release(),
    nodeVersion: process.version,
    cwd: process.cwd(),
    isWsl,
    wslDistribution: process.env.WSL_DISTRO_NAME ?? 'not-set',
    display: process.env.DISPLAY ? 'set' : 'not-set',
    headless: headless.value,
    headlessSource: headless.source,
    headlessConfiguredValue: headless.configuredValue,
    channel: PLAYWRIGHT_CHANNEL,
    executablePath,
    executableFound: existsSync(executablePath),
    diagnostics: diagnostics.value,
    playwrightDebug: process.env.DEBUG?.includes('pw:') ?? false,
  });

  try {
    const browser = await chromium.launch(launchOptions);

    logPlaywrightDiagnostic('log', 'Launch succeeded', {
      launchId,
      purpose: options.purpose,
      durationMs: Date.now() - startedAt,
      browserVersion: browser.version(),
    });

    browser.on('disconnected', () => {
      logPlaywrightDiagnostic('log', 'Browser disconnected', {
        launchId,
        purpose: options.purpose,
        lifetimeMs: Date.now() - startedAt,
      });
    });

    return {
      browser,
      launchId,
    };
  } catch (error) {
    logPlaywrightDiagnostic('error', 'Launch failed', {
      launchId,
      purpose: options.purpose,
      durationMs: Date.now() - startedAt,
      error: toPlaywrightDiagnosticError(error, diagnostics.value),
      action: buildPlaywrightLaunchFailureAction({
        executableFound: existsSync(executablePath),
        headless: headless.value,
      }),
    });
    throw error;
  }
}

/**
 * Adds opt-in page diagnostics for automation failures without logging request
 * headers, bodies, cookies, credentials or URL query parameters.
 */
export function attachPlaywrightPageDiagnostics(
  page: Page,
  options: PlaywrightPageDiagnosticOptions,
) {
  const diagnostics = resolvePlaywrightDiagnosticsMode();

  if (!diagnostics.value) {
    return;
  }

  logPlaywrightDiagnostic('log', 'Page diagnostics enabled', {
    ...options,
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      logPlaywrightDiagnostic('log', 'Main frame navigated', {
        ...options,
        url: sanitizePlaywrightDiagnosticUrl(frame.url()),
      });
    }
  });

  page.on('console', (message) => {
    if (!['warning', 'error'].includes(message.type())) {
      return;
    }

    const location = message.location();
    logPlaywrightDiagnostic('warn', 'Browser console message', {
      ...options,
      type: message.type(),
      textLength: message.text().length,
      url: sanitizePlaywrightDiagnosticUrl(location.url),
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
    });
  });

  page.on('pageerror', (error) => {
    logPlaywrightDiagnostic('error', 'Unhandled page error', {
      ...options,
      url: sanitizePlaywrightDiagnosticUrl(page.url()),
      error: toPlaywrightDiagnosticError(error, true),
    });
  });

  page.on('crash', () => {
    logPlaywrightDiagnostic('error', 'Page crashed', {
      ...options,
      url: sanitizePlaywrightDiagnosticUrl(page.url()),
    });
  });

  page.on('requestfailed', (request) => {
    if (!isImportantPlaywrightResource(request.resourceType())) {
      return;
    }

    logPlaywrightDiagnostic('warn', 'Request failed', {
      ...options,
      method: request.method(),
      resourceType: request.resourceType(),
      url: sanitizePlaywrightDiagnosticUrl(request.url()),
      failure: sanitizePlaywrightDiagnosticText(
        request.failure()?.errorText ?? 'unknown',
      ),
    });
  });

  page.on('response', (response) => {
    const request = response.request();

    if (
      response.status() < 500 ||
      !isImportantPlaywrightResource(request.resourceType())
    ) {
      return;
    }

    logPlaywrightDiagnostic('warn', 'Server error response', {
      ...options,
      status: response.status(),
      statusText: response.statusText(),
      method: request.method(),
      resourceType: request.resourceType(),
      url: sanitizePlaywrightDiagnosticUrl(response.url()),
    });
  });

  page.on('close', () => {
    logPlaywrightDiagnostic('log', 'Page closed', {
      ...options,
    });
  });
}

export function sanitizePlaywrightDiagnosticUrl(value: string) {
  if (!value || value === 'about:blank') {
    return value || 'unknown';
  }

  try {
    const url = new URL(value);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return `${url.protocol}[REDACTED]`;
    }

    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return sanitizePlaywrightDiagnosticText(value);
  }
}

export function sanitizePlaywrightDiagnosticText(value: string) {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:access_?token|refresh_?token|password|authorization|cookie|secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .slice(0, DIAGNOSTIC_TEXT_LIMIT);
}

export function toPlaywrightDiagnosticError(
  error: unknown,
  includeStack = false,
) {
  if (!(error instanceof Error)) {
    return {
      name: 'UnknownError',
      message: sanitizePlaywrightDiagnosticText(String(error)),
    };
  }

  return {
    name: error.name,
    message: sanitizePlaywrightDiagnosticText(error.message),
    ...(includeStack && error.stack
      ? {
          stack: sanitizePlaywrightDiagnosticText(error.stack),
        }
      : {}),
  };
}

function resolveBooleanEnvironmentSetting(
  name: string,
  configuredValue: string | undefined,
  defaultValue: boolean,
): PlaywrightBooleanSetting {
  if (configuredValue === undefined || configuredValue.trim() === '') {
    return {
      value: defaultValue,
      source: 'default',
      configuredValue: 'not-set',
    };
  }

  const normalizedValue = configuredValue.trim().toLowerCase();

  if (normalizedValue === 'true' || normalizedValue === 'false') {
    return {
      value: normalizedValue === 'true',
      source: 'environment',
      configuredValue: normalizedValue,
    };
  }

  return {
    value: defaultValue,
    source: 'invalid-environment-default',
    configuredValue: configuredValue.trim(),
    warning: `${name} must be "true" or "false". Using safe default ${defaultValue}.`,
  };
}

function createPlaywrightLaunchId() {
  launchSequence += 1;
  return `pw-${process.pid}-${Date.now()}-${launchSequence}`;
}

function isWindowsSubsystemForLinux() {
  return (
    Boolean(process.env.WSL_DISTRO_NAME) ||
    release().toLowerCase().includes('microsoft')
  );
}

function isImportantPlaywrightResource(resourceType: string) {
  return ['document', 'xhr', 'fetch'].includes(resourceType);
}

function buildPlaywrightLaunchFailureAction(options: {
  executableFound: boolean;
  headless: boolean;
}) {
  if (!options.executableFound) {
    return 'Install Chromium with: pnpm exec playwright install chromium';
  }

  if (!options.headless && process.platform === 'linux' && !process.env.DISPLAY) {
    return 'Set PLAYWRIGHT_HEADLESS=true, or configure DISPLAY for headed Linux.';
  }

  return 'Set PLAYWRIGHT_DIAGNOSTICS=true and DEBUG=pw:browser for deeper logs.';
}

export function logPlaywrightDiagnostic(
  level: 'log' | 'warn' | 'error',
  event: string,
  details: Record<string, unknown>,
) {
  console[level](`[Playwright] ${event}:`, {
    timestamp: new Date().toISOString(),
    ...details,
  });
}
