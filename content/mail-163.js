// content/mail-163.js — Content script for 163 Mail (steps 4, 7)
// Injected on: mail.163.com
//
// DOM structure:
// Mail item: div[sign="letter"] with aria-label="你的 ChatGPT 代码为 479637 发件人 ： OpenAI ..."
// Sender: .nui-user (e.g., "OpenAI")
// Subject: span.da0 (e.g., "你的 ChatGPT 代码为 479637")
// Right-click menu: .nui-menu → .nui-menu-item with text "删除邮件"

const MAIL163_PREFIX = '[MultiPage:mail-163]';
const isTopFrame = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// Only operate in the top frame
if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {

// Track codes we've already seen — persisted in chrome.storage.session to survive script re-injection
let seenCodes = new Set();

async function loadSeenCodes() {
  try {
    const data = await chrome.storage.session.get('seenCodes');
    if (data.seenCodes && Array.isArray(data.seenCodes)) {
      seenCodes = new Set(data.seenCodes);
      console.log(MAIL163_PREFIX, `Loaded ${seenCodes.size} previously seen codes`);
    }
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Session storage unavailable, using in-memory seen codes:', err?.message || err);
  }
}

// Load previously seen codes on startup
loadSeenCodes();

async function persistSeenCodes() {
  try {
    await chrome.storage.session.set({ seenCodes: [...seenCodes] });
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Could not persist seen codes, continuing in-memory only:', err?.message || err);
  }
}

// ============================================================
// Message Handler (top frame only)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`Step ${message.step}: Poll attempt failed, background will decide whether to resend/retry: ${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

// ============================================================
// Find mail items
// ============================================================

function findMailItems() {
  return document.querySelectorAll('div[sign="letter"]');
}

function getCurrentMailIds() {
  const ids = new Set();
  findMailItems().forEach(item => {
    const id = item.getAttribute('id') || '';
    if (id) ids.add(id);
  });
  return ids;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readAttr(el, name) {
  try {
    return el?.getAttribute?.(name) || '';
  } catch {
    return '';
  }
}

function getMailItemMeta(item) {
  const sender = normalizeText(item.querySelector('.nui-user')?.textContent || '');
  const subject = normalizeText(item.querySelector('span.da0')?.textContent || '');
  const itemText = normalizeText(item.innerText || item.textContent || '');
  const ariaLabel = normalizeText(readAttr(item, 'aria-label'));
  const titleTexts = [];

  const annotatedNodes = item.querySelectorAll('[title], [aria-label]');
  for (const node of annotatedNodes) {
    const title = normalizeText(readAttr(node, 'title'));
    const label = normalizeText(readAttr(node, 'aria-label'));
    if (title) titleTexts.push(title);
    if (label) titleTexts.push(label);
    if (titleTexts.length >= 20) break;
  }

  const combinedText = normalizeText([
    sender,
    subject,
    itemText,
    ariaLabel,
    titleTexts.join(' '),
  ].join(' '));

  return {
    sender,
    subject,
    combinedText,
  };
}

function scoreOpenedMailText(text, meta = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return -1;

  const lower = normalized.toLowerCase();
  let score = 0;

  if (extractVerificationCode(normalized)) score += 20;
  if (/openai|chatgpt|verification|verify|login code|one-time|otp/i.test(normalized)) score += 12;
  if (/验证码|代码|登录代码|临时|一次性/.test(normalized)) score += 12;

  const sender = normalizeText(meta.sender).toLowerCase();
  if (sender && lower.includes(sender)) score += 6;

  const subjectTokens = normalizeText(meta.subject)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(token => token.length >= 2);
  for (const token of subjectTokens.slice(0, 8)) {
    if (lower.includes(token)) score += 2;
  }

  return score;
}

function collectOpenedMailTextCandidates(meta = {}) {
  const candidates = [];
  const seen = new Set();

  function pushCandidate(text, source) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 6) return;
    const key = `${source}:${normalized.slice(0, 400)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      source,
      text: normalized,
      score: scoreOpenedMailText(normalized, meta),
    });
  }

  document.querySelectorAll('div[data-nds-name="main"]').forEach((el, index) => {
    pushCandidate(el.innerText || el.textContent || '', `nds-main-${index}`);
  });

  document.querySelectorAll([
    'div[data-nds-name="main"] .main',
    'div[data-nds-name="main"] p',
    'div[data-nds-name="main"] h1',
    'div[data-nds-name="main"] h2',
    'div[data-nds-name="main"] h3',
    'div[data-nds-name="main"] td',
    'div[data-nds-name="main"] div',
    'div[data-nds-name="main"] span',
  ].join(', ')).forEach((el, index) => {
    pushCandidate(el.innerText || el.textContent || '', `nds-block-${index}`);
  });

  const detailSelectors = [
    'div[data-nds-name="main"]',
    '[class*="mailview" i]',
    '[class*="mail-view" i]',
    '[class*="mailcontent" i]',
    '[class*="mail-content" i]',
    '[class*="mailread" i]',
    '[class*="mail-read" i]',
    '[class*="reader" i]',
    '[role="document"]',
  ];

  document.querySelectorAll(detailSelectors.join(', ')).forEach((el, index) => {
    pushCandidate(el.innerText || el.textContent || '', `detail-${index}`);
  });

  document.querySelectorAll('iframe').forEach((frame, index) => {
    try {
      const frameDoc = frame.contentDocument;
      const frameBody = frameDoc?.body;
      if (!frameBody) return;
      pushCandidate(frameBody.innerText || frameBody.textContent || '', `iframe-${index}`);
    } catch {}
  });

  return candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
}

function getCandidateSignature(candidate) {
  return `${candidate?.source || 'unknown'}:${normalizeText(candidate?.text || '').slice(0, 240)}`;
}

function getMailMetaTokens(meta = {}) {
  return normalizeText(`${meta.sender || ''} ${meta.subject || ''}`)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(token => token.length >= 2);
}

function candidateMatchesMailMeta(candidate, meta = {}) {
  const normalized = normalizeText(candidate?.text || '');
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  const sender = normalizeText(meta.sender || '').toLowerCase();
  if (sender && lower.includes(sender)) {
    return true;
  }

  const tokens = getMailMetaTokens(meta);
  let matchedTokens = 0;
  for (const token of tokens.slice(0, 10)) {
    if (lower.includes(token)) {
      matchedTokens += 1;
      if (matchedTokens >= 2) {
        return true;
      }
    }
  }

  return candidate.score >= 18;
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const signature = getCandidateSignature(candidate);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(candidate);
  }
  return deduped;
}

async function clickMailItemForReading(item) {
  const clickTargets = [
    item.querySelector('span.da0'),
    item.querySelector('.nui-user'),
    item,
  ].filter(Boolean);

  for (const target of clickTargets) {
    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {}

    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));

    try {
      if (typeof target.click === 'function') {
        target.click();
      } else {
        simulateClick(target);
      }
    } catch {
      simulateClick(target);
    }

    await sleep(180);
  }
}

async function extractCodeFromOpenedMail(item, step, meta = {}) {
  const baselineCandidates = collectOpenedMailTextCandidates(meta);
  const baselineSignatures = new Set(baselineCandidates.map(getCandidateSignature));
  let changedAfterOpen = false;

  await clickMailItemForReading(item);
  await sleep(700);

  let bestCandidate = null;
  for (let attempt = 1; attempt <= 24; attempt++) {
    throwIfStopped();
    const candidates = collectOpenedMailTextCandidates(meta);
    const changedCandidates = candidates.filter(candidate => !baselineSignatures.has(getCandidateSignature(candidate)));
    if (changedCandidates.length > 0) {
      changedAfterOpen = true;
    }

    const relatedCandidates = candidates.filter(candidate => candidateMatchesMailMeta(candidate, meta));
    const prioritizedCandidates = dedupeCandidates([
      ...changedCandidates.filter(candidate => candidateMatchesMailMeta(candidate, meta)),
      ...relatedCandidates,
      ...(attempt >= 12 ? changedCandidates : []),
      ...(attempt >= 18 ? candidates : []),
    ]);

    if (!bestCandidate) {
      bestCandidate = prioritizedCandidates[0] || changedCandidates[0] || candidates[0] || null;
    }

    for (const candidate of prioritizedCandidates) {
      const code = extractVerificationCode(candidate.text);
      if (code) {
        log(`Step ${step}: Code found from opened 163 mail body (${candidate.source})`, 'ok');
        return code;
      }
    }

    if (attempt === 4 || attempt === 8 || attempt === 14) {
      await clickMailItemForReading(item);
    }

    await sleep(300);
  }

  if (bestCandidate?.text) {
    log(
      `Step ${step}: Opened 163 mail body ${changedAfterOpen ? 'changed' : 'did not clearly change'} but no code was parsed. Sample (${bestCandidate.source}): ${bestCandidate.text.slice(0, 220)}`,
      'warn'
    );
  }

  return null;
}

async function extractCodeFromMailItem(item, step, meta = {}) {
  const inlineCode = extractVerificationCode(meta.combinedText || '');
  if (inlineCode) {
    return inlineCode;
  }

  log(`Step ${step}: 163 item matched filters but list text had no code. Opening email body...`, 'info');
  return await extractCodeFromOpenedMail(item, step, meta);
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll on 163 Mail (max ${maxAttempts} attempts)`);

  // Click inbox in sidebar to ensure we're in inbox view
  log(`Step ${step}: Waiting for sidebar...`);
  try {
    const inboxLink = await waitForElement('.nui-tree-item-text[title="收件箱"], .nui-tree-item-text[title="Inbox"]', 5000);
    inboxLink.click();
    log(`Step ${step}: Clicked inbox`);
  } catch {
    log(`Step ${step}: Inbox link not found, proceeding...`, 'warn');
  }

  // Wait for mail list to appear
  log(`Step ${step}: Waiting for mail list...`);
  let items = [];
  for (let i = 0; i < 20; i++) {
    items = findMailItems();
    if (items.length > 0) break;
    await sleep(500);
  }

  if (items.length === 0) {
    await refreshInbox();
    await sleep(2000);
    items = findMailItems();
  }

  if (items.length === 0) {
    throw new Error('163 Mail list did not load. Make sure inbox is open.');
  }

  log(`Step ${step}: Mail list loaded, ${items.length} items`);

  // Snapshot existing mail IDs
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling 163 Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
      await sleep(1000);
    }

    const allItems = findMailItems();
    const useFallback = attempt > FALLBACK_AFTER;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';

      if (!useFallback && existingMailIds.has(id)) continue;

      const meta = getMailItemMeta(item);
      const combinedLower = meta.combinedText.toLowerCase();
      const senderMatch = senderFilters.some(f => combinedLower.includes(String(f || '').toLowerCase()));
      const subjectMatch = subjectFilters.some(f => combinedLower.includes(String(f || '').toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = await extractCodeFromMailItem(item, step, meta);
        if (code && !seenCodes.has(code)) {
          seenCodes.add(code);
          persistSeenCodes();
          const source = useFallback && existingMailIds.has(id) ? 'fallback' : 'new';
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${meta.subject.slice(0, 40)})`, 'ok');

          // Delete this email via right-click menu, WAIT for it to finish before returning
          await deleteEmail(item, step);
          // Extra wait to ensure deletion is processed
          await sleep(1000);

          return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
        } else if (code && seenCodes.has(code)) {
          log(`Step ${step}: Skipping already-seen code: ${code}`, 'info');
        }
      }
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new emails after ${FALLBACK_AFTER} attempts, falling back to first match`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found on 163 Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check inbox manually.'
  );
}

