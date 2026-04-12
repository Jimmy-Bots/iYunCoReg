// content/inbucket-mail.js — Content script for Inbucket polling (steps 4, 7)
// Injected dynamically on the configured Inbucket host
//
// Supported page:
// - /m/<mailbox>/

const INBUCKET_PREFIX = '[MultiPage:inbucket-mail]';
const isTopFrame = window === window.top;
const SEEN_MAIL_IDS_KEY = 'seenInbucketMailIds';

console.log(INBUCKET_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(INBUCKET_PREFIX, 'Skipping child frame');
} else {

let seenMailIds = new Set();

async function loadSeenMailIds() {
  try {
    const data = await chrome.storage.session.get(SEEN_MAIL_IDS_KEY);
    if (Array.isArray(data[SEEN_MAIL_IDS_KEY])) {
      seenMailIds = new Set(data[SEEN_MAIL_IDS_KEY]);
      console.log(INBUCKET_PREFIX, `Loaded ${seenMailIds.size} previously seen mail ids`);
    }
  } catch (err) {
    console.warn(INBUCKET_PREFIX, 'Session storage unavailable, using in-memory seen mail ids:', err?.message || err);
  }
}

async function persistSeenMailIds() {
  try {
    await chrome.storage.session.set({ [SEEN_MAIL_IDS_KEY]: [...seenMailIds] });
  } catch (err) {
    console.warn(INBUCKET_PREFIX, 'Could not persist seen mail ids, continuing in-memory only:', err?.message || err);
  }
}

loadSeenMailIds();

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

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function rowMatchesFilters(mail, senderFilters, subjectFilters, targetEmail) {
  const sender = normalizeText(mail.sender);
  const subject = normalizeText(mail.subject);
  const mailbox = normalizeText(mail.mailbox);
  const combined = normalizeText(mail.combinedText);
  const targetLocal = normalizeText((targetEmail || '').split('@')[0]);

  const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || combined.includes(f.toLowerCase()));
  const subjectMatch = subjectFilters.some(f => subject.includes(f.toLowerCase()) || combined.includes(f.toLowerCase()));
  const mailboxMatch = Boolean(targetLocal) && mailbox.includes(targetLocal);
  const forwardedAlias = /forward(?:ed)?\s*by/i.test(mail.combinedText);
  const code = extractVerificationCode(mail.combinedText);
  const keywordMatch = /openai|chatgpt|verify|verification|confirm|login|验证码|代码/.test(combined);

  if (mailboxMatch) return { matched: true, mailboxMatch, code };
  if (senderMatch || subjectMatch) return { matched: true, mailboxMatch: false, code };
  if (code && (forwardedAlias || keywordMatch)) return { matched: true, mailboxMatch: false, code };

  return { matched: false, mailboxMatch: false, code };
}

function findMailboxEntries() {
  return document.querySelectorAll('.message-list-entry');
}

function getMailboxEntryId(entry, index = 0) {
  const explicitId = entry.getAttribute('data-id') || entry.dataset?.id || '';
  if (explicitId) return explicitId;

  const subject = entry.querySelector('.subject')?.textContent?.trim() || '';
  const sender = entry.querySelector('.from')?.textContent?.trim() || '';
  const dateText = entry.querySelector('.date')?.textContent?.trim() || '';

  return `mailbox:${index}:${normalizeText(subject)}|${normalizeText(sender)}|${normalizeText(dateText)}`;
}

function parseMailboxEntry(entry, index = 0) {
  const subject = entry.querySelector('.subject')?.textContent?.trim() || '';
  const sender = entry.querySelector('.from')?.textContent?.trim() || '';
  const dateText = entry.querySelector('.date')?.textContent?.trim() || '';
  const combinedText = [subject, sender, dateText].filter(Boolean).join(' ');

  return {
    entry,
    dateText,
    sender,
    mailbox: '',
    subject,
    unread: entry.classList.contains('unseen'),
    combinedText,
    mailId: getMailboxEntryId(entry, index),
  };
}

function getCurrentMailboxIds() {
  const ids = new Set();
  Array.from(findMailboxEntries()).forEach((entry, index) => {
    ids.add(getMailboxEntryId(entry, index));
  });
  return ids;
}

