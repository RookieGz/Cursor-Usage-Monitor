/*
 * @Date: 2026-01-15 15:41:46
 * @LastEditTime: 2026-01-15 16:33:36
 * @FilePath: /cursor-usage/src/extension.ts
 * @Description:
 *
 */

import * as https from 'https';
import * as vscode from 'vscode';

type UsageResult = {
  used?: number;
  limit?: number;
  usedPath?: string;
  limitPath?: string;
  raw: unknown;
};

type UsageConfig = {
  token: string;
  email: string;
  teamId: string;
  refreshIntervalMinutes: number;
  showPercentage: boolean;
  showInStatusBar: boolean;
  responseUsedField: string;
  responseLimitField: string;
};

const DEFAULT_TEAM_ID = '14089613';
const OUTPUT_CHANNEL_NAME = 'Cursor Usage';
const REQUEST_URL = 'https://cursor.com/api/dashboard/get-team-spend';

let statusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let isRefreshing = false;

class RequestError extends Error {
  statusCode: number;
  body?: string;

  constructor(message: string, statusCode: number, body?: string) {
    super(message);
    this.name = 'RequestError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

class AuthError extends RequestError {
  constructor(message: string, statusCode: number, body?: string) {
    super(message, statusCode, body);
    this.name = 'AuthError';
  }
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'cursorUsage.refresh';
  statusBarItem.text = 'Cursor: --';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.refresh', async () => {
      await refreshUsage();
    }),
    vscode.commands.registerCommand('cursorUsage.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'cursorUsage');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cursorUsage')) {
        scheduleRefresh();
      }
    })
  );

  scheduleRefresh();
  void refreshUsage();
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function getConfig(): UsageConfig {
  const config = vscode.workspace.getConfiguration('cursorUsage');
  return {
    token: (config.get<string>('token') ?? '').trim(),
    email: (config.get<string>('email') ?? '').trim(),
    teamId: (config.get<string>('teamId') ?? DEFAULT_TEAM_ID).trim(),
    refreshIntervalMinutes: config.get<number>('refreshIntervalMinutes', 15),
    showPercentage: config.get<boolean>('showPercentage', true),
    showInStatusBar: config.get<boolean>('showInStatusBar', true),
    responseUsedField: (config.get<string>('responseUsedField') ?? '').trim(),
    responseLimitField: (config.get<string>('responseLimitField') ?? '').trim()
  };
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  const config = getConfig();
  if (!config.refreshIntervalMinutes || config.refreshIntervalMinutes <= 0) {
    return;
  }

  refreshTimer = setInterval(() => {
    void refreshUsage();
  }, config.refreshIntervalMinutes * 60 * 1000);
}

