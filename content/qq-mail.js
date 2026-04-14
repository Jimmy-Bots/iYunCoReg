// content/qq-mail.js — Content script for QQ Mail (steps 4, 7)
// Injected on: mail.qq.com, wx.mail.qq.com
// NOTE: all_frames: true
//
// Strategy for avoiding stale codes:
// 1. On poll start, snapshot all existing mail IDs as "old"
// 2. On each poll cycle, refresh inbox and look for NEW items (not in snapshot)
// 3. Only extract codes from NEW items that match sender/subject filters

const QQ_MAIL_PREFIX = '[MultiPage:qq-mail]';
const isTopFrame = window === window.top;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    if (!isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }
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
    return true; // async response
  }
});

// ============================================================
// Get all current mail IDs from the list
// ============================================================

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

function findVisibleDeleteButton() {
  const buttons = document.querySelectorAll('.ui-toolbar-ellipsis-btns .xmail-ui-btn');
  for (const button of buttons) {
    const text = (button.querySelector('.ui-btn-text')?.textContent || '').trim();
    const title = (button.getAttribute('title') || button.getAttribute('aria-label') || '').trim();
    const style = window.getComputedStyle(button);
    if ((/^(删除|delete)$/i.test(text) || /删除|delete/i.test(title))
      && style.visibility !== 'hidden'
      && style.display !== 'none') {
      return button;
    }
  }
  return null;
}

async function ensureMailSelected(item) {
  if (item.classList.contains('mail-item-checked')) return;

  const checkbox = item.querySelector('.mail-checkbox, .xmail-ui-checkbox');
  if (checkbox) {
    simulateClick(checkbox);
  } else {
    simulateClick(item);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    throwIfStopped();
    if (item.classList.contains('mail-item-checked')) return;
    await sleep(100);
  }

  throw new Error('Timed out while selecting QQ Mail item for deletion.');
}

async function deleteMailItem(item, mailId) {
  await ensureMailSelected(item);
  await sleep(250);

  const deleteBtn = findVisibleDeleteButton();
  if (!deleteBtn) {
    throw new Error('Could not find QQ Mail delete button.');
  }

  simulateClick(deleteBtn);
  log(`QQ Mail: Delete clicked for ${mailId}`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    throwIfStopped();
    const stillExists = document.querySelector(`.mail-list-page-item[data-mailid="${CSS.escape(mailId)}"]`);
    if (!stillExists) return;
    await sleep(150);
  }

  throw new Error(`QQ Mail item ${mailId} did not disappear after delete.`);
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);

  // Wait for mail list to load
  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`Step ${step}: Mail list loaded`);
  } catch {
    throw new Error('Mail list did not load. Make sure QQ Mail inbox is open.');
  }

  // Step 1: Snapshot existing mail IDs BEFORE we start waiting for new email
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails as "old"`);

  // Fallback after just 3 attempts (~10s). In practice, the email is usually
  // already in the list but has the same mailid (page was already open).
  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling QQ Mail... attempt ${attempt}/${maxAttempts}`);

    // Refresh inbox (skip on first attempt, list is fresh)
    if (attempt > 1) {
      await refreshInbox();
      await sleep(800);
    }

    const allItems = document.querySelectorAll('.mail-list-page-item[data-mailid]');
    const useFallback = attempt > FALLBACK_AFTER;

    // Phase 1 (attempt 1~3): only look at NEW emails (not in snapshot)
    // Phase 2 (attempt 4+): fallback to first matching email in list
    for (const item of allItems) {
      const mailId = item.getAttribute('data-mailid');

      if (!useFallback && existingMailIds.has(mailId)) continue;

      const sender = (item.querySelector('.cmp-account-nick')?.textContent || '').toLowerCase();
      const subject = (item.querySelector('.mail-subject')?.textContent || '').toLowerCase();
      const digest = item.querySelector('.mail-digest')?.textContent || '';

      const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()));
      const subjectMatch = subjectFilters.some(f => subject.includes(f.toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(subject + ' ' + digest);
        if (code) {
          const source = useFallback && existingMailIds.has(mailId) ? 'fallback-first-match' : 'new';
          try {
            await deleteMailItem(item, mailId);
            log(`Step ${step}: Deleted QQ Mail item ${mailId} after extracting code`, 'ok');
          } catch (deleteErr) {
            log(`Step ${step}: QQ Mail delete failed for ${mailId}: ${deleteErr.message}`, 'warn');
          }
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${subject.slice(0, 40)})`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now(), mailId };
        }
      }
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new emails after ${FALLBACK_AFTER} attempts, falling back to first matching email`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check QQ Mail manually. Email may be delayed or in spam folder.'
  );
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try multiple strategies to refresh the mail list

  // Strategy 1: Click any visible refresh button
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"], [title*="Refresh" i], [aria-label*="Refresh" i]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    console.log(QQ_MAIL_PREFIX, 'Clicked refresh button');
    await sleep(500);
    return;
  }

  // Strategy 2: Click inbox in sidebar to reload list
  const sidebarInbox = document.querySelector('a[href*="inbox"], [class*="folder-item"][class*="inbox"], [title="收件箱"], [title="Inbox"], [aria-label*="Inbox" i]');
  if (sidebarInbox) {
    simulateClick(sidebarInbox);
    console.log(QQ_MAIL_PREFIX, 'Clicked sidebar inbox');
    await sleep(500);
    return;
  }

  // Strategy 3: Click the folder name in toolbar
  const folderName = document.querySelector('.toolbar-folder-name');
  if (folderName) {
    simulateClick(folderName);
    console.log(QQ_MAIL_PREFIX, 'Clicked toolbar folder name');
    await sleep(500);
  }
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  // Pattern 1: Chinese format "代码为 370794" or "验证码...370794"
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  // Pattern 2: English format "code is 370794" or "code: 370794"
  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  // Pattern 3: standalone 6-digit number (first occurrence)
  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}
