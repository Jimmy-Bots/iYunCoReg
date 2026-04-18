// content/sub2api-panel.js — Content script for Sub2API admin accounts (steps 1, 9)
// Injected dynamically on a user-configured /admin/accounts page.

const SUB2API_PANEL_GUARD_KEY = '__MULTIPAGE_SUB2API_PANEL_INITIALIZED';

if (window[SUB2API_PANEL_GUARD_KEY]) {
  console.log('[MultiPage:sub2api-panel] Already initialized on', location.href);
} else {
window[SUB2API_PANEL_GUARD_KEY] = true;
console.log('[MultiPage:sub2api-panel] Content script loaded on', location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP') {
    resetStopState();
    handleStep(message.step, message.payload).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'CHECK_OAUTH_TIMEOUT_STATUS') {
    resetStopState();
    Promise.resolve()
      .then(() => checkOauthTimeoutStatus())
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => {
        if (isStopError(err)) {
          sendResponse({ stopped: true, error: err.message });
          return;
        }
        sendResponse({ error: err.message });
      });
    return true;
  }
});

async function handleStep(step, payload) {
  switch (step) {
    case 1: return await step1_getOAuthLink(payload);
    case 9: return await step9_completeAuthorization(payload);
    default:
      throw new Error(`sub2api-panel.js does not handle step ${step}`);
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getButtonText(button) {
  return normalizeText(button?.textContent || '');
}

function findVisibleButtonByText(pattern, root = document) {
  const buttons = Array.from(root.querySelectorAll('button'));
  return buttons.find(button => isVisible(button) && pattern.test(getButtonText(button))) || null;
}

function findAuthUrlInput() {
  const inputs = Array.from(document.querySelectorAll('input[readonly], input.input[readonly], input.input'));
  return inputs.find(input => String(input.value || '').trim().startsWith('http')) || null;
}

function getAuthUrlValue() {
  const input = findAuthUrlInput();
  return String(input?.value || '').trim();
}

function findRegenerateButton() {
  return findVisibleButtonByText(/重新生成|regenerate/i);
}

function findGenerateAuthButton() {
  return findVisibleButtonByText(/生成授权链接|generate authorization link|generate auth/i);
}

function findAddAccountButton() {
  return findVisibleButtonByText(/添加账号|add account|create account/i);
}

function findBackButton() {
  return findVisibleButtonByText(/返回|back/i);
}

function findCompleteAuthorizationButton() {
  return findVisibleButtonByText(/完成授权|complete authorization|complete auth/i);
}

function isPendingAuthorizationStep() {
  const completeButton = findCompleteAuthorizationButton();
  return Boolean(completeButton && completeButton.disabled);
}

function findAccountNameInput() {
  const inputs = Array.from(document.querySelectorAll(
    'input[data-tour="account-form-name"], input[placeholder*="账号名称"], input[placeholder*="account name" i]'
  ));
  return inputs.find(isVisible) || null;
}

function findOpenAiButton() {
  const scopedButtons = Array.from(document.querySelectorAll('[data-tour="account-form-platform"] button'));
  const scopedMatch = scopedButtons.find(button => /openai/i.test(getButtonText(button)));
  if (scopedMatch) return scopedMatch;
  return findVisibleButtonByText(/openai/i);
}

function findNextButton() {
  return document.querySelector('[data-tour="account-form-submit"]')
    || findVisibleButtonByText(/下一步|next/i);
}

function fillTextArea(el, value) {
  throwIfStopped();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  if (!setter) {
    throw new Error('Could not access textarea value setter.');
  }

  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  log(`Filled textarea with ${value}`);
}

async function waitForCondition(check, timeout = 5000, description = 'condition') {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    try {
      if (check()) {
        return true;
      }
    } catch {}
    await sleep(120);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForFreshOauthUrl(previousUrl = '', timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const currentUrl = getAuthUrlValue();
    if (currentUrl.startsWith('http') && (!previousUrl || currentUrl !== previousUrl)) {
      return currentUrl;
    }
    await sleep(200);
  }

  const latestUrl = getAuthUrlValue();
  if (latestUrl && latestUrl === previousUrl) {
    throw new Error('Sub2API OAuth URL did not change after clicking regenerate/generate.');
  }

  throw new Error('Sub2API OAuth URL did not appear in time.');
}

async function checkOauthTimeoutStatus() {
  const authUrl = getAuthUrlValue();
  const oauthActive = authUrl.startsWith('http');

  if (oauthActive) {
    log('Sub2API current status: OAuth URL is present on the page.', 'ok');
  } else {
    log('Sub2API current status: no OAuth URL found yet.', 'warn');
  }

  return {
    oauthActive,
    timedOut: false,
    waiting: false,
    statusText: oauthActive ? 'OAuth URL ready' : 'OAuth URL missing',
    authUrl,
    regenerateAvailable: Boolean(findRegenerateButton()),
    url: location.href,
  };
}

async function ensureAccountModalReady(targetEmail) {
  const nameInput = findAccountNameInput()
    || await waitForElement('input[data-tour="account-form-name"], input[placeholder*="账号名称"], input[placeholder*="account name" i]', 10000);
  await humanPause(350, 900);
  fillInput(nameInput, targetEmail);
  log(`Step 1: Filled Sub2API account name: ${targetEmail}`);

  const openAiButton = findOpenAiButton();
  if (!openAiButton) {
    throw new Error('Could not find the OpenAI platform button in Sub2API.');
  }
  await humanPause(250, 700);
  simulateClick(openAiButton);
  log('Step 1: Selected OpenAI platform in Sub2API');
  await sleep(350);
  await waitForCondition(() => {
    const classText = String(openAiButton.className || '');
    return /bg-white|text-orange|shadow-sm/.test(classText) || openAiButton.getAttribute('aria-pressed') === 'true';
  }, 4000, 'Sub2API OpenAI platform activation').catch(async () => {
    await sleep(500);
    return true;
  });

  const nextButton = findNextButton();
  if (!nextButton) {
    throw new Error('Could not find the "下一步" button in Sub2API.');
  }
  await humanPause(250, 700);
  simulateClick(nextButton);
  log('Step 1: Clicked "下一步" in Sub2API');
  await sleep(500);
  await waitForCondition(
    () => Boolean(findGenerateAuthButton() || findRegenerateButton() || getAuthUrlValue()),
    10000,
    'Sub2API authorization step to appear'
  );
}

async function returnFromPendingAuthorizationStep() {
  if (!isPendingAuthorizationStep()) {
    return;
  }

  const backButton = findBackButton();
  if (!backButton) {
    throw new Error('Sub2API is stuck on the authorization step, but the "返回" button was not found.');
  }

  await humanPause(250, 700);
  simulateClick(backButton);
  log('Step 1: Clicked "返回" to leave the pending authorization step in Sub2API');
  await sleep(500);
  await waitForCondition(
    () => Boolean(findAccountNameInput() || findAddAccountButton() || findGenerateAuthButton() || findRegenerateButton() || getAuthUrlValue()),
    10000,
    'Sub2API to return from the pending authorization step'
  );
}

async function openNewAccountFlow(targetEmail) {
  let nameInput = findAccountNameInput();
  if (!nameInput) {
    const addAccountButton = findAddAccountButton() || await waitForElementByText('button', /添加账号|add account|create account/i, 15000);
    await humanPause(250, 700);
    simulateClick(addAccountButton);
    log('Step 1: Clicked "添加账号" in Sub2API');
    await sleep(500);
  }

  await ensureAccountModalReady(targetEmail);
  return await waitForElementByText('button', /生成授权链接|generate authorization link|generate auth/i, 15000);
}

async function step1_getOAuthLink(payload = {}) {
  const targetEmail = String(payload.email || '').trim();
  const forceNewAccount = Boolean(payload.forceNewAccount);
  if (!targetEmail) {
    throw new Error('Sub2API step 1 requires a generated email/account name.');
  }

  await waitForDocumentReady('interactive', 15000).catch(() => {});
  await sleep(200);
  log('Step 1: Waiting for Sub2API admin accounts page to become ready...');

  await returnFromPendingAuthorizationStep();

  if (forceNewAccount) {
    log(`Step 1: Fresh run detected for ${targetEmail}. Skipping "重新生成" and creating a new Sub2API account entry instead.`);
  }

  const existingOauthUrl = getAuthUrlValue();
  const regenerateButton = findRegenerateButton();
  if (!forceNewAccount && existingOauthUrl && regenerateButton) {
    await humanPause(250, 700);
    simulateClick(regenerateButton);
    log('Step 1: Clicked "重新生成" on Sub2API');
    await sleep(500);
    const oauthUrl = await waitForFreshOauthUrl(existingOauthUrl, 15000);
    log(`Step 1: OAuth URL obtained from Sub2API: ${oauthUrl.slice(0, 80)}...`, 'ok');
    reportComplete(1, { oauthUrl });
    return;
  }

  let generateButton = findGenerateAuthButton();
  if (forceNewAccount || !generateButton) {
    generateButton = await openNewAccountFlow(targetEmail);
  }

  const previousOauthUrl = getAuthUrlValue();
  await humanPause(250, 700);
  simulateClick(generateButton);
  log('Step 1: Clicked "生成授权链接" in Sub2API');
  await sleep(500);

  const oauthUrl = await waitForFreshOauthUrl(previousOauthUrl, 15000);
  if (!oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL returned from Sub2API: ${oauthUrl.slice(0, 50)}`);
  }

  log(`Step 1: OAuth URL obtained from Sub2API: ${oauthUrl.slice(0, 80)}...`, 'ok');
  reportComplete(1, { oauthUrl });
}

async function waitForAuthorizationResult(timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const errorNode = Array.from(document.querySelectorAll('[role="alert"], .text-red-500, .text-red-600, .text-danger, .text-error'))
      .find(node => /失败|错误|error|invalid/i.test(normalizeText(node.textContent)));
    if (errorNode) {
      throw new Error(`Sub2API authorization failed: ${normalizeText(errorNode.textContent)}`);
    }

    const toastContainer = document.querySelector([
      'div[aria-live="polite"][aria-atomic="true"]',
      '.pointer-events-none.fixed.right-4.top-4',
    ].join(', '));
    const toastSuccessNode = toastContainer
      ? Array.from(toastContainer.querySelectorAll('*')).find(node => /授权成功|添加成功|成功|success/i.test(normalizeText(node.textContent)))
      : null;
    if (toastSuccessNode) {
      return { confirmed: true, message: normalizeText(toastSuccessNode.textContent) };
    }

    const successNode = Array.from(document.querySelectorAll([
      '[role="status"]',
      '[role="alert"]',
      '.text-green-500',
      '.text-green-600',
      '.text-emerald-500',
      '.text-emerald-600',
      '[class*="success"]',
    ].join(', ')))
      .find(node => /授权成功|添加成功|success|已完成/i.test(normalizeText(node.textContent)));
    if (successNode) {
      return { confirmed: true, message: normalizeText(successNode.textContent) };
    }

    await sleep(250);
  }

  return { confirmed: false, message: 'Sub2API did not expose a clear success indicator within 20s.' };
}

async function step9_completeAuthorization(payload = {}) {
  let localhostUrl = String(payload.localhostUrl || '').trim();
  if (!localhostUrl) {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    localhostUrl = String(state.localhostUrl || '').trim();
  }
  if (!localhostUrl) {
    throw new Error('No localhost URL found. Complete step 8 first.');
  }

  await waitForDocumentReady('interactive', 15000).catch(() => {});
  await sleep(200);

  const authTextarea = await waitForElement('textarea.input, textarea[placeholder*="auth/callback"], textarea[placeholder*="code"]', 15000);
  await humanPause(350, 900);
  fillTextArea(authTextarea, localhostUrl);
  log(`Step 9: Filled Sub2API authorization textarea with callback URL: ${localhostUrl.slice(0, 80)}...`);

  const submitButton = findVisibleButtonByText(/完成授权|complete authorization|finish authorization/i);
  if (!submitButton) {
    throw new Error('Could not find the "完成授权" button in Sub2API.');
  }

  await humanPause(250, 700);
  simulateClick(submitButton);
  log('Step 9: Clicked "完成授权" in Sub2API');
  await sleep(700);

  try {
    const result = await waitForAuthorizationResult(20000);
    if (result.confirmed) {
      log(`Step 9: Sub2API authorization finished: ${result.message}`, 'ok');
    } else {
      log(`Step 9: ${result.message} Filled callback URL and continuing.`, 'warn');
    }
  } catch (err) {
    if (/authorization failed/i.test(String(err?.message || ''))) {
      throw err;
    }
    log(`Step 9: Could not confirm Sub2API authorization automatically after submitting: ${err.message}`, 'warn');
  }

  reportComplete(9);
}

} // end singleton guard