async function refreshUsage() {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;

  const config = getConfig();
  if (!config.showInStatusBar) {
    statusBarItem?.hide();
  } else {
    statusBarItem?.show();
  }

  try {
    const credentials = await ensureCredentials(config);
    if (!credentials) {
      updateStatus('Cursor: missing settings', 'Missing Cursor credentials');
      return;
    }

    updateStatus('Cursor: loading...', 'Fetching Cursor usage...');
    const response = await fetchUsage(credentials);
    const usage = extractUsage(response, config);
    renderUsage(usage, config, credentials.email, credentials.teamId);
  } catch (error) {
    if (error instanceof AuthError) {
      outputChannel?.appendLine(`[auth] ${error.message}`);
      updateStatus('Cursor: token expired', error.message);
      await handleAuthError(error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`[error] ${message}`);
    updateStatus('Cursor: error', message);
    void vscode.window.showErrorMessage(`Cursor usage request failed: ${message}`);
  } finally {
    isRefreshing = false;
  }
}

async function ensureCredentials(config: UsageConfig): Promise<{ token: string; email: string; teamId: string } | null> {
  const section = vscode.workspace.getConfiguration('cursorUsage');
  let { token, email, teamId } = config;

  if (!token) {
    token = (await vscode.window.showInputBox({
      prompt: 'Enter your Cursor Workos session token',
      placeHolder: 'WorkosCursorSessionToken value',
      password: true,
      ignoreFocusOut: true
    }))?.trim() ?? '';
    if (!token) {
      return null;
    }
    await section.update('token', token, vscode.ConfigurationTarget.Global);
  }

  if (!email) {
    email = (await vscode.window.showInputBox({
      prompt: 'Enter your Cursor account email',
      placeHolder: 'name@example.com',
      ignoreFocusOut: true
    }))?.trim() ?? '';
    if (!email) {
      return null;
    }
    await section.update('email', email, vscode.ConfigurationTarget.Global);
  }

  if (!teamId) {
    teamId = (await vscode.window.showInputBox({
      prompt: 'Enter your Cursor team ID',
      placeHolder: DEFAULT_TEAM_ID,
      value: DEFAULT_TEAM_ID,
      ignoreFocusOut: true
    }))?.trim() ?? '';
    if (!teamId) {
      return null;
    }
    await section.update('teamId', teamId, vscode.ConfigurationTarget.Global);
  }

  return { token, email, teamId };
}

async function fetchUsage(credentials: { token: string; email: string; teamId: string }): Promise<unknown> {
  const teamIdNumber = Number.parseInt(credentials.teamId, 10);
  if (Number.isNaN(teamIdNumber)) {
    throw new Error(`Invalid teamId: ${credentials.teamId}`);
  }

  const body = JSON.stringify({ teamId: teamIdNumber });
  let cookieHeader = credentials.token.trim();
  if (!cookieHeader.toLowerCase().includes('workoscursorsessiontoken=')) {
    cookieHeader = `WorkosCursorSessionToken=${cookieHeader}`;
  }

  const headers: Record<string, string> = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/cn/dashboard?tab=usage',
    'User-Agent': 'cursor-usage-vscode',
    Cookie: cookieHeader
  };

  const response = await requestJson(REQUEST_URL, 'POST', headers, body);
  const authIssue = detectAuthErrorResponse(response);
  if (authIssue) {
    throw new AuthError(`Authentication failed: ${authIssue}`, 200, JSON.stringify(response));
  }
  outputChannel?.appendLine(`[info] Response received at ${new Date().toISOString()}`);
  outputChannel?.appendLine(JSON.stringify(response, null, 2));
  return response;
}

function renderUsage(usage: UsageResult, config: UsageConfig, email: string, teamId: string) {
  const tooltip = new vscode.MarkdownString(
    `Cursor usage\n\nEmail: ${email}\n\nTeam ID: ${teamId}`
  );
  tooltip.isTrusted = false;

  if (usage.used === undefined) {
    updateStatus('Cursor: no data', 'Unable to locate usage fields in response', tooltip);
    return;
  }

  const usedText = formatValue(usage.used, usage.usedPath);
  let text = `Cursor: ${usedText}`;

  if (usage.limit !== undefined) {
    const limitText = formatValue(usage.limit, usage.limitPath);
    text = `Cursor: ${usedText} / ${limitText}`;
    if (config.showPercentage && usage.limit > 0) {
      const percent = Math.round((usage.used / usage.limit) * 100);
      text = `${text} (${percent}%)`;
    }
  }

  updateStatus(text, 'Usage updated', tooltip);
}

function updateStatus(text: string, tooltip?: string, markdownTooltip?: vscode.MarkdownString) {
  if (!statusBarItem) {
    return;
  }
  statusBarItem.text = text;
  if (markdownTooltip) {
    statusBarItem.tooltip = markdownTooltip;
  } else {
    statusBarItem.tooltip = tooltip;
  }
}

