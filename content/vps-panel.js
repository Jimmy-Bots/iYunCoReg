// content/vps-panel.js — Content script for CPA Auth panel (steps 1, 9)
// Injected on: CPA Auth panel (user-configured URL)
//
// Actual DOM structure (after login click):
// <div class="card">
//   <div class="card-header">
//     <span class="OAuthPage-module__cardTitle___yFaP0">Codex OAuth</span>
//     <button class="btn btn-primary"><span>登录</span></button>
//   </div>
//   <div class="OAuthPage-module__cardContent___1sXLA">
//     <div class="OAuthPage-module__authUrlBox___Iu1d4">
//       <div class="OAuthPage-module__authUrlLabel___mYFJB">授权链接:</div>
//       <div class="OAuthPage-module__authUrlValue___axvUJ">https://auth.openai.com/...</div>
//       <div class="OAuthPage-module__authUrlActions___venPj">
//         <button class="btn btn-secondary btn-sm"><span>复制链接</span></button>
//         <button class="btn btn-secondary btn-sm"><span>打开链接</span></button>
//       </div>
//     </div>
//     <div class="OAuthPage-module__callbackSection___8kA31">
//       <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
//       <button class="btn btn-secondary btn-sm"><span>提交回调 URL</span></button>
//     </div>
//   </div>
// </div>

console.log('[MultiPage:vps-panel] Content script loaded on', location.href);

// Listen for commands from Background
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
    case 1: return await step1_getOAuthLink();
    case 9: return await step9_vpsVerify(payload);
    default:
      throw new Error(`vps-panel.js does not handle step ${step}`);
  }
}

function findCodexOauthCard() {
  const cards = document.querySelectorAll('.card');
  for (const card of cards) {
    const headerText = (card.querySelector('.card-header')?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/codex\s*oauth/i.test(headerText)) {
      return card;
    }
  }
  return null;
}

function checkOauthTimeoutStatus() {
  const card = findCodexOauthCard();
  const statusEl = card?.querySelector('.status-badge');
  const statusText = (statusEl?.textContent || '').replace(/\s+/g, ' ').trim();
  const loginButton = card?.querySelector('.card-header button.btn.btn-primary, .card-header button.btn');
  const loginButtonDisabled = Boolean(loginButton?.disabled);
  const waiting = /等待认证中|waiting for auth|waiting for authentication/i.test(statusText);
  const timedOut = /认证失败|auth(?:entication)? failed/i.test(statusText)
    && /timeout waiting for oauth callback/i.test(statusText);
  const authUrl = (card?.querySelector('[class*="authUrlValue"]')?.textContent || '').trim();
  const hasValidAuthUrl = authUrl.startsWith('http');
  const oauthActive = hasValidAuthUrl && (waiting || loginButtonDisabled);

  if (oauthActive) {
    log(
      `CPA Auth indicates OAuth is still active: status="${statusText || 'unknown'}", loginDisabled=${loginButtonDisabled}`,
      'ok'
    );
  } else if (timedOut) {
    log(`CPA Auth status indicates OAuth timeout: ${statusText}`, 'warn');
  } else if (statusText) {
    log(`CPA Auth current status: ${statusText}`);
  } else {
    log('CPA Auth current status: no status badge found yet.');
  }

  return {
    oauthActive,
    timedOut,
    waiting,
    statusText,
    authUrl,
    loginButtonDisabled,
    url: location.href,
  };
}

async function waitForFreshOauthUrl(previousUrl = '', timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const card = findCodexOauthCard();
    const authUrl = (card?.querySelector('[class*="authUrlValue"]')?.textContent || '').trim();
    const valid = authUrl.startsWith('http');
    const changed = !previousUrl || authUrl !== previousUrl;

    if (valid && changed) {
      return authUrl;
    }

    await sleep(200);
  }

  const latestCard = findCodexOauthCard();
  const latestUrl = (latestCard?.querySelector('[class*="authUrlValue"]')?.textContent || '').trim();
  if (latestUrl && latestUrl === previousUrl) {
    throw new Error('OAuth URL did not refresh after clicking login. The panel is still showing the previous expired link.');
  }

  throw new Error(
    'Auth URL did not appear after clicking login. ' +
    'Check if the CPA Auth panel is logged in and Codex service is running. URL: ' + location.href
  );
}

// ============================================================
// Step 1: Get OAuth Link
// ============================================================

