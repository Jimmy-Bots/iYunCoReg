// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const ICLOUD_SETUP_URLS = [
  'https://setup.icloud.com.cn/setup/ws/1',
  'https://setup.icloud.com/setup/ws/1',
];
const ICLOUD_LOGIN_URLS = [
  'https://www.icloud.com.cn/',
  'https://www.icloud.com/',
];
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const PERSISTENT_ALIAS_STATE_KEYS = ['accounts', 'manualAliasUsage', 'preservedAliases'];

initializeSessionStorageAccess();
initializePersistentAliasState();

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  autoRunning: false,
  autoRunCurrentRun: 0,
  autoRunTotalRuns: 1,
  autoRunPausedPhase: null,
  language: 'zh-CN',
  oauthUrl: null,
  autoDeleteUsedIcloudAlias: false,
  emailSource: 'icloud',
  forceRefreshOAuthBeforeStep6: false,
  email: null,
  password: null,
  accounts: [], // Successfully completed accounts: { email, password, createdAt }
  manualAliasUsage: {},
  preservedAliases: {},
  lastEmailTimestamp: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: '',
  customPassword: '',
  icloudHostPreference: 'auto',
  preferredIcloudHost: '',
  mailProvider: '163', // 'qq', '163', 'gmail', or 'inbucket'
  mailPollMaxAttempts: 20,
  mailPollIntervalMs: 3000,
  mailResendRounds: 3,
  spamokWaitNewAttempts: 2,
  inbucketHost: '',
  inbucketMailbox: '',
  inbucketDomain: '',
  inbucketSubdomain: '',
  lastSignupVerificationCode: '',
};

async function getState() {
  const [sessionState, persistentState] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistentAliasState(),
  ]);
  return { ...DEFAULT_STATE, ...sessionState, ...persistentState };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
  const persistentUpdates = pickPersistentAliasUpdates(updates);
  if (Object.keys(persistentUpdates).length > 0) {
    await chrome.storage.local.set(persistentUpdates);
  }
}

async function getPersistentAliasState() {
  try {
    const state = await chrome.storage.local.get(PERSISTENT_ALIAS_STATE_KEYS);
    return {
      accounts: Array.isArray(state.accounts) ? state.accounts : DEFAULT_STATE.accounts,
      manualAliasUsage: state.manualAliasUsage && typeof state.manualAliasUsage === 'object'
        ? state.manualAliasUsage
        : DEFAULT_STATE.manualAliasUsage,
      preservedAliases: state.preservedAliases && typeof state.preservedAliases === 'object'
        ? state.preservedAliases
        : DEFAULT_STATE.preservedAliases,
    };
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to read persistent alias state:', err?.message || err);
    return {
      accounts: DEFAULT_STATE.accounts,
      manualAliasUsage: DEFAULT_STATE.manualAliasUsage,
      preservedAliases: DEFAULT_STATE.preservedAliases,
    };
  }
}

function pickPersistentAliasUpdates(updates = {}) {
  const picked = {};
  for (const key of PERSISTENT_ALIAS_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      picked[key] = updates[key];
    }
  }
  return picked;
}

