// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP8_FIND_AND_CLICK' || message.type === 'WAIT_FOR_SURFACE' || message.type === 'RESEND_VERIFICATION_CODE' || message.type === 'CHECK_PAGE_RECOVERY_STATE') {
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step || 8}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP8_FIND_AND_CLICK') {
        log(`Step 8: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'RESEND_VERIFICATION_CODE') {
        log(`Step ${message.step}: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_login(message.payload);
        case 8: return await step8_findAndClick();
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
    case 'WAIT_FOR_SURFACE':
      return await waitForSurfacePayload(message.payload);
    case 'RESEND_VERIFICATION_CODE':
      return await resendVerificationCode(message.step, message.payload);
    case 'CHECK_PAGE_RECOVERY_STATE':
      return getPageRecoveryState();
  }
}

function getPageRecoveryState() {
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const hasOopsHeading = /糟糕，出错了|something went wrong/i.test(bodyText);
  const hasOperationTimedOut = /operation timed out/i.test(bodyText);

  if (hasOopsHeading && hasOperationTimedOut) {
    return {
      recoverable: true,
      type: 'operation_timed_out',
      message: 'Operation timed out',
      url: location.href,
    };
  }

  return {
    recoverable: false,
    type: '',
    message: '',
    url: location.href,
  };
}

async function ensureAuthSurfaceReady(step, timeout = 15000) {
  await waitForDocumentReady('interactive', timeout);
  await sleep(250);
  log(`Step ${step}: Page ready state is ${document.readyState}`);
}

async function waitForAnySelector(selectors, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return { element: el, selector };
    }
    await sleep(120);
  }
  return null;
}

async function waitForPostClickTransition(step, previousUrl, selectors, timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    if (location.href !== previousUrl) {
      await waitForDocumentReady('interactive', 5000).catch(() => {});
      log(`Step ${step}: URL changed after click to ${location.href}`);
      return { type: 'url', value: location.href };
    }

    const found = await waitForAnySelector(selectors, 400);
    if (found) {
      log(`Step ${step}: Next page surface detected via ${found.selector}`);
      return { type: 'selector', value: found.selector };
    }
  }

  throw new Error(`Step ${step}: Page did not transition in time after click. URL: ${location.href}`);
}

async function waitForSurfacePayload(payload = {}) {
  const {
    step = 'surface',
    selectors = [],
    errorPatterns = [],
    timeout = 15000,
    minReadyState = 'interactive',
  } = payload;

  await ensureAuthSurfaceReady(step, timeout);
  if (!selectors.length) {
    return { readyState: document.readyState, url: location.href };
  }

  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();

    const found = await waitForAnySelector(selectors, 400);
    if (found) {
      log(`Step ${step}: Surface confirmed by ${found.selector} at readyState ${document.readyState}`);
      return {
        selector: found.selector,
        readyState: document.readyState,
        url: location.href,
        minReadyState,
      };
    }

    const matchedError = findVerificationErrorMessage(errorPatterns);
    if (matchedError) {
      log(`Step ${step}: Verification error detected: ${matchedError}`, 'warn');
      return {
        invalidCode: true,
        errorMessage: matchedError,
        readyState: document.readyState,
        url: location.href,
        minReadyState,
      };
    }
  }

  throw new Error(`Step ${step}: Expected next page surface not found within ${timeout}ms. URL: ${location.href}`);
}

function findVerificationErrorMessage(errorPatterns = []) {
  if (!Array.isArray(errorPatterns) || errorPatterns.length === 0) return '';

  const candidates = Array.from(document.querySelectorAll([
    '[slot="errorMessage"]',
    '.react-aria-FieldError',
    'li._error_18qcl_110',
    '[aria-live="polite"]',
    '[role="alert"]',
  ].join(', ')));

  for (const node of candidates) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    for (const pattern of errorPatterns) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
      if (regex.test(text)) {
        return text;
      }
    }
  }

  return '';
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  await ensureAuthSurfaceReady(2);
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  await humanPause(450, 1200);
  const previousUrl = location.href;
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
  await waitForPostClickTransition(2, previousUrl, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[type="password"]',
    'input[name="name"]',
    'input[name="code"]',
  ], 15000);
  reportComplete(2);
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  await ensureAuthSurfaceReady(3);
  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 3: Email filled');

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      await humanPause(400, 1100);
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleep(2000);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  await humanPause(600, 1500);
  fillInput(passwordInput, payload.password);
  log('Step 3: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(500, 1300);
    simulateClick(submitBtn);
    log('Step 3: Form submitted');
  }
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  await ensureAuthSurfaceReady(step);
  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleep(1000);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`Step ${step}: Code filled`);

  // Report complete BEFORE submit (page may navigate away)
  reportComplete(step);

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

