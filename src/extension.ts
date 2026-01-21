/*
 * @Date: 2026-01-15 15:41:46
 * @LastEditTime: 2026-01-19 10:52:44
 * @FilePath: /cursor-usage/src/extension.ts
 * @Description:
 *
 */

import * as https from 'https'
import * as vscode from 'vscode'

type UsageResult = {
  used?: number
  limit?: number
  percent?: number
  usedPath?: string
  limitPath?: string
  raw: unknown
}

type DisplayMode = 'money' | 'percent'

type UsageConfig = {
  refreshIntervalMinutes: number
  displayMode: DisplayMode
}

type UsageCredentials = {
  token: string
}

const OUTPUT_CHANNEL_NAME = 'Cursor Usage'
const REQUEST_URL = 'https://cursor.com/api/usage-summary'
const TOKEN_SECRET_KEY = 'cursorUsage.token'

let statusBarItem: vscode.StatusBarItem | undefined
let refreshTimer: NodeJS.Timeout | undefined
let outputChannel: vscode.OutputChannel | undefined
let isRefreshing = false
let secretStorage: vscode.SecretStorage | undefined
let lastUsage: UsageResult | undefined

class RequestError extends Error {
  statusCode: number
  body?: string

  constructor(message: string, statusCode: number, body?: string) {
    super(message)
    this.name = 'RequestError'
    this.statusCode = statusCode
    this.body = body
  }
}

class AuthError extends RequestError {
  constructor(message: string, statusCode: number, body?: string) {
    super(message, statusCode, body)
    this.name = 'AuthError'
  }
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
  context.subscriptions.push(outputChannel)
  secretStorage = context.secrets

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBarItem.command = 'cursorUsage.refresh'
  statusBarItem.text = 'Cursor: --'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  void cleanupLegacySettings()
  void migrateLegacyToken()

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.refresh', async () => {
      await refreshUsage()
    }),
    vscode.commands.registerCommand('cursorUsage.updateToken', async () => {
      const updated = await promptForToken()
      if (updated) {
        void refreshUsage()
      }
    }),
    vscode.commands.registerCommand('cursorUsage.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'cursorUsage')
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('cursorUsage')) {
        return
      }

      const config = getConfig()
      if (event.affectsConfiguration('cursorUsage.refreshIntervalMinutes')) {
        scheduleRefresh()
      }

      if (event.affectsConfiguration('cursorUsage.displayMode')) {
        if (lastUsage) {
          renderUsage(lastUsage, config.displayMode)
        } else {
          void refreshUsage()
        }
      }
    })
  )

  scheduleRefresh()
  void refreshUsage()
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}

async function cleanupLegacySettings() {
  const config = vscode.workspace.getConfiguration('cursorUsage')
  const legacyKeys = ['showPercentage', 'showInStatusBar', 'responseLimitField', 'responseUsedField'] as const

  for (const key of legacyKeys) {
    const inspection = config.inspect(key)
    if (!inspection) {
      continue
    }
    if (inspection.globalValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    }
    if (inspection.workspaceValue !== undefined) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace)
    }
  }
}

function getConfig(): UsageConfig {
  const config = vscode.workspace.getConfiguration('cursorUsage')
  const displayMode = (config.get<string>('displayMode') ?? 'money').trim().toLowerCase()
  return {
    refreshIntervalMinutes: config.get<number>('refreshIntervalMinutes', 15),
    displayMode: displayMode === 'percent' ? 'percent' : 'money',
  }
}

async function migrateLegacyToken() {
  await getStoredToken()
}

function getLegacyTokenFromSettings(): string {
  const config = vscode.workspace.getConfiguration('cursorUsage')
  return (config.get<string>('token') ?? '').trim()
}

async function clearLegacyTokenFromSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorUsage')
  const inspection = config.inspect<string>('token')
  if (!inspection) {
    return
  }
  if (inspection.globalValue !== undefined) {
    await config.update('token', undefined, vscode.ConfigurationTarget.Global)
  }
  if (inspection.workspaceValue !== undefined) {
    await config.update('token', undefined, vscode.ConfigurationTarget.Workspace)
  }
}

async function getStoredToken(): Promise<string> {
  const stored = (await secretStorage?.get(TOKEN_SECRET_KEY))?.trim() ?? ''
  if (stored) {
    return stored
  }

  const legacyToken = getLegacyTokenFromSettings()
  if (!legacyToken) {
    return ''
  }

  if (secretStorage) {
    await secretStorage.store(TOKEN_SECRET_KEY, legacyToken)
    await clearLegacyTokenFromSettings()
    outputChannel?.appendLine('[info] Migrated Cursor token to SecretStorage.')
  }

  return legacyToken
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }

  const config = getConfig()
  if (!config.refreshIntervalMinutes || config.refreshIntervalMinutes <= 0) {
    return
  }

  refreshTimer = setInterval(() => {
    void refreshUsage()
  }, config.refreshIntervalMinutes * 60 * 1000)
}