async function initializePersistentAliasState() {
  try {
    const [localState, sessionState] = await Promise.all([
      chrome.storage.local.get(PERSISTENT_ALIAS_STATE_KEYS),
      chrome.storage.session.get(PERSISTENT_ALIAS_STATE_KEYS),
    ]);

    const migrated = {};

    for (const key of PERSISTENT_ALIAS_STATE_KEYS) {
      const localValue = localState[key];
      const sessionValue = sessionState[key];
      const localMissing = localValue === undefined
        || (Array.isArray(localValue) && localValue.length === 0)
        || (!Array.isArray(localValue) && typeof localValue === 'object' && localValue && Object.keys(localValue).length === 0);
      const sessionHasValue = sessionValue !== undefined
        && (!(Array.isArray(sessionValue)) || sessionValue.length > 0)
        && (!(typeof sessionValue === 'object' && sessionValue) || Array.isArray(sessionValue) || Object.keys(sessionValue).length > 0);

      if (localMissing && sessionHasValue) {
        migrated[key] = sessionValue;
      }
    }

    if (Object.keys(migrated).length > 0) {
      await chrome.storage.local.set(migrated);
      console.log(LOG_PREFIX, 'Migrated alias state from session to local:', Object.keys(migrated));
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to initialize persistent alias state:', err?.message || err);
  }
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

function broadcastIcloudAliasesChanged(payload = {}) {
  chrome.runtime.sendMessage({
    type: 'ICLOUD_ALIASES_CHANGED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function recordCompletedAccount() {
  const state = await getState();
  const email = String(state.email || '').trim();
  const password = String(state.password || '').trim();

  if (!email) return;

  const accounts = Array.isArray(state.accounts) ? [...state.accounts] : [];
  const existingIndex = accounts.findIndex(account => String(account?.email || '').trim() === email);
  const record = {
    email,
    password,
    createdAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = {
      ...accounts[existingIndex],
      ...record,
    };
  } else {
    accounts.push(record);
  }

  const manualAliasUsage = {
    ...getManualAliasUsageMap(state),
    [email]: true,
  };

  await setState({ accounts, manualAliasUsage });
  broadcastIcloudAliasesChanged({ reason: 'used-updated', email, used: true });
}

async function maybeAutoDeleteCompletedIcloudAlias() {
  const state = await getState();
  if (!state.autoDeleteUsedIcloudAlias) return;

  const email = String(state.email || '').trim();
  if (!email) return;
  if (isAliasPreserved(state, email)) {
    await addLog(`iCloud: Auto-delete skipped for preserved alias ${email}.`, 'info');
    return;
  }

  try {
    const aliases = await listIcloudAliases();
    const alias = aliases.find(item => String(item?.email || '').trim() === email);

    if (!alias) {
      await addLog(`iCloud: Auto-delete skipped. ${email} was not found in your Hide My Email alias list.`, 'warn');
      return;
    }

    if (!alias.anonymousId) {
      await addLog(`iCloud: Auto-delete skipped. ${email} is missing anonymousId; refresh aliases and retry manually.`, 'warn');
      return;
    }

    await deleteIcloudAlias(alias);
    await addLog(`iCloud: Auto-deleted used alias ${email} after successful completion.`, 'ok');
  } catch (err) {
    await addLog(`iCloud: Auto-delete failed for ${email}: ${getErrorMessage(err)}`, 'warn');
  }
}

async function setManualEmailState(email) {
  const trimmedEmail = String(email || '').trim();
  await setState({ email: trimmedEmail });
  broadcastDataUpdate({ email: trimmedEmail });
}

function getManualAliasUsageMap(state) {
  return state?.manualAliasUsage && typeof state.manualAliasUsage === 'object'
    ? { ...state.manualAliasUsage }
    : {};
}

function getPreservedAliasMap(state) {
  return state?.preservedAliases && typeof state.preservedAliases === 'object'
    ? { ...state.preservedAliases }
    : {};
}

function isAliasPreserved(state, email) {
  const normalizedEmail = String(email || '').trim();
  if (!normalizedEmail) return false;
  const preservedAliases = getPreservedAliasMap(state);
  return Boolean(preservedAliases[normalizedEmail]);
}

function getEffectiveUsedEmails(state) {
  const usedEmails = new Set((state.accounts || []).map(account => String(account?.email || '').trim()).filter(Boolean));
  const manualAliasUsage = getManualAliasUsageMap(state);

  for (const [email, used] of Object.entries(manualAliasUsage)) {
    const normalizedEmail = String(email || '').trim();
    if (!normalizedEmail) continue;
    if (used) usedEmails.add(normalizedEmail);
    else usedEmails.delete(normalizedEmail);
  }

  return usedEmails;
}

async function setIcloudAliasUsedState(payload = {}) {
  const email = String(payload.email || '').trim();
  if (!email) {
    throw new Error('No iCloud alias email was provided.');
  }

  const state = await getState();
  const manualAliasUsage = getManualAliasUsageMap(state);
  manualAliasUsage[email] = Boolean(payload.used);
  await setState({ manualAliasUsage });
  await addLog(`iCloud: Marked ${email} as ${payload.used ? 'used' : 'unused'}`, 'ok');
  broadcastIcloudAliasesChanged({ reason: 'used-updated', email, used: Boolean(payload.used) });
  return { email, used: Boolean(payload.used) };
}

async function setIcloudAliasPreservedState(payload = {}) {
  const email = String(payload.email || '').trim();
  if (!email) {
    throw new Error('No iCloud alias email was provided.');
  }

  const state = await getState();
  const preservedAliases = getPreservedAliasMap(state);
  preservedAliases[email] = Boolean(payload.preserved);
  await setState({ preservedAliases });
  await addLog(`iCloud: Marked ${email} as ${payload.preserved ? 'preserved' : 'not preserved'}`, 'ok');
  broadcastIcloudAliasesChanged({ reason: 'preserved-updated', email, preserved: Boolean(payload.preserved) });
  return { email, preserved: Boolean(payload.preserved) };
}

function getErrorMessage(error) {
  if (typeof error === 'string') return error;
  return String(error?.message || error || 'Unknown error');
}

function normalizeIcloudHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase();
  if (!host) return '';
  if (host === 'icloud.com' || host === 'www.icloud.com' || host === 'setup.icloud.com') return 'icloud.com';
  if (host === 'icloud.com.cn' || host === 'www.icloud.com.cn' || host === 'setup.icloud.com.cn') return 'icloud.com.cn';
  return '';
}

function getConfiguredIcloudHostPreference(state) {
  const preference = String(state?.icloudHostPreference || '').trim().toLowerCase();
  if (preference === 'auto') return '';
  return normalizeIcloudHost(preference);
}

function getIcloudLoginUrlForHost(host) {
  const normalizedHost = normalizeIcloudHost(host);
  if (normalizedHost === 'icloud.com') return 'https://www.icloud.com/';
  if (normalizedHost === 'icloud.com.cn') return 'https://www.icloud.com.cn/';
  return '';
}

function getIcloudSetupUrlForHost(host) {
  const normalizedHost = normalizeIcloudHost(host);
  if (normalizedHost === 'icloud.com') return 'https://setup.icloud.com/setup/ws/1';
  if (normalizedHost === 'icloud.com.cn') return 'https://setup.icloud.com.cn/setup/ws/1';
  return '';
}

function getIcloudHostHintFromMessage(message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('setup.icloud.com.cn') || lower.includes('www.icloud.com.cn') || lower.includes('icloud.com.cn')) {
    return 'icloud.com.cn';
  }
  if (lower.includes('setup.icloud.com') || lower.includes('www.icloud.com') || lower.includes('icloud.com')) {
    return 'icloud.com';
  }
  return '';
}

function isIcloudLoginRequiredError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('could not validate icloud session')
    || message.includes('hide my email service was unavailable')
    || /\bstatus (401|403|409|421)\b/.test(message);
}

async function getOpenIcloudHostPreference() {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.icloud.com/*',
        'https://www.icloud.com.cn/*',
      ],
    });

    const activeTab = tabs.find(tab => tab.active);
    const candidates = activeTab ? [activeTab, ...tabs.filter(tab => tab.id !== activeTab.id)] : tabs;

    for (const tab of candidates) {
      try {
        const host = normalizeIcloudHost(new URL(tab.url).host);
        if (host) return host;
      } catch {}
    }
  } catch {}

  return '';
}

async function getPreferredIcloudLoginUrl(error, state = null) {
  const currentState = state || await getState();
  const configuredHost = getConfiguredIcloudHostPreference(currentState);
  if (configuredHost) {
    return getIcloudLoginUrlForHost(configuredHost);
  }

  const messageHint = getIcloudHostHintFromMessage(getErrorMessage(error));
  if (messageHint) {
    return getIcloudLoginUrlForHost(messageHint);
  }

  const savedHost = normalizeIcloudHost(currentState?.preferredIcloudHost);
  if (savedHost) {
    return getIcloudLoginUrlForHost(savedHost);
  }

  const openHost = await getOpenIcloudHostPreference();
  if (openHost) {
    return getIcloudLoginUrlForHost(openHost);
  }

  if (currentState?.language === 'en-US') {
    return 'https://www.icloud.com/';
  }

  return 'https://www.icloud.com.cn/';
}

async function getPreferredIcloudSetupUrls(state = null, error = null) {
  const preferredLoginUrl = await getPreferredIcloudLoginUrl(error, state);
  const preferredHost = normalizeIcloudHost(new URL(preferredLoginUrl).host);
  const preferredSetupUrl = getIcloudSetupUrlForHost(preferredHost);

  if (!preferredSetupUrl) return [...ICLOUD_SETUP_URLS];

  return [
    preferredSetupUrl,
    ...ICLOUD_SETUP_URLS.filter(url => url !== preferredSetupUrl),
  ];
}

let lastIcloudLoginPromptAt = 0;

async function openIcloudLoginPage(preferredUrl) {
  const urlPatterns = [
    'https://www.icloud.com/*',
    'https://www.icloud.com.cn/*',
  ];
  const tabs = await chrome.tabs.query({ url: urlPatterns });
  const preferredHost = new URL(preferredUrl).host;
  const existing = tabs.find(tab => {
    try {
      return new URL(tab.url).host === preferredHost;
    } catch {
      return false;
    }
  });

  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.url !== preferredUrl) {
      await chrome.tabs.update(existing.id, { url: preferredUrl });
    }
    return existing.id;
  }

  const created = await chrome.tabs.create({ url: preferredUrl, active: true });
  return created.id;
}

async function promptIcloudLogin(error, actionLabel = 'iCloud action') {
  const now = Date.now();
  const preferredUrl = await getPreferredIcloudLoginUrl(error);
  const originalError = getErrorMessage(error);

  chrome.runtime.sendMessage({
    type: 'ICLOUD_LOGIN_REQUIRED',
    payload: {
      actionLabel,
      loginUrl: preferredUrl,
      message: 'iCloud sign-in is required. A login page has been opened for you.',
      detail: originalError,
    },
  }).catch(() => {});

  if (now - lastIcloudLoginPromptAt < 15000) {
    return;
  }
  lastIcloudLoginPromptAt = now;

  await addLog(`iCloud login required during ${actionLabel}. Opening ${new URL(preferredUrl).host}...`, 'warn');

  try {
    await openIcloudLoginPage(preferredUrl);
  } catch (tabErr) {
    await addLog(`iCloud: Failed to open login page automatically: ${getErrorMessage(tabErr)}`, 'warn');
  }
}

async function withIcloudLoginHelp(actionLabel, action) {
  try {
    return await action();
  } catch (err) {
    if (isIcloudLoginRequiredError(err)) {
      await addLog(`iCloud login check failed during ${actionLabel}: ${getErrorMessage(err)}`, 'warn');
      await promptIcloudLogin(err, actionLabel);
      throw new Error('Please finish signing in on the opened iCloud page, then click "I\'ve Signed In".');
    }
    throw err;
  }
}

async function checkIcloudSession() {
  return withIcloudLoginHelp('checking iCloud session', async () => {
    const { setupUrl } = await resolveIcloudPremiumMailService();
    await addLog(`iCloud: Session check passed via ${new URL(setupUrl).host}`, 'ok');
    return { ok: true, setupUrl };
  });
}

async function icloudRequest(method, url, options = {}) {
  const { data } = options;
  let response;
  try {
    response = await fetch(url, {
      method,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
  } catch (err) {
    throw new Error(`iCloud request failed for ${method} ${url}: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`iCloud request failed for ${method} ${url} with status ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error(`iCloud returned invalid JSON for ${method} ${url}: ${err.message}`);
  }
}

async function validateIcloudSession(setupUrl) {
  const data = await icloudRequest('POST', `${setupUrl}/validate`);
  if (!data?.webservices?.premiummailsettings?.url) {
    throw new Error('iCloud session validated, but Hide My Email service was unavailable.');
  }
  return data;
}

async function resolveIcloudPremiumMailService() {
  const errors = [];
  const state = await getState();
  const setupUrls = await getPreferredIcloudSetupUrls(state);

  for (const setupUrl of setupUrls) {
    try {
      const data = await validateIcloudSession(setupUrl);
      const preferredIcloudHost = normalizeIcloudHost(new URL(setupUrl).host);
      if (preferredIcloudHost && preferredIcloudHost !== normalizeIcloudHost(state.preferredIcloudHost)) {
        await setState({ preferredIcloudHost });
      }
      return {
        setupUrl,
        serviceUrl: String(data.webservices.premiummailsettings.url).replace(/\/$/, ''),
      };
    } catch (err) {
      errors.push(`${new URL(setupUrl).host}: ${err.message}`);
    }
  }

  throw new Error(errors.length
    ? `Could not validate iCloud session. ${errors.join(' | ')}`
    : 'Could not validate iCloud session. Log into icloud.com.cn or icloud.com in this browser first.');
}

function getIcloudAliasLabel() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `MultiPage ${dateStr}`;
}

function findIcloudAliasArray(node, depth = 0) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    return node.some(item => typeof item === 'object') ? node : null;
  }
  if (typeof node !== 'object') return null;

  const priorityKeys = ['hmeEmails', 'hmeEmailList', 'hmeList', 'hmes', 'aliases', 'items'];
  for (const key of priorityKeys) {
    if (Array.isArray(node[key])) return node[key];
  }

  for (const value of Object.values(node)) {
    const nested = findIcloudAliasArray(value, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function normalizeIcloudAliasRecord(raw, usedEmails = new Set()) {
  const anonymousId = String(raw?.anonymousId || raw?.id || '').trim();
  const email = String(
    raw?.hme
      || raw?.email
      || raw?.alias
      || raw?.address
      || raw?.metaData?.hme
      || ''
  ).trim();

  if (!email || !email.includes('@')) return null;

  const label = String(raw?.label || raw?.metaData?.label || '').trim();
  const note = String(raw?.note || raw?.metaData?.note || '').trim();
  const state = String(raw?.state || raw?.status || '').trim().toLowerCase();
  const createdAt = raw?.createTimestamp
    || raw?.createTime
    || raw?.createdAt
    || raw?.createdDate
    || null;

  return {
    anonymousId,
    email,
    label,
    note,
    state,
    active: raw?.active !== false && raw?.isActive !== false && state !== 'inactive' && state !== 'deleted',
    used: usedEmails.has(email),
    preserved: false,
    createdAt,
  };
}

async function listIcloudAliases() {
  return withIcloudLoginHelp('loading iCloud aliases', async () => {
    const { serviceUrl } = await resolveIcloudPremiumMailService();
    const response = await icloudRequest('GET', `${serviceUrl}/v2/hme/list`);
    const aliases = findIcloudAliasArray(response);
    const state = await getState();
    const usedEmails = getEffectiveUsedEmails(state);

    if (!aliases) return [];

    return aliases
      .map(alias => {
        const normalized = normalizeIcloudAliasRecord(alias, usedEmails);
        if (!normalized) return null;
        normalized.preserved = isAliasPreserved(state, normalized.email);
        return normalized;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.used !== b.used) return a.used ? 1 : -1;
        return String(a.email).localeCompare(String(b.email));
      });
  });
}

async function deleteIcloudAlias(email) {
  return withIcloudLoginHelp('deleting iCloud alias', async () => {
    const alias = typeof email === 'string'
      ? { email: String(email).trim(), anonymousId: '' }
      : {
          email: String(email?.email || '').trim(),
          anonymousId: String(email?.anonymousId || '').trim(),
        };

    if (!alias.email) {
      throw new Error('No iCloud alias email was provided.');
    }
    if (!alias.anonymousId) {
      throw new Error(`No anonymousId found for iCloud alias ${alias.email}. Refresh the alias list and retry.`);
    }

    const { serviceUrl } = await resolveIcloudPremiumMailService();

    try {
      const directDelete = await icloudRequest('POST', `${serviceUrl}/v1/hme/delete`, {
        data: { anonymousId: alias.anonymousId },
      });
      if (directDelete?.success === false) {
        throw new Error(directDelete?.error?.errorMessage || 'delete failed');
      }
    } catch (err) {
      await addLog(`iCloud: Direct delete failed for ${alias.email}, trying deactivate fallback...`, 'warn');

      const deactivated = await icloudRequest('POST', `${serviceUrl}/v1/hme/deactivate`, {
        data: { anonymousId: alias.anonymousId },
      });
      if (deactivated?.success === false) {
        throw new Error(deactivated?.error?.errorMessage || `Failed to deactivate ${alias.email}`);
      }

      const deleted = await icloudRequest('POST', `${serviceUrl}/v1/hme/delete`, {
        data: { anonymousId: alias.anonymousId },
      });
      if (deleted?.success === false) {
        throw new Error(deleted?.error?.errorMessage || `Failed to delete ${alias.email}`);
      }
    }

    const state = await getState();
    const manualAliasUsage = getManualAliasUsageMap(state);
    const preservedAliases = getPreservedAliasMap(state);
    if (alias.email in manualAliasUsage) {
      delete manualAliasUsage[alias.email];
    }
    if (alias.email in preservedAliases) {
      delete preservedAliases[alias.email];
    }
    await setState({ manualAliasUsage, preservedAliases });

    await addLog(`iCloud: Deleted alias ${alias.email}`, 'ok');
    broadcastIcloudAliasesChanged({ reason: 'deleted', email: alias.email });
    return { email: alias.email };
  });
}

async function deleteUsedIcloudAliases() {
  const aliases = await listIcloudAliases();
  const usedAliases = aliases.filter(alias => alias.used);

  if (usedAliases.length === 0) {
    return { deleted: [], skipped: [] };
  }

  const deleted = [];
  const skipped = [];

  for (const alias of usedAliases) {
    if (alias.preserved) {
      skipped.push({ email: alias.email, error: 'preserved' });
      continue;
    }
    try {
      await deleteIcloudAlias(alias);
      deleted.push(alias.email);
    } catch (err) {
      skipped.push({ email: alias.email, error: err.message });
    }
  }

  return { deleted, skipped };
}

async function fetchIcloudHideMyEmail() {
  return withIcloudLoginHelp('generating iCloud Hide My Email alias', async () => {
    throwIfStopped();
    await addLog('iCloud: Validating browser session for Hide My Email...');

    const { serviceUrl, setupUrl } = await resolveIcloudPremiumMailService();
    await addLog(`iCloud: Session validated via ${new URL(setupUrl).host}`, 'ok');

    const existingAliasesResponse = await icloudRequest('GET', `${serviceUrl}/v2/hme/list`);
    const state = await getState();
    const usedEmails = getEffectiveUsedEmails(state);
    const existingAliases = (findIcloudAliasArray(existingAliasesResponse) || [])
      .map(alias => normalizeIcloudAliasRecord(alias, usedEmails))
      .filter(Boolean);

    const reusableAlias = existingAliases.find(alias => alias.active && !alias.used);
    if (reusableAlias) {
      await setEmailState(reusableAlias.email);
      await addLog(`iCloud: Reusing unused alias ${reusableAlias.email}`, 'ok');
      broadcastIcloudAliasesChanged({ reason: 'selected', email: reusableAlias.email });
      return reusableAlias.email;
    }

    await addLog('iCloud: No unused active alias available, generating a new one...');

    const generated = await icloudRequest('POST', `${serviceUrl}/v1/hme/generate`);
    if (!generated?.success || !generated?.result?.hme) {
      throw new Error(generated?.error?.errorMessage || 'iCloud Hide My Email generate failed.');
    }

    const reservePayload = {
      hme: generated.result.hme,
      label: getIcloudAliasLabel(),
      note: 'Generated through MultiPage Automation',
    };
    const reserved = await icloudRequest('POST', `${serviceUrl}/v1/hme/reserve`, {
      data: reservePayload,
    });

    if (!reserved?.success || !reserved?.result?.hme?.hme) {
      throw new Error(reserved?.error?.errorMessage || 'iCloud Hide My Email reserve failed.');
    }

    const alias = reserved.result.hme.hme;
    await setEmailState(alias);
    await addLog(`iCloud: Reserved Hide My Email alias ${alias}`, 'ok');
    broadcastIcloudAliasesChanged({ reason: 'created', email: alias });
    return alias;
  });
}

async function fetchConfiguredEmail(options = {}) {
  const state = await getState();
  const emailSource = getEmailSource(state);
  if (emailSource === 'duck') return fetchDuckEmail(options);
  if (emailSource === 'spamok') return fetchSpamokEmail(options);
  if (emailSource === 'inbucket') return fetchInbucketEmail(options);
  return fetchIcloudHideMyEmail();
}

function getEmailSource(state) {
  const emailSource = String(state?.emailSource || '').trim().toLowerCase();
  if (emailSource === 'duck') return 'duck';
  if (emailSource === 'spamok') return 'spamok';
  if (emailSource === 'inbucket') return 'inbucket';
  return 'icloud';
}

async function fetchDuckEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Duck Mail: Opening autofill settings (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScript('duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Duck email not returned.');
  }

  await setEmailState(result.email);
  await addLog(`Duck Mail: ${result.generated ? 'Generated' : 'Loaded'} ${result.email}`, 'ok');
  return result.email;
}

function generateFriendlyMailboxName() {
  const prefixes = [
    'blue', 'cloud', 'fast', 'green', 'lucky', 'mint', 'nova', 'prime', 'quiet', 'silver',
    'smart', 'solar', 'swift', 'tiny', 'ultra', 'urban', 'vivid', 'wild', 'zen', 'bright',
  ];
  const stems = [
    'bird', 'box', 'cloud', 'field', 'fox', 'gate', 'leaf', 'mail', 'note', 'path',
    'pine', 'river', 'road', 'rock', 'star', 'stone', 'wave', 'wind', 'wolf', 'yard',
  ];

  for (let attempt = 0; attempt < 20; attempt++) {
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const stem = stems[Math.floor(Math.random() * stems.length)];
    const digitsLength = Math.floor(Math.random() * 4) + 2; // 2-5
    let digits = '';
    for (let i = 0; i < digitsLength; i++) {
      digits += String(Math.floor(Math.random() * 10));
    }

    const mailbox = `${prefix}${stem}${digits}`.toLowerCase();
    if (mailbox.length >= 6 && mailbox.length <= 30) {
      return mailbox;
    }
  }

  return `mailbox${Date.now().toString().slice(-6)}`;
}

async function fetchSpamokEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;
  const state = await getState();
  const currentEmail = String(state.email || '').trim();

  if (!generateNew && /@spamok\.com$/i.test(currentEmail)) {
    await setEmailState(currentEmail);
    await addLog(`SpamOK: Reusing ${currentEmail}`, 'ok');
    return currentEmail;
  }

  const mailbox = generateFriendlyMailboxName();
  const email = `${mailbox}@spamok.com`;
  await setEmailState(email);
  await addLog(`SpamOK: Generated ${email}`, 'ok');
  return email;
}

function normalizeDomainLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
}

function isValidDomainName(value) {
  const normalized = normalizeDomainLabel(value);
  if (!normalized) return false;
  const labels = normalized.split('.');
  return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function buildInbucketEmailDomain(state) {
  const domain = normalizeDomainLabel(state?.inbucketDomain);
  const subdomain = normalizeDomainLabel(state?.inbucketSubdomain);
  if (!domain || !isValidDomainName(domain)) {
    return { error: 'Inbucket domain is empty or invalid.' };
  }
  if (subdomain && !isValidDomainName(subdomain)) {
    return { error: 'Inbucket subdomain is invalid.' };
  }
  return { domain: subdomain ? `${subdomain}.${domain}` : domain };
}

async function fetchInbucketEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;
  const state = await getState();
  const currentEmail = String(state.email || '').trim();
  const host = normalizeInbucketOrigin(state.inbucketHost);
  const emailDomainResult = buildInbucketEmailDomain(state);

  if (!host) {
    throw new Error('Inbucket host is empty or invalid.');
  }
  if (emailDomainResult.error) {
    throw new Error(emailDomainResult.error);
  }

  const emailDomain = emailDomainResult.domain;
  if (!generateNew && currentEmail) {
    const [localPart, domainPart] = currentEmail.split('@');
    if (localPart && String(domainPart || '').trim().toLowerCase() === emailDomain) {
      await setEmailState(currentEmail);
      await addLog(`Inbucket: Reusing ${currentEmail}`, 'ok');
      return currentEmail;
    }
  }

  const mailbox = generateFriendlyMailboxName();
  const email = `${mailbox}@${emailDomain}`;
  await setEmailState(email);
  await addLog(`Inbucket: Generated ${email} via ${host}`, 'ok');
  return email;
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const [prev, persistentAliasState] = await Promise.all([
    chrome.storage.session.get([
      'seenCodes',
      'seenInbucketMailIds',
      'tabRegistry',
      'language',
      'vpsUrl',
      'autoDeleteUsedIcloudAlias',
      'forceRefreshOAuthBeforeStep6',
      'customPassword',
      'emailSource',
      'icloudHostPreference',
      'preferredIcloudHost',
      'mailProvider',
      'mailPollMaxAttempts',
      'mailPollIntervalMs',
      'mailResendRounds',
      'spamokWaitNewAttempts',
      'inbucketHost',
      'inbucketMailbox',
      'inbucketDomain',
      'inbucketSubdomain',
    ]),
    getPersistentAliasState(),
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: persistentAliasState.accounts || [],
    manualAliasUsage: persistentAliasState.manualAliasUsage && typeof persistentAliasState.manualAliasUsage === 'object'
      ? persistentAliasState.manualAliasUsage
      : {},
    preservedAliases: persistentAliasState.preservedAliases && typeof persistentAliasState.preservedAliases === 'object'
      ? persistentAliasState.preservedAliases
      : {},
    tabRegistry: prev.tabRegistry || {},
    language: prev.language || 'zh-CN',
    vpsUrl: prev.vpsUrl || '',
    autoDeleteUsedIcloudAlias: Boolean(prev.autoDeleteUsedIcloudAlias),
    forceRefreshOAuthBeforeStep6: Boolean(prev.forceRefreshOAuthBeforeStep6),
    customPassword: prev.customPassword || '',
    emailSource: getEmailSource(prev),
    icloudHostPreference: prev.icloudHostPreference || 'auto',
    preferredIcloudHost: prev.preferredIcloudHost || '',
    mailProvider: prev.mailProvider || '163',
    mailPollMaxAttempts: Number(prev.mailPollMaxAttempts) || 20,
    mailPollIntervalMs: Number(prev.mailPollIntervalMs) || 3000,
    mailResendRounds: Number(prev.mailResendRounds) || 3,
    spamokWaitNewAttempts: Number.isFinite(Number(prev.spamokWaitNewAttempts))
      ? Math.min(120, Math.max(0, Number(prev.spamokWaitNewAttempts)))
      : DEFAULT_STATE.spamokWaitNewAttempts,
    inbucketHost: prev.inbucketHost || '',
    inbucketMailbox: prev.inbucketMailbox || '',
    inbucketDomain: prev.inbucketDomain || '',
    inbucketSubdomain: prev.inbucketSubdomain || '',
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function registerPendingTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: false };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab pending: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry();
    if (sameUrl) {
      await chrome.tabs.update(tabId, { active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.tabs.reload(tabId);

        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      // For dynamically injected pages like the CPA Auth panel, re-inject immediately.
      if (options.inject) {
        await registerPendingTab(source, tabId);
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
        await new Promise(r => setTimeout(r, 500));
      }

      return tabId;
    }

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    if (options.inject) {
      await registerPendingTab(source, tabId);
    } else if (registry[source]) {
      registry[source].ready = false;
      await setState({ tabRegistry: registry });
    }

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (CPA Auth panel), re-inject after navigation
    if (options.inject) {
      if (options.injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [options.injectSource],
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    return tabId;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: true });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);
  if (options.inject) {
    await registerPendingTab(source, tab.id);
  }

  // If dynamic injection needed (CPA Auth panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message, options = {}) {
  const readyTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : ((source === 'inbucket-mail' || source === 'spamok-mail') ? 60000 : 15000);
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    if (entry?.tabId) {
      const alive = await isTabAlive(source);
      if (alive) {
        console.log(LOG_PREFIX, `${source} not marked ready yet, retrying direct send to tab ${entry.tabId}`);
        return sendToTabWithRetry(entry.tabId, message, {
          timeoutMs: readyTimeoutMs,
          intervalMs: 300,
        });
      }
    }
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message, readyTimeoutMs);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message, readyTimeoutMs);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

async function sendToTabWithRetry(tabId, message, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 300;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();

    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      lastError = err;
      await sleepWithStop(intervalMs);
    }
  }

  throw new Error(`Tab ${tabId} did not respond to ${message.type} within ${Math.round(timeoutMs / 1000)}s: ${getErrorMessage(lastError)}`);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

async function skipStep(step) {
  const stepNum = Number(step);
  if (!Number.isInteger(stepNum) || stepNum < 1 || stepNum > 9) {
    throw new Error(`Invalid step to skip: ${step}`);
  }

  const state = await getState();
  const currentStatus = state.stepStatuses?.[stepNum] || 'pending';
  if (currentStatus === 'running') {
    throw new Error(`Cannot skip step ${stepNum} while it is running.`);
  }

  await setStepStatus(stepNum, 'skipped');
  await addLog(`Step ${stepNum} skipped by user`, 'warn');
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 8 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setManualEmailState(message.payload.email);
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'SKIP_STEP': {
      const step = message.payload?.step;
      await skipStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setManualEmailState(message.payload.email);
      }
      await continueAutoRun();
      return { ok: true };
    }

    case 'CONTINUE_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setManualEmailState(message.payload.email);
      }
      await continueAutoRun();
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.language !== undefined) updates.language = message.payload.language;
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.autoDeleteUsedIcloudAlias !== undefined) updates.autoDeleteUsedIcloudAlias = Boolean(message.payload.autoDeleteUsedIcloudAlias);
      if (message.payload.forceRefreshOAuthBeforeStep6 !== undefined) updates.forceRefreshOAuthBeforeStep6 = Boolean(message.payload.forceRefreshOAuthBeforeStep6);
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.emailSource !== undefined) updates.emailSource = getEmailSource(message.payload);
      if (message.payload.icloudHostPreference !== undefined) updates.icloudHostPreference = message.payload.icloudHostPreference;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.mailPollMaxAttempts !== undefined) updates.mailPollMaxAttempts = Number(message.payload.mailPollMaxAttempts) || DEFAULT_STATE.mailPollMaxAttempts;
      if (message.payload.mailPollIntervalMs !== undefined) updates.mailPollIntervalMs = Number(message.payload.mailPollIntervalMs) || DEFAULT_STATE.mailPollIntervalMs;
      if (message.payload.mailResendRounds !== undefined) updates.mailResendRounds = Number(message.payload.mailResendRounds) || DEFAULT_STATE.mailResendRounds;
      if (message.payload.spamokWaitNewAttempts !== undefined) {
        const rawSpamokWaitNewAttempts = Number(message.payload.spamokWaitNewAttempts);
        updates.spamokWaitNewAttempts = Number.isFinite(rawSpamokWaitNewAttempts)
          ? Math.min(120, Math.max(0, rawSpamokWaitNewAttempts))
          : DEFAULT_STATE.spamokWaitNewAttempts;
      }
      if (message.payload.inbucketHost !== undefined) updates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) updates.inbucketMailbox = message.payload.inbucketMailbox;
      if (message.payload.inbucketDomain !== undefined) updates.inbucketDomain = message.payload.inbucketDomain;
      if (message.payload.inbucketSubdomain !== undefined) updates.inbucketSubdomain = message.payload.inbucketSubdomain;
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setManualEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_AUTO_EMAIL': {
      clearStopRequest();
      const email = await fetchConfiguredEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'CHECK_ICLOUD_SESSION': {
      clearStopRequest();
      return await checkIcloudSession();
    }

    case 'LIST_ICLOUD_ALIASES': {
      clearStopRequest();
      const aliases = await listIcloudAliases();
      return { ok: true, aliases };
    }

    case 'SET_ICLOUD_ALIAS_USED_STATE': {
      clearStopRequest();
      const result = await setIcloudAliasUsedState(message.payload || {});
      return { ok: true, ...result };
    }

    case 'SET_ICLOUD_ALIAS_PRESERVED_STATE': {
      clearStopRequest();
      const result = await setIcloudAliasPreservedState(message.payload || {});
      return { ok: true, ...result };
    }

    case 'DELETE_ICLOUD_ALIAS': {
      clearStopRequest();
      const result = await deleteIcloudAlias(message.payload);
      return { ok: true, ...result };
    }

    case 'DELETE_USED_ICLOUD_ALIASES': {
      clearStopRequest();
      const result = await deleteUsedIcloudAliases();
      return { ok: true, ...result };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
    case 9:
      await recordCompletedAccount();
      await maybeAutoDeleteCompletedIcloudAlias();
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const useTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timer = useTimeout
      ? setTimeout(() => {
        stepWaiters.delete(step);
        reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs)
      : null;

    stepWaiters.set(step, {
      resolve: (data) => {
        if (timer) clearTimeout(timer);
        stepWaiters.delete(step);
        resolve(data);
      },
      reject: (err) => {
        if (timer) clearTimeout(timer);
        stepWaiters.delete(step);
        reject(err);
      },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('Stop requested. Cancelling current operations...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  autoRunActive = false;
  autoRunPausedPhase = 'stopped';
  await syncAutoRunState({ autoRunning: false });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);
  await humanStepDelay();

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`Step ${step} stopped by user`, 'warn');
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();
  const timeoutMs = step === 4 ? null : 120000;
  const promise = waitForStepComplete(step, timeoutMs);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let autoRunPausedPhase = null;

function getAutoRunStatusMessage(phase, currentRun, totalRuns) {
  return { type: 'AUTO_RUN_STATUS', payload: { phase, currentRun, totalRuns } };
}

async function syncAutoRunState(overrides = {}) {
  await setState({
    autoRunning: autoRunActive,
    autoRunCurrentRun,
    autoRunTotalRuns,
    autoRunPausedPhase,
    ...overrides,
  });
}

function getAutoStepDelay(step) {
  const delayMap = {
    1: 2000,
    2: 2000,
    3: 3000,
    4: 2000,
    5: 3000,
    6: 3000,
    7: 2000,
    8: 2000,
    9: 1000,
  };
  return delayMap[step] || 0;
}

async function waitForSignupSurface(payload, timeout = 20000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const tabId = await getTabId('signup-page');
    if (!tabId) {
      throw new Error('Signup/auth tab is not available.');
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'WAIT_FOR_SURFACE',
        source: 'background',
        payload: {
          timeout: Math.min(5000, timeout),
          ...payload,
        },
      });
      if (response?.error) {
        throw new Error(response.error);
      }
      return response;
    } catch (err) {
      lastError = err;
      await sleepWithStop(250);
    }
  }

  throw new Error(`Signup page surface wait failed: ${getErrorMessage(lastError)}`);
}

async function getSignupPageRecoveryState() {
  const tabId = await getTabId('signup-page');
  if (!tabId) {
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'CHECK_PAGE_RECOVERY_STATE',
      source: 'background',
      payload: {},
    });
    return response || null;
  } catch {
    return null;
  }
}

function getAutoResumeStep(state) {
  const statuses = state?.stepStatuses || {};

  for (let step = 1; step <= 9; step++) {
    const status = statuses[step];
    if (status === 'failed' || status === 'stopped' || status === 'running') {
      return step;
    }
  }

  for (let step = 1; step <= 9; step++) {
    if (statuses[step] === 'pending') {
      return step;
    }
  }

  return null;
}

async function ensureAutoRunEmailReady(run, totalRuns) {
  const currentState = await getState();
  if (currentState.email) return;

  let emailReady = false;
  const emailSource = getEmailSource(currentState);
  const sourceLabel = emailSource === 'duck'
    ? 'Duck Mail'
    : (emailSource === 'spamok'
      ? 'SpamOK'
      : (emailSource === 'inbucket' ? 'Inbucket' : 'iCloud Hide My Email'));

  try {
    const email = await fetchConfiguredEmail({ generateNew: true });
    await addLog(`=== Run ${run}/${totalRuns} — ${sourceLabel} ready: ${email} ===`, 'ok');
    emailReady = true;
  } catch (err) {
    await addLog(`Auto email fetch failed: ${err.message}`, 'warn');
  }

  if (!emailReady) {
    const pauseHint = emailSource === 'duck'
      ? 'Generate or paste a Duck Mail address, then continue'
      : (emailSource === 'spamok'
        ? 'Generate or paste a SpamOK address, then continue'
        : (emailSource === 'inbucket'
          ? 'Generate or paste an Inbucket address, then continue'
          : 'Generate or paste an iCloud alias, then continue'));
    await addLog(`=== Run ${run}/${totalRuns} PAUSED: ${pauseHint} ===`, 'warn');
    autoRunPausedPhase = 'waiting_email';
    await syncAutoRunState();
    chrome.runtime.sendMessage(getAutoRunStatusMessage('waiting_email', run, totalRuns)).catch(() => {});

    await waitForResume();

    autoRunPausedPhase = null;
    await syncAutoRunState();

    const resumedState = await getState();
    if (!resumedState.email) {
      throw new Error('Cannot resume: no email address.');
    }
  }
}

async function executeAutoRunSteps(run, totalRuns, options = {}) {
  const { resumeFromCurrentState = false } = options;
  const state = await getState();
  let startStep = resumeFromCurrentState ? getAutoResumeStep(state) : 1;

  if (!startStep) return;

  if (resumeFromCurrentState) {
    await addLog(`=== Run ${run}/${totalRuns} — Resuming from step ${startStep} ===`, 'warn');
  }

  if (startStep <= 2) {
    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('running', run, totalRuns)).catch(() => {});

    for (let step = startStep; step <= 2; step++) {
      const currentState = await getState();
      const stepStatus = currentState.stepStatuses?.[step];
      if (stepStatus === 'completed' || stepStatus === 'skipped') continue;
      await executeStepAndWait(step, getAutoStepDelay(step));
    }
    startStep = 3;
  }

  let needsPhase2 = false;
  for (let step = startStep; step <= 9; step++) {
    const stepStatus = (await getState()).stepStatuses?.[step];
    if (stepStatus !== 'completed' && stepStatus !== 'skipped') {
      needsPhase2 = true;
      break;
    }
  }

  if (!needsPhase2) return;

  await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
  chrome.runtime.sendMessage(getAutoRunStatusMessage('running', run, totalRuns)).catch(() => {});

  await ensureAutoRunEmailReady(run, totalRuns);

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  }

  for (let step = Math.max(3, startStep); step <= 9; step++) {
    const currentState = await getState();
    const stepStatus = currentState.stepStatuses?.[step];
    if (stepStatus === 'completed' || stepStatus === 'skipped') continue;
    if (step === 3 && !currentState.email) {
      await ensureAutoRunEmailReady(run, totalRuns);
    }
    await executeStepAndWait(step, getAutoStepDelay(step));
  }
}

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns, options = {}) {
  const { startRun = 1, preserveCurrentRunState = false } = options;
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  autoRunPausedPhase = null;
  await syncAutoRunState({ autoRunning: true });

  for (let run = startRun; run <= totalRuns; run++) {
    autoRunCurrentRun = run;
    autoRunPausedPhase = null;
    await syncAutoRunState();

    const isResumingRun = preserveCurrentRunState && run === startRun;
    if (!isResumingRun) {
      // Reset everything at the start of each run (keep CPA Auth/mail settings)
      const prevState = await getState();
      const keepSettings = {
        vpsUrl: prevState.vpsUrl,
        mailProvider: prevState.mailProvider,
        inbucketHost: prevState.inbucketHost,
        inbucketMailbox: prevState.inbucketMailbox,
        autoRunning: true,
        autoRunCurrentRun: run,
        autoRunTotalRuns: totalRuns,
        autoRunPausedPhase: null,
      };
      await resetState();
      await setState(keepSettings);
      // Tell side panel to reset all UI
      chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
      await sleepWithStop(500);
    }

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(getAutoRunStatusMessage('running', run, totalRuns)).catch(() => {});

      await executeAutoRunSteps(run, totalRuns, { resumeFromCurrentState: isResumingRun });

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      if (isStopError(err)) {
        await addLog(`Run ${run}/${totalRuns} stopped by user`, 'warn');
        chrome.runtime.sendMessage(getAutoRunStatusMessage('stopped', run, totalRuns)).catch(() => {});
      } else {
        autoRunPausedPhase = 'error';
        autoRunActive = false;
        await syncAutoRunState({ autoRunning: false });
        await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
        chrome.runtime.sendMessage(getAutoRunStatusMessage('error', run, totalRuns)).catch(() => {});
        clearStopRequest();
        return;
      }
      break; // Stop on error
    }
  }

  const completedRuns = autoRunCurrentRun;
  if (stopRequested) {
    await addLog(`=== Stopped after ${Math.max(0, completedRuns - 1)}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('stopped', completedRuns, autoRunTotalRuns)).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('complete', completedRuns, autoRunTotalRuns)).catch(() => {});
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('stopped', completedRuns, autoRunTotalRuns)).catch(() => {});
  }
  autoRunActive = false;
  autoRunPausedPhase = null;
  await syncAutoRunState({ autoRunning: false, autoRunPausedPhase: null });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeWaiter) {
    autoRunPausedPhase = null;
    await syncAutoRunState();
    resumeWaiter.resolve();
    resumeWaiter = null;
  }
}

async function continueAutoRun() {
  const state = await getState();

  if (resumeWaiter) {
    await resumeAutoRun();
    return;
  }

  if (autoRunActive) {
    throw new Error('Auto run is already active.');
  }

  const currentRun = Number(state.autoRunCurrentRun || autoRunCurrentRun || 0);
  const totalRuns = Number(state.autoRunTotalRuns || autoRunTotalRuns || 1);
  if (!currentRun) {
    throw new Error('No interrupted auto run found.');
  }

  const resumeStep = getAutoResumeStep(state);
  const startRun = resumeStep ? currentRun : currentRun + 1;
  if (startRun > totalRuns) {
    throw new Error('There is no interrupted auto run to continue.');
  }

  autoRunLoop(totalRuns, {
    startRun,
    preserveCurrentRunState: Boolean(resumeStep),
  }); // fire-and-forget
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  const authPanel = getAuthPanelConfig(state);
  if (authPanel.error) {
    throw new Error(authPanel.error);
  }

  if (authPanel.provider === 'sub2api' && !String(state.email || '').trim()) {
    await addLog('Step 1: Sub2API requires an account name. Generating email first...');
    await fetchConfiguredEmail({ generateNew: true });
    state = await getState();
  }

  await addLog(`Step 1: Opening ${authPanel.label} panel...`);
  await reuseOrCreateTab(authPanel.source, authPanel.url, {
    inject: authPanel.inject,
    injectSource: authPanel.injectSource,
    reloadIfSameUrl: authPanel.reloadIfSameUrl,
  });

  await sendToContentScript(authPanel.source, {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {
      email: state.email,
      authPanelProvider: authPanel.provider,
    },
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  if (!state.email) {
    throw new Error('No email address. Paste email in Side Panel first.');
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await addLog(
      `Step 3: Filling email ${state.email}, password ${state.customPassword ? 'customized' : 'generated'} (${password.length} chars)`
        + (attempt > 1 ? ` [retry ${attempt}/2]` : '')
    );

    try {
      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 3,
        source: 'background',
        payload: { email: state.email, password },
      });

      await waitForSignupSurface({
        step: 3,
        selectors: [
          'input[name="code"]',
          'input[name="otp"]',
          'input[maxlength="1"]',
          'input[name="name"]',
          'input[placeholder*="全名"]',
          '[role="spinbutton"][data-type="year"]',
          'input[name="age"]',
        ],
      });
      return;
    } catch (err) {
      const recoveryState = await getSignupPageRecoveryState();
      const canRecover = attempt < 2 && recoveryState?.recoverable && recoveryState.type === 'operation_timed_out';
      if (!canRecover) {
        throw err;
      }

      await addLog(
        'Step 3: OpenAI showed "Operation timed out" after submit. Re-running step 2 and retrying step 3...',
        'warn'
      );

      const latestState = await getState();
      await executeStep2(latestState);
      await sleepWithStop(1200);
    }
  }
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  if (getEmailSource(state) === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const email = String(state.email || '').trim();
    const localPart = email.split('@')[0]?.trim();
    const emailDomainResult = buildInbucketEmailDomain(state);

    if (!host) {
      return { error: 'Inbucket host is empty or invalid.' };
    }
    if (emailDomainResult.error) {
      return { error: emailDomainResult.error };
    }
    if (!email || !localPart) {
      return { error: 'Inbucket email is empty or invalid. Use Auto to generate an Inbucket address first.' };
    }

    const expectedSuffix = `@${emailDomainResult.domain}`;
    if (!email.toLowerCase().endsWith(expectedSuffix)) {
      return { error: `Inbucket email must end with ${expectedSuffix}.` };
    }

    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(localPart)}/`,
      label: `Inbucket Mailbox (${localPart})`,
      navigateOnReuse: true,
      inject: ['content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }

  if (getEmailSource(state) === 'spamok') {
    const email = String(state.email || '').trim();
    const localPart = email.split('@')[0]?.trim();
    if (!email || !/@spamok\.com$/i.test(email) || !localPart) {
      return { error: 'SpamOK email is empty or invalid. Use Auto to generate a SpamOK address first.' };
    }
    return {
      source: 'spamok-mail',
      url: `https://spamok.com/${encodeURIComponent(localPart)}`,
      label: `SpamOK Mailbox (${localPart})`,
      navigateOnReuse: true,
      inject: ['content/utils.js', 'content/spamok-mail.js'],
      injectSource: 'spamok-mail',
    };
  }

  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  if (provider === 'gmail') {
    return { source: 'gmail-mail', url: 'https://mail.google.com/mail/u/0/#inbox', label: 'Gmail' };
  }
  if (provider === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const mailbox = (state.inbucketMailbox || '').trim();
    if (!host) {
      return { error: 'Inbucket host is empty or invalid.' };
    }
    if (!mailbox) {
      return { error: 'Inbucket mailbox name is empty.' };
    }
    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(mailbox)}/`,
      label: `Inbucket Mailbox (${mailbox})`,
      navigateOnReuse: true,
      inject: ['content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

function normalizeInbucketOrigin(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

function getAuthPanelProvider(state) {
  const rawUrl = String(state?.vpsUrl || '').trim().toLowerCase();
  if (rawUrl.includes('/admin/accounts')) return 'sub2api';
  return 'cpa';
}

function getAuthPanelConfig(state) {
  const url = String(state?.vpsUrl || '').trim();
  if (!url) {
    return {
      error: 'No Auth panel URL configured. Enter the CPA Auth or Sub2API address in the side panel first.',
    };
  }

  const provider = getAuthPanelProvider(state);
  if (provider === 'sub2api') {
    return {
      provider,
      source: 'sub2api-panel',
      url,
      label: 'Sub2API',
      inject: ['content/utils.js', 'content/sub2api-panel.js'],
      injectSource: 'sub2api-panel',
      reloadIfSameUrl: false,
    };
  }

  return {
    provider: 'cpa',
    source: 'vps-panel',
    url,
    label: 'CPA Auth',
    inject: ['content/utils.js', 'content/vps-panel.js'],
    injectSource: 'vps-panel',
    reloadIfSameUrl: true,
  };
}

function getMailPollConfig(state) {
  const maxAttempts = Math.min(120, Math.max(1, Number(state?.mailPollMaxAttempts) || DEFAULT_STATE.mailPollMaxAttempts));
  const intervalMs = Math.min(30000, Math.max(1000, Number(state?.mailPollIntervalMs) || DEFAULT_STATE.mailPollIntervalMs));
  const resendRounds = Math.min(10, Math.max(1, Number(state?.mailResendRounds) || DEFAULT_STATE.mailResendRounds));
  const rawSpamokWaitNewAttempts = Number(state?.spamokWaitNewAttempts);
  const spamokWaitNewAttempts = Number.isFinite(rawSpamokWaitNewAttempts)
    ? Math.min(120, Math.max(0, rawSpamokWaitNewAttempts))
    : DEFAULT_STATE.spamokWaitNewAttempts;
  return { maxAttempts, intervalMs, resendRounds, spamokWaitNewAttempts };
}

function supportsMailLoginPrompt(mail) {
  return mail && mail.source !== 'inbucket-mail';
}

function isMailLoginRequiredError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('mail list did not load')
    || message.includes('content script on qq-mail did not respond')
    || message.includes('content script on mail-163 did not respond')
    || message.includes('content script on gmail-mail did not respond')
    || message.includes('make sure qq mail inbox is open')
    || message.includes('make sure inbox is open')
    || message.includes('make sure gmail inbox or primary tab is open');
}

async function promptMailLogin(mail, step, error) {
  if (!supportsMailLoginPrompt(mail)) return;

  await addLog(`Step ${step}: ${mail.label} may require sign-in. Please log in in the opened tab, then return and confirm in the side panel.`, 'warn');

  chrome.runtime.sendMessage({
    type: 'MAIL_LOGIN_REQUIRED',
    payload: {
      step,
      label: mail.label,
      loginUrl: mail.url,
      detail: getErrorMessage(error),
    },
  }).catch(() => {});
}

async function pollVerificationCodeWithAutoResend(options) {
  const {
    step,
    mail,
    pollPayload,
    successSelectors,
    successMessage,
    resendRounds = 3,
    beforeResend = null,
  } = options;

  let currentFilterAfter = pollPayload.filterAfterTimestamp || 0;
  const verificationResultTimeoutMs = 60000;

  for (let round = 1; round <= resendRounds; round++) {
    const currentPayload = {
      ...pollPayload,
      filterAfterTimestamp: currentFilterAfter,
    };

    const result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step,
      source: 'background',
      payload: currentPayload,
    });

    if (result?.code) {
      const latestState = await getState();
      if (step === 7 && latestState.lastSignupVerificationCode && result.code === latestState.lastSignupVerificationCode) {
        currentFilterAfter = Math.max(currentFilterAfter, result.emailTimestamp || Date.now());
        await addLog(
          `Step 7: Ignoring code ${result.code} because it matches the signup verification code from step 4. Waiting for a fresh login code...`,
          'warn'
        );
        round -= 1;
        continue;
      }

      await setState({ lastEmailTimestamp: result.emailTimestamp || Date.now() });
      await addLog(`Step ${step}: ${successMessage}: ${result.code}`);

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error(`Signup page tab was closed. Cannot fill step ${step} verification code.`);
      }

      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step,
        source: 'background',
        payload: { code: result.code },
      });
      const submissionResult = await waitForSignupSurface({
        step,
        selectors: successSelectors,
        errorPatterns: [
          /代码不正确/i,
          /验证码不正确/i,
          /code is incorrect/i,
          /incorrect code/i,
          /invalid code/i,
        ],
      }, verificationResultTimeoutMs);

      if (submissionResult?.invalidCode) {
        currentFilterAfter = Date.now();
        await addLog(
          `Step ${step}: Verification code was rejected by the page (${submissionResult.errorMessage || 'invalid code'}). Waiting for a fresh code...`,
          'warn'
        );
        round -= 1;
        continue;
      }

      if (step === 4) {
        await setState({ lastSignupVerificationCode: result.code });
      }

      return;
    }

    if (result?.stopped) {
      throw new Error(result.error || STOP_ERROR_MESSAGE);
    }

    const pollError = result?.error || `No verification code returned for step ${step}.`;
    if (result?.error && isMailLoginRequiredError(result.error)) {
      throw new Error(pollError);
    }

    if (round >= resendRounds) {
      throw new Error(pollError);
    }

    if (typeof beforeResend === 'function') {
      await beforeResend({ step, round, resendRounds });
    }

    await addLog(`Step ${step}: No verification email received on round ${round}/${resendRounds}. Trying to resend code...`, 'warn');

    const signupTabId = await getTabId('signup-page');
    if (!signupTabId) {
      throw new Error(`Signup page tab was closed. Cannot resend step ${step} verification code.`);
    }

    await chrome.tabs.update(signupTabId, { active: true });
    const resendResponse = await sendToContentScript('signup-page', {
      type: 'RESEND_VERIFICATION_CODE',
      step,
      source: 'background',
      payload: {},
    });

    if (resendResponse?.error) {
      throw new Error(resendResponse.error);
    }

    currentFilterAfter = resendResponse?.resentAt || Date.now();
    const mailTabId = await getTabId(mail.source);
    if (mailTabId) {
      await chrome.tabs.update(mailTabId, { active: true });
    }
    await addLog(`Step ${step}: Resend triggered. Waiting for a fresh verification email...`, 'info');
  }
}

async function executeStep4(state) {
  const mailPollConfig = getMailPollConfig(state);
  const pollPayload = {
    filterAfterTimestamp: state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'forward'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
    targetEmail: state.email,
    maxAttempts: mailPollConfig.maxAttempts,
    intervalMs: mailPollConfig.intervalMs,
    waitNewAttempts: mailPollConfig.spamokWaitNewAttempts,
  };

  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);
  await addLog(`Step 4: Opening ${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }

  try {
    await pollVerificationCodeWithAutoResend({
      step: 4,
      mail,
      pollPayload,
      successMessage: 'Got verification code',
      successSelectors: [
        'input[name="name"]',
        'input[placeholder*="全名"]',
        '[role="spinbutton"][data-type="year"]',
        'input[name="birthday"]',
        'input[name="age"]',
      ],
      resendRounds: mailPollConfig.resendRounds,
    });
  } catch (err) {
    if (isMailLoginRequiredError(err)) {
      await promptMailLogin(mail, 4, err);
      throw new Error(`Please sign in to ${mail.label} in the opened tab, then return to the side panel, click Confirm, and retry step 4.`);
    }
    throw err;
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

async function refreshOAuthIfTimedOutBeforeStep6(state) {
  const authPanel = getAuthPanelConfig(state);

  if (state.forceRefreshOAuthBeforeStep6) {
    if (!state.vpsUrl) {
      await addLog('Step 6: Force refresh is enabled, but Auth panel URL is empty. Continuing with the current OAuth URL.', 'warn');
      return state;
    }

    await addLog('Step 6: Force refresh is enabled. Fetching a new OAuth link before login...', 'warn');
    await executeStepAndWait(1, 1500);

    const refreshedState = await getState();
    if (!refreshedState.oauthUrl) {
      throw new Error('Step 1 completed but no OAuth URL was saved after forced refresh.');
    }

    await addLog('Step 6: New OAuth link obtained from forced refresh. Continuing login...', 'ok');
    return refreshedState;
  }

  if (!state.vpsUrl) {
    return state;
  }

  if (authPanel.provider === 'sub2api') {
    await addLog('Step 6: Sub2API does not expose OAuth timeout status. Continuing with the current OAuth URL unless force refresh is enabled.');
    return state;
  }

  await addLog(`Step 6: Checking ${authPanel.label} status before login...`);

  try {
    const panelTabId = await reuseOrCreateTab(authPanel.source, authPanel.url, {
      inject: authPanel.inject,
      injectSource: authPanel.injectSource,
    });

    const response = await sendToTabWithRetry(panelTabId, {
      type: 'CHECK_OAUTH_TIMEOUT_STATUS',
      source: 'background',
    }, {
      timeoutMs: 10000,
      intervalMs: 300,
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    if (response?.oauthActive) {
      await addLog(`Step 6: ${authPanel.label} indicates the current OAuth link is still active. Continuing login...`, 'ok');
      return state;
    }

    if (!response?.timedOut) {
      return state;
    }

    const timeoutText = response.statusText || '认证失败: Timeout waiting for OAuth callback';
    await addLog(`Step 6: ${authPanel.label} reported OAuth timeout. Refreshing OAuth link... (${timeoutText})`, 'warn');

    await executeStepAndWait(1, 1500);

    const refreshedState = await getState();
    if (!refreshedState.oauthUrl) {
      throw new Error('Step 1 completed but no new OAuth URL was saved.');
    }

    await addLog('Step 6: New OAuth link obtained after timeout. Continuing login...', 'ok');
    return refreshedState;
  } catch (err) {
    await addLog(`Step 6: ${authPanel.label} timeout check could not be completed, continuing with current OAuth URL. ${getErrorMessage(err)}`, 'warn');
    return state;
  }
}

async function refreshOAuthIfTimedOutBeforeStep7Resend() {
  const state = await getState();
  if (!state.vpsUrl) {
    return state;
  }

  const authPanel = getAuthPanelConfig(state);
  if (authPanel.provider === 'sub2api') {
    await addLog('Step 7 resend: Sub2API timeout status is unavailable. Regenerating OAuth link before requesting a new verification email...', 'warn');
    await executeStepAndWait(1, 1500);
    return await getState();
  }

  await addLog(`Step 7 resend: Checking ${authPanel.label} status before requesting a new verification email...`);

  try {
    const panelTabId = await reuseOrCreateTab(authPanel.source, authPanel.url, {
      inject: authPanel.inject,
      injectSource: authPanel.injectSource,
    });

    const response = await sendToTabWithRetry(panelTabId, {
      type: 'CHECK_OAUTH_TIMEOUT_STATUS',
      source: 'background',
    }, {
      timeoutMs: 10000,
      intervalMs: 300,
    });

    if (response?.error) {
      throw new Error(response.error);
    }

    if (response?.oauthActive) {
      await addLog(`Step 7 resend: ${authPanel.label} indicates the current OAuth link is still active.`, 'ok');
      return state;
    }

    if (!response?.timedOut) {
      return state;
    }

    const timeoutText = response.statusText || '认证失败: Timeout waiting for OAuth callback';
    await addLog(`Step 7 resend: ${authPanel.label} reported OAuth timeout. Refreshing OAuth link... (${timeoutText})`, 'warn');

    await executeStepAndWait(1, 1500);

    const refreshedState = await getState();
    if (!refreshedState.oauthUrl) {
      throw new Error('Step 1 completed but no new OAuth URL was saved.');
    }

    await addLog('Step 7 resend: New OAuth link obtained after timeout.', 'ok');
    return refreshedState;
  } catch (err) {
    await addLog(`Step 7 resend: ${authPanel.label} timeout check could not be completed, continuing with current OAuth URL. ${getErrorMessage(err)}`, 'warn');
    return state;
  }
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  state = await refreshOAuthIfTimedOutBeforeStep6(state);

  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });

  await waitForSignupSurface({
    step: 6,
    selectors: [
      'input[name="code"]',
      'input[name="otp"]',
      'input[maxlength="1"]',
      'button[type="submit"][data-dd-action-name="Continue"]',
      'button[type="submit"]._primary_3rdp0_107',
    ],
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  const mailPollConfig = getMailPollConfig(state);
  const pollPayload = {
    filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'forward'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
    targetEmail: state.email,
    maxAttempts: mailPollConfig.maxAttempts,
    intervalMs: mailPollConfig.intervalMs,
    waitNewAttempts: mailPollConfig.spamokWaitNewAttempts,
  };

  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);
  await addLog(`Step 7: Opening ${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }

  try {
    await pollVerificationCodeWithAutoResend({
      step: 7,
      mail,
      pollPayload,
      successMessage: 'Got login verification code',
      successSelectors: [
        'button[type="submit"][data-dd-action-name="Continue"]',
        'button[type="submit"]._primary_3rdp0_107',
        'button[aria-label*="Continue"]',
      ],
      resendRounds: mailPollConfig.resendRounds,
      beforeResend: async () => {
        await refreshOAuthIfTimedOutBeforeStep7Resend();
      },
    });
  } catch (err) {
    if (isMailLoginRequiredError(err)) {
      await promptMailLogin(mail, 7, err);
      throw new Error(`Please sign in to ${mail.label} in the opened tab, then return to the side panel, click Confirm, and retry step 7.`);
    }
    throw err;
  }
}

// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

function isLocalCallbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  await addLog('Step 8: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;
    let signupTabId = null;
    let urlPollTimer = null;
    let timeoutId = null;

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
    };

    const cleanup = () => {
      cleanupListener();
      if (urlPollTimer) {
        clearInterval(urlPollTimer);
        urlPollTimer = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const completeWithLocalCallback = (callbackUrl, source) => {
      if (resolved || !isLocalCallbackUrl(callbackUrl)) {
        return;
      }

      resolved = true;
      cleanup();
      console.log(LOG_PREFIX, `Captured localhost redirect via ${source}: ${callbackUrl}`);

      (async () => {
        try {
          await setState({ localhostUrl: callbackUrl });
          await addLog(`Step 8: Captured localhost URL via ${source}: ${callbackUrl}`, 'ok');
          await setStepStatus(8, 'completed');
          notifyStepComplete(8, { localhostUrl: callbackUrl });
          broadcastDataUpdate({ localhostUrl: callbackUrl });
          resolve();
        } catch (err) {
          reject(err);
        }
      })();
    };

    const checkSignupTabForLocalRedirect = async (source) => {
      if (!signupTabId || resolved) {
        return false;
      }

      try {
        const tab = await chrome.tabs.get(signupTabId);
        if (isLocalCallbackUrl(tab.url)) {
          completeWithLocalCallback(tab.url, source);
          return true;
        }
      } catch (err) {
        await addLog(`Step 8: Could not inspect auth tab URL during ${source}: ${getErrorMessage(err)}`, 'warn');
      }

      return false;
    };

    timeoutId = setTimeout(() => {
      (async () => {
        const foundRedirect = await checkSignupTabForLocalRedirect('timeout fallback');
        if (foundRedirect || resolved) {
          return;
        }

        cleanup();
        reject(new Error('Localhost redirect not captured after 120s. Step 8 click may have been blocked.'));
      })().catch(err => {
        cleanup();
        reject(err);
      });
    }, 120000);

    webNavListener = (details) => {
      if (!isLocalCallbackUrl(details.url) || resolved) {
        return;
      }

      completeWithLocalCallback(details.url, 'webNavigation');
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switched to auth page. Preparing debugger click...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('Step 8: Auth tab reopened. Preparing debugger click...');
        }

        urlPollTimer = setInterval(() => {
          checkSignupTabForLocalRedirect('URL polling').catch(err => {
            console.warn(LOG_PREFIX, 'Step 8 URL polling failed:', err);
          });
        }, 800);

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!resolved) {
          await clickWithDebugger(signupTabId, clickResult?.rect);
          await addLog('Step 8: Debugger click dispatched, waiting for redirect...');
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: CPA Auth Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }

  const authPanel = getAuthPanelConfig(state);
  if (authPanel.error) {
    throw new Error(authPanel.error);
  }

  await addLog(`Step 9: Opening ${authPanel.label} panel...`);

  let tabId = await getTabId(authPanel.source);
  const alive = tabId && await isTabAlive(authPanel.source);

  if (!alive) {
    // Create new tab
    const tab = await chrome.tabs.create({ url: authPanel.url, active: true });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  if (authPanel.injectSource) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (injectedSource) => {
        window.__MULTIPAGE_SOURCE = injectedSource;
      },
      args: [authPanel.injectSource],
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: authPanel.inject,
  });
  await new Promise(r => setTimeout(r, 1000));

  await addLog(`Step 9: Completing authorization in ${authPanel.label}...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: {
      localhostUrl: state.localhostUrl,
      email: state.email,
      authPanelProvider: authPanel.provider,
    },
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