function requestJson(
  urlString: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const request = https.request(
      {
        method,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode === 401 || statusCode === 403) {
            reject(new AuthError(`Authentication failed (${statusCode}). Token may be invalid.`, statusCode, data));
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            reject(new RequestError(`Request failed (${statusCode}): ${data}`, statusCode, data));
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${data}`));
          }
        });
      }
    );

    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function handleAuthError(message: string) {
  const action = await vscode.window.showWarningMessage(
    `Cursor token seems invalid or expired. ${message}`,
    'Update Token',
    'Open Settings'
  );

  if (action === 'Update Token') {
    const token = (await vscode.window.showInputBox({
      prompt: 'Enter your Cursor Workos session token',
      placeHolder: 'WorkosCursorSessionToken value',
      password: true,
      ignoreFocusOut: true
    }))?.trim();
    if (token) {
      const section = vscode.workspace.getConfiguration('cursorUsage');
      await section.update('token', token, vscode.ConfigurationTarget.Global);
    }
  } else if (action === 'Open Settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'cursorUsage');
  }
}

function detectAuthErrorResponse(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  const authRegex = /(token|unauthorized|forbidden|auth|login|expired)/i;
  const record = response as Record<string, unknown>;
  const fields = ['error', 'message', 'detail', 'errorMessage'];

  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && authRegex.test(value)) {
      return value;
    }
  }

  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === 'string' && authRegex.test(entry)) {
        return entry;
      }
      if (entry && typeof entry === 'object') {
        const message = (entry as Record<string, unknown>).message;
        if (typeof message === 'string' && authRegex.test(message)) {
          return message;
        }
      }
    }
  }

  return undefined;
}

function extractUsage(response: unknown, config: UsageConfig): UsageResult {
  if (!response || typeof response !== 'object') {
    return { raw: response };
  }

  const limitPath =
    config.responseLimitField ||
    guessUsagePath(response, [
      'spendLimitCents',
      'limit',
      'quota',
      'max',
      'usageLimit',
      'monthlyLimit'
    ]);
  const limit = limitPath ? getNumberByPath(response, limitPath) : undefined;

  if (!config.responseUsedField) {
    const memberUsage = findTeamMemberUsage(response, config.email);
    if (memberUsage) {
      return {
        used: memberUsage.used,
        limit,
        usedPath: memberUsage.usedPath,
        limitPath,
        raw: response
      };
    }
  }

  const usedPath = config.responseUsedField || guessUsagePath(response, [
    'spendCents',
    'spend',
    'usage',
    'used',
    'totalSpendCents',
    'totalSpend',
    'monthlySpendCents',
    'monthlySpend'
  ]);
  const used = usedPath ? getNumberByPath(response, usedPath) : undefined;

  return {
    used,
    limit,
    usedPath,
    limitPath,
    raw: response
  };
}

function findTeamMemberUsage(
  response: unknown,
  email: string
): { used: number; usedPath: string } | undefined {
  if (!email || typeof response !== 'object' || response === null) {
    return undefined;
  }

  const memberSpend = (response as Record<string, unknown>).teamMemberSpend;
  if (!Array.isArray(memberSpend)) {
    return undefined;
  }

  const targetEmail = email.trim().toLowerCase();
  for (let index = 0; index < memberSpend.length; index += 1) {
    const item = memberSpend[index];
    if (!item || typeof item !== 'object') {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const entryEmail = typeof entry.email === 'string' ? entry.email.trim().toLowerCase() : '';
    if (entryEmail !== targetEmail) {
      continue;
    }

    const includedSpend = entry.includedSpendCents;
    if (typeof includedSpend === 'number') {
      return { used: includedSpend, usedPath: `teamMemberSpend.${index}.includedSpendCents` };
    }
    if (typeof includedSpend === 'string') {
      const parsed = Number(includedSpend);
      if (!Number.isNaN(parsed)) {
        return { used: parsed, usedPath: `teamMemberSpend.${index}.includedSpendCents` };
      }
    }
  }

  return undefined;
}

function guessUsagePath(data: unknown, candidates: string[]): string | undefined {
  const targetKeys = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  const queue: Array<{ value: unknown; path: string }> = [{ value: data, path: '' }];

  while (queue.length) {
    const { value, path } = queue.shift()!;
    if (!value || typeof value !== 'object') {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        queue.push({ value: item, path: path ? `${path}.${index}` : `${index}` });
      });
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (targetKeys.has(key.toLowerCase()) && isNumeric(child)) {
        return nextPath;
      }

      if (child && typeof child === 'object') {
        queue.push({ value: child, path: nextPath });
      }
    }
  }

  return undefined;
}

function getNumberByPath(data: unknown, path: string): number | undefined {
  const value = getValueByPath(data, path);
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getValueByPath(data: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) {
        return undefined;
      }
      current = current[Number(part)];
      continue;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() !== '' && !Number.isNaN(Number(value));
  }
  return false;
}

function formatValue(value: number, path?: string): string {
  const lowerPath = path?.toLowerCase() ?? '';
  if (lowerPath.includes('cents')) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(value / 100);
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}