// ============================================================
// Delete Email via Right-Click Menu
// ============================================================

async function deleteEmail(item, step) {
  try {
    log(`Step ${step}: Deleting email...`);

    // Strategy 1: Click the trash icon inside the mail item
    // Each mail item has: <b class="nui-ico nui-ico-delete" title="删除邮件" sign="trash">
    // These icons appear on hover, so we trigger mouseover first
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(300);

    const trashIcon = item.querySelector('[sign="trash"], .nui-ico-delete, [title="删除邮件"], [title="Delete email"], [title*="delete" i]');
    if (trashIcon) {
      trashIcon.click();
      log(`Step ${step}: Clicked trash icon`, 'ok');
      await sleep(1500);

      // Check if item disappeared (confirm deletion)
      const stillExists = document.getElementById(item.id);
      if (!stillExists || stillExists.style.display === 'none') {
        log(`Step ${step}: Email deleted successfully`);
      } else {
        log(`Step ${step}: Email may not have been deleted, item still visible`, 'warn');
      }
      return;
    }

    // Strategy 2: Select checkbox then click toolbar delete button
    log(`Step ${step}: Trash icon not found, trying checkbox + toolbar delete...`);
    const checkbox = item.querySelector('[sign="checkbox"], .nui-chk');
    if (checkbox) {
      checkbox.click();
      await sleep(300);

      // Click toolbar delete button
      const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
      for (const btn of toolbarBtns) {
        const text = btn.textContent.replace(/\s/g, '');
        if (/删除|delete/i.test(text)) {
          btn.closest('.nui-btn').click();
          log(`Step ${step}: Clicked toolbar delete`, 'ok');
          await sleep(1500);
          return;
        }
      }
    }

    log(`Step ${step}: Could not delete email (no delete button found)`, 'warn');
  } catch (err) {
    log(`Step ${step}: Failed to delete email: ${err.message}`, 'warn');
  }
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try toolbar "刷 新" button
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
  for (const btn of toolbarBtns) {
    const text = btn.textContent.replace(/\s/g, '');
    if (/^刷新$|^refresh$/i.test(text)) {
      btn.closest('.nui-btn').click();
      console.log(MAIL163_PREFIX, 'Clicked "刷新" button');
      await sleep(800);
      return;
    }
  }

  // Fallback: click sidebar "收 信"
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    const text = btn.textContent.replace(/\s/g, '');
    if (/收信|inbox|receive/i.test(text)) {
      btn.click();
      console.log(MAIL163_PREFIX, 'Clicked "收信" button');
      await sleep(800);
      return;
    }
  }

  console.log(MAIL163_PREFIX, 'Could not find refresh button');
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  const matchCnExtended = text.match(
    /(?:输入此(?:临时)?验证码(?:以继续)?|输入此(?:临时)?代码(?:以继续)?|临时验证码|登录代码|验证码|代码为)[^\d]{0,40}(\d{6})/
  );
  if (matchCnExtended) return matchCnExtended[1];

  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEnExtended = text.match(
    /(?:enter this (?:temporary )?(?:verification )?code(?: to continue)?|if that was you,\s*enter this code)[^\d]{0,40}(\d{6})/i
  );
  if (matchEnExtended) return matchEnExtended[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

} // end of isTopFrame else block