async function resendVerificationCode(step, payload = {}) {
  await ensureAuthSurfaceReady(step);
  log(`Step ${step}: Trying to resend verification code...`);

  const resendBtn = await findVerificationResendButton(payload.timeout || 10000);
  await waitForButtonEnabled(resendBtn);

  await humanPause(400, 900);
  simulateClick(resendBtn);
  await sleep(1200);

  const resentAt = Date.now();
  log(`Step ${step}: Verification code resend triggered`);
  return { resentAt };
}

async function findVerificationResendButton(timeout = 10000) {
  const selector = [
    'button[type="submit"][name="intent"][value="resend"]',
    'button[name="intent"][value="resend"]',
    'button[type="submit"][value="resend"]',
  ].join(', ');

  try {
    return await waitForElement(selector, timeout);
  } catch {
    try {
      return await waitForElementByText('button', /重新发送电子邮件|重新发送|resend email|resend/i, Math.max(3000, timeout / 2));
    } catch {
      throw new Error('Could not find the resend button on the verification page. URL: ' + location.href);
    }
  }
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function step6_login(payload) {
  const { email, password } = payload;
  if (!email) throw new Error('No email provided for login.');

  await ensureAuthSurfaceReady(6);
  log(`Step 6: Logging in with ${email}...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('Could not find email input on login page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 6: Email filled');

  // Submit email
  await sleep(500);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('Step 6: Submitted email');
  }

  const passwordInput = await waitForLoginPasswordField();
  if (passwordInput) {
    log('Step 6: Password field found, filling password...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    // Report complete BEFORE submit in case page navigates
    reportComplete(6, { needsOTP: true });

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('Step 6: Submitted password, may need verification code (step 7)');
    }
    return;
  }

  // No password field — OTP flow
  log('Step 6: No password field. OTP flow or auto-redirect.');
  reportComplete(6, { needsOTP: true });
}

async function waitForLoginPasswordField(timeout = 25000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const passwordInput = findVisiblePasswordInput();
    if (passwordInput) {
      return passwordInput;
    }

    await sleep(250);
  }

  log(`Step 6: Password field did not appear within ${Math.round(timeout / 1000)}s.`, 'warn');
  return null;
}

function findVisiblePasswordInput() {
  const inputs = document.querySelectorAll('input[type="password"]');
  for (const input of inputs) {
    if (isElementVisible(input)) {
      return input;
    }
  }
  return null;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ============================================================
// Step 8: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  await ensureAuthSurfaceReady(8);
  log('Step 8: Looking for OAuth consent "继续" button...');

  const phoneRequiredError = findStep8BlockingError();
  if (phoneRequiredError) {
    throw new Error(`${phoneRequiredError}。请更换环境重试。`);
  }

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  const phoneRequiredErrorAfterButton = findStep8BlockingError();
  if (phoneRequiredErrorAfterButton) {
    throw new Error(`${phoneRequiredErrorAfterButton}。请更换环境重试。`);
  }

  await humanPause(350, 900);
  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  continueBtn.focus();
  await sleep(250);

  const rect = getSerializableRect(continueBtn);
  log('Step 8: Found "继续" button and prepared debugger click coordinates.');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

function findStep8BlockingError() {
  const candidates = Array.from(document.querySelectorAll([
    'h1',
    '[role="alert"]',
    '[aria-live="polite"]',
    '[class*="error"]',
  ].join(', ')));

  for (const node of candidates) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/电话号码是必填项|phone number is required|required phone number/i.test(text)) {
      return text;
    }
  }

  return '';
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('No birthday or age data provided.');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`Step 5: Name filled: ${fullName}`);

  let birthdayMode = false;
  let ageInput = null;

  for (let i = 0; i < 100; i++) {
    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');

    // Some pages include a hidden birthday input even though the real UI is "age".
    // In that case we must prioritize filling age to satisfy required validation.
    if (ageInput) break;

    if ((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('Birthday field detected, but no birthday data provided.');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

    if (yearSpinner && monthSpinner && daySpinner) {
      log('Step 5: Birthday fields detected, filling birthday...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`Step 5: Birthday filled: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set: ${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('Age field detected, but no age data provided.');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`Step 5: Age filled: ${resolvedAge}`);

    // Some age-mode pages still submit a hidden birthday field.
    // Keep it aligned with generated data so backend validation won't reject.
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set (age mode): ${dateStr}`);
    }
  } else {
    throw new Error('Could not find birthday or age input. URL: ' + location.href);
  }

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  reportComplete(5);

  if (completeBtn) {
    await humanPause(500, 1300);
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建"');
  }
}