async function refreshMailbox() {
  const refreshButton = findRefreshButton();
  if (!refreshButton) {
    log('Inbucket: Refresh button not found, skipping manual refresh', 'warn');
    return false;
  }

  const label = [
    refreshButton.getAttribute('aria-label'),
    refreshButton.getAttribute('title'),
    refreshButton.getAttribute('alt'),
    refreshButton.textContent,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  simulateClick(refreshButton);
  log(`Inbucket: Triggered mailbox refresh via "${label || 'refresh button'}"`);
  await sleep(1200);
  return true;
}

function findRefreshButton() {
  const directSelector = [
    'button[alt="Refresh Mailbox"]',
    'button[aria-label*="Refresh" i]',
    'button[title*="Refresh" i]',
    'button[aria-label*="Mailbox" i]',
    'button[title*="Mailbox" i]',
    'button:has(i.fa-sync)',
    'button:has(i.fa-sync-alt)',
    'button:has(i.fa-redo)',
    'button:has(i.fa-rotate-right)',
  ].join(', ');

  const directMatch = document.querySelector(directSelector);
  if (directMatch) return directMatch;

  const iconMatch = Array.from(document.querySelectorAll('button')).find((button) => button.querySelector(
    'i.fa-sync, i.fa-sync-alt, i.fa-redo, i.fa-rotate-right'
  ));
  if (iconMatch) return iconMatch;

  const textMatch = Array.from(document.querySelectorAll('button, [role="button"]')).find((button) => {
    const text = normalizeText(
      [
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('alt'),
      ]
        .filter(Boolean)
        .join(' ')
    );

    return /refresh|reload|刷新/.test(text) && /mail|mailbox|message|收件/i.test(text);
  });

  return textMatch || null;
}

async function openMailboxEntry(entry) {
  simulateClick(entry);

  for (let i = 0; i < 20; i++) {
    if (entry.classList.contains('selected') || document.querySelector('.message-header, .message-body, .button-bar')) {
      return;
    }
    await sleep(150);
  }
}

async function deleteCurrentMailboxMessage(step) {
  try {
    const deleteButton = await waitForElement('.button-bar button.danger', 5000);
    simulateClick(deleteButton);
    log(`Step ${step}: Deleted mailbox message`, 'ok');
    await sleep(1200);
  } catch (err) {
    log(`Step ${step}: Failed to delete mailbox message: ${err.message}`, 'warn');
  }
}

async function handleMailboxPollEmail(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    maxAttempts = 20,
    intervalMs = 3000,
  } = payload || {};

  log(`Step ${step}: Starting email poll on Inbucket mailbox page (max ${maxAttempts} attempts)`);

  try {
    await waitForElement('.message-list, .message-list-entry', 15000);
    log(`Step ${step}: Mailbox page loaded`);
  } catch {
    throw new Error('Inbucket mailbox page did not load. Make sure /m/<mailbox>/ is open.');
  }

  const existingMailIds = getCurrentMailboxIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing mailbox messages`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling Inbucket mailbox... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      const refreshed = await refreshMailbox();
      if (!refreshed) {
        log(`Step ${step}: Mailbox refresh button was not found on attempt ${attempt}`, 'warn');
      }
    }

    const entries = Array.from(findMailboxEntries()).map(parseMailboxEntry);
    const useFallback = attempt > FALLBACK_AFTER;
    const candidates = [];

    for (const mail of entries) {
      if (!mail.unread) continue;
      if (seenMailIds.has(mail.mailId)) continue;
      if (!useFallback && existingMailIds.has(mail.mailId)) continue;

      const match = rowMatchesFilters(mail, senderFilters, subjectFilters, '');
      if (!match.matched) continue;

      candidates.push({ ...mail, code: match.code });
    }

    for (const mail of candidates) {
      const code = mail.code || extractVerificationCode(mail.combinedText);
      if (!code) continue;

      await openMailboxEntry(mail.entry);
      await deleteCurrentMailboxMessage(step);

      seenMailIds.add(mail.mailId);
      await persistSeenMailIds();

      const source = existingMailIds.has(mail.mailId) ? 'fallback' : 'new';
      log(
        `Step ${step}: Code found: ${code} (${source}, sender: ${mail.sender || 'unknown'}, subject: ${(mail.subject || '').slice(0, 60)})`,
        'ok'
      );

      return {
        ok: true,
        code,
        emailTimestamp: Date.now(),
        mailId: mail.mailId,
      };
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new mailbox messages yet, falling back to older matching messages`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No matching verification email found in Inbucket mailbox after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check the mailbox page manually.'
  );
}

async function handlePollEmail(step, payload) {
  if (!location.pathname.startsWith('/m/')) {
    throw new Error('Inbucket now only supports mailbox pages like /m/<mailbox>/.');
  }
  return handleMailboxPollEmail(step, payload);
}

} // end of isTopFrame else block