async function step1_getOAuthLink() {
  log('Step 1: Waiting for CPA Auth panel to load (auto-login may take a moment)...');

  // The page may start at #/login and auto-redirect to #/oauth.
  // Wait for the Codex OAuth card to appear (up to 30s for auto-login + redirect).
  let loginBtn = null;
  let card = null;
  try {
    // Wait for any card-header containing "Codex" to appear
    const header = await waitForElementByText('.card-header', /codex/i, 30000);
    card = header.closest('.card');
    loginBtn = header.querySelector('button.btn.btn-primary, button.btn');
    log('Step 1: Found Codex OAuth card');
  } catch {
    throw new Error(
      'Codex OAuth card did not appear after 30s. Page may still be loading or not logged in. ' +
      'Current URL: ' + location.href
    );
  }

  if (!loginBtn) {
    throw new Error('Found Codex OAuth card but no login button inside it. URL: ' + location.href);
  }

  const previousOauthUrl = (card?.querySelector('[class*="authUrlValue"]')?.textContent || '').trim();

  // Check if button is disabled (already clicked / loading)
  if (loginBtn.disabled) {
    log('Step 1: Login button is disabled (already loading), waiting for auth URL...');
  } else {
    await humanPause(500, 1400);
    simulateClick(loginBtn);
    log('Step 1: Clicked login button, waiting for auth URL...');
  }

  // Wait for the auth URL to appear or refresh to a new value.
  const oauthUrl = await waitForFreshOauthUrl(previousOauthUrl, 15000);

  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL found: "${oauthUrl.slice(0, 50)}". Expected URL starting with http.`);
  }

  log(`Step 1: OAuth URL obtained: ${oauthUrl.slice(0, 80)}...`, 'ok');
  reportComplete(1, { oauthUrl });
}

// ============================================================
// Step 9: CPA Auth Verify — paste localhost URL and submit
// ============================================================

async function step9_vpsVerify(payload) {
  // Get localhostUrl from payload (passed directly by background) or fallback to state
  let localhostUrl = payload?.localhostUrl;
  if (!localhostUrl) {
    log('Step 9: localhostUrl not in payload, fetching from state...');
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    localhostUrl = state.localhostUrl;
  }
  if (!localhostUrl) {
    throw new Error('No localhost URL found. Complete step 8 first.');
  }
  log(`Step 9: Got localhostUrl: ${localhostUrl.slice(0, 60)}...`);

  log('Step 9: Looking for callback URL input...');

  // Find the callback URL input
  // Actual DOM: <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
  let urlInput = null;
  try {
    urlInput = await waitForElement('[class*="callbackSection"] input.input', 10000);
  } catch {
    try {
      urlInput = await waitForElement('input[placeholder*="localhost"]', 5000);
    } catch {
      throw new Error('Could not find callback URL input on the CPA Auth panel. URL: ' + location.href);
    }
  }

  await humanPause(600, 1500);
  fillInput(urlInput, localhostUrl);
  log(`Step 9: Filled callback URL: ${localhostUrl.slice(0, 80)}...`);

  // Find and click "提交回调 URL" button
  let submitBtn = null;
  try {
    submitBtn = await waitForElementByText(
      '[class*="callbackActions"] button, [class*="callbackSection"] button',
      /提交|submit|callback/i,
      5000
    );
  } catch {
    try {
      submitBtn = await waitForElementByText('button.btn', /提交回调|submit callback|submit/i, 5000);
    } catch {
      throw new Error('Could not find "提交回调 URL" button. URL: ' + location.href);
    }
  }

  await humanPause(450, 1200);
  simulateClick(submitBtn);
  log('Step 9: Clicked "提交回调 URL", waiting for authentication result...');

  // Wait for "认证成功！" status badge to appear
  try {
    await waitForElementByText('.status-badge, [class*="status"]', /认证成功|授权成功|认证完成|success|authenticated|authorized/i, 30000);
    log('Step 9: Authentication successful!', 'ok');
  } catch {
    // Check if there's an error message instead
    const statusEl = document.querySelector('.status-badge, [class*="status"]');
    const statusText = statusEl ? statusEl.textContent : 'unknown';
    if (/成功|success/i.test(statusText)) {
      log('Step 9: Authentication successful!', 'ok');
    } else {
      log(`Step 9: Status after submit: "${statusText}". May still be processing.`, 'warn');
    }
  }

  reportComplete(9);
}