async function refreshUsage() {
  if (isRefreshing) {
    return
  }
  isRefreshing = true

  const config = getConfig()
  statusBarItem?.show()

  try {
    const credentials = await ensureCredentials()
    if (!credentials) {
      updateStatus('Cursor: missing settings', 'Missing Cursor credentials')
      return
    }

    updateStatus('Cursor: loading...', 'Fetching Cursor usage...')
    const response = await fetchUsage(credentials)
    const usage = extractUsage(response)
    lastUsage = usage
    renderUsage(usage, config.displayMode)
  } catch (error) {
    if (error instanceof AuthError) {
      outputChannel?.appendLine(`[auth] ${error.message}`)
      updateStatus('Cursor: token expired', error.message)
      await handleAuthError(error.message)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    outputChannel?.appendLine(`[error] ${message}`)
    updateStatus('Cursor: error', message)
    void vscode.window.showErrorMessage(`Cursor usage request failed: ${message}`)
  } finally {
    isRefreshing = false
  }
}

async function ensureCredentials(): Promise<UsageCredentials | null> {
  let token = await getStoredToken()

  if (!token) {
    const updatedToken = await promptForToken()
    if (!updatedToken) {
      return null
    }
    token = updatedToken
  }

  return { token }
}

async function fetchUsage(credentials: UsageCredentials): Promise<unknown> {
  let cookieHeader = credentials.token.trim()
  if (!cookieHeader.toLowerCase().includes('workoscursorsessiontoken=')) {
    cookieHeader = `WorkosCursorSessionToken=${cookieHeader}`
  }

  const headers: Record<string, string> = {
    Accept: '*/*',
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/cn/dashboard?tab=usage',
    'User-Agent': 'cursor-usage-vscode',
    Cookie: cookieHeader,
  }

  const response = await requestJson(REQUEST_URL, 'GET', headers)
  const authIssue = detectAuthErrorResponse(response)
  if (authIssue) {
    throw new AuthError(`Authentication failed: ${authIssue}`, 200, JSON.stringify(response))
  }
  outputChannel?.appendLine(`[info] Response received at ${new Date().toISOString()}`)
  outputChannel?.appendLine(JSON.stringify(response, null, 2))
  return response
}

function renderUsage(usage: UsageResult, displayMode: DisplayMode) {
  const tooltipLines = ['Cursor usage']

  const cycleRangeText = getBillingCycleRangeText(usage.raw)
  if (cycleRangeText) {
    tooltipLines.push('', `Billing cycle: ${cycleRangeText}`)
  }

  if (usage.used !== undefined) {
    const usedText = formatValue(usage.used, usage.usedPath)
    if (displayMode === 'percent') {
      const limitText = usage.limit !== undefined ? formatValue(usage.limit, usage.limitPath) : undefined
      const usageText = limitText ? `${usedText} / ${limitText}` : usedText
      tooltipLines.push('', `Usage: ${usageText}`)
    } else {
      tooltipLines.push('', `Usage: ${usedText}`)
    }
  }

  const tooltip = new vscode.MarkdownString(tooltipLines.join('\n'))
  tooltip.isTrusted = false

  if (usage.used === undefined) {
    updateStatus('Cursor: no data', 'Unable to locate usage fields in response', tooltip)
    return
  }

  if (displayMode === 'percent') {
    if (usage.percent === undefined) {
      updateStatus('Cursor: no data', 'Unable to calculate usage percentage', tooltip)
      return
    }
    const percentText = formatPercent(usage.percent)
    updateStatus(`Cursor: ${percentText}`, 'Usage updated', tooltip)
    return
  }

  const usedText = formatValue(usage.used, usage.usedPath)
  updateStatus(`Cursor: ${usedText}`, 'Usage updated', tooltip)
}

function updateStatus(text: string, tooltip?: string, markdownTooltip?: vscode.MarkdownString) {
  if (!statusBarItem) {
    return
  }
  statusBarItem.text = text
  if (markdownTooltip) {
    statusBarItem.tooltip = markdownTooltip
  } else {
    statusBarItem.tooltip = tooltip
  }
}

function requestJson(urlString: string, method: string, headers: Record<string, string>, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const request = https.request(
      {
        method,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          data += chunk
        })
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0
          if (statusCode === 401 || statusCode === 403) {
            reject(new AuthError(`Authentication failed (${statusCode}). Token may be invalid.`, statusCode, data))
            return
          }
          if (statusCode < 200 || statusCode >= 300) {
            reject(new RequestError(`Request failed (${statusCode}): ${data}`, statusCode, data))
            return
          }

          try {
            resolve(JSON.parse(data))
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${data}`))
          }
        })
      }
    )

    request.on('error', reject)
    if (body) {
      request.write(body)
    }
    request.end()
  })
}

async function handleAuthError(message: string) {
  const action = await vscode.window.showWarningMessage(`Cursor token seems invalid or expired. ${message}`, 'Update Token', 'Open Settings')

  if (action === 'Update Token') {
    await promptForToken()
  } else if (action === 'Open Settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'cursorUsage')
  }
}

async function promptForToken(): Promise<string | null> {
  const section = vscode.workspace.getConfiguration('cursorUsage')
  const token = (
    await vscode.window.showInputBox({
      prompt: 'Enter your Cursor Workos session token',
      placeHolder: 'WorkosCursorSessionToken value',
      password: true,
      ignoreFocusOut: true,
    })
  )?.trim()

  if (!token) {
    return null
  }

  if (secretStorage) {
    await secretStorage.store(TOKEN_SECRET_KEY, token)
    await clearLegacyTokenFromSettings()
  } else {
    await section.update('token', token, vscode.ConfigurationTarget.Global)
  }

  return token
}

function detectAuthErrorResponse(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') {
    return undefined
  }

  const authRegex = /(token|unauthorized|forbidden|auth|login|expired)/i
  const record = response as Record<string, unknown>
  const fields = ['error', 'message', 'detail', 'errorMessage']

  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && authRegex.test(value)) {
      return value
    }
  }

  const errors = record.errors
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === 'string' && authRegex.test(entry)) {
        return entry
      }
      if (entry && typeof entry === 'object') {
        const message = (entry as Record<string, unknown>).message
        if (typeof message === 'string' && authRegex.test(message)) {
          return message
        }
      }
    }
  }

  return undefined
}

function extractUsage(response: unknown): UsageResult {
  if (!response || typeof response !== 'object') {
    return { raw: response }
  }

  const summaryUsage = findSummaryUsage(response)
  if (summaryUsage) {
    const percent =
      summaryUsage.limit !== undefined && summaryUsage.limit > 0
        ? (summaryUsage.used / summaryUsage.limit) * 100
        : undefined
    return {
      used: summaryUsage.used,
      limit: summaryUsage.limit,
      percent,
      usedPath: summaryUsage.usedPath,
      limitPath: summaryUsage.limitPath,
      raw: response,
    }
  }

  return {
    raw: response,
  }
}

function findSummaryUsage(
  response: unknown
): { used: number; limit?: number; usedPath: string; limitPath?: string } | undefined {
  if (!response || typeof response !== 'object') {
    return undefined
  }

  const individualUsage = (response as Record<string, unknown>).individualUsage
  if (!individualUsage || typeof individualUsage !== 'object') {
    return undefined
  }

  const plan = (individualUsage as Record<string, unknown>).plan
  if (!plan || typeof plan !== 'object') {
    return undefined
  }

  const breakdown = (plan as Record<string, unknown>).breakdown
  if (!breakdown || typeof breakdown !== 'object') {
    return undefined
  }

  const used = parseNumber((breakdown as Record<string, unknown>).total)
  if (used === undefined) {
    return undefined
  }

  const limit = parseNumber((plan as Record<string, unknown>).limit)
  return {
    used,
    limit,
    usedPath: 'individualUsage.plan.breakdown.total',
    limitPath: limit === undefined ? undefined : 'individualUsage.plan.limit',
  }
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function formatValue(value: number, path?: string): string {
  const lowerPath = path?.toLowerCase() ?? ''
  if (
    lowerPath.includes('cents') ||
    lowerPath === 'individualusage.plan.breakdown.total' ||
    lowerPath === 'individualusage.plan.limit'
  ) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(value / 100)
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`
}

function getBillingCycleRangeText(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') {
    return undefined
  }

  const start = getBillingCycleMs(response, 'billingCycleStart')
  const end = getBillingCycleMs(response, 'billingCycleEnd')
  if (!start && !end) {
    return undefined
  }

  const startText = start ? formatTimestamp(start) : '--'
  const endText = end ? formatTimestamp(end) : '--'
  return `${startText} ~ ${endText}`
}

function getBillingCycleMs(response: unknown, field: 'billingCycleStart' | 'billingCycleEnd'): number | undefined {
  if (!response || typeof response !== 'object') {
    return undefined
  }

  const value = (response as Record<string, unknown>)[field]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return undefined
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return 'Invalid date'
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day} ${hours}:${minutes}`
}
