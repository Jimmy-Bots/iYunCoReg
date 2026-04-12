// content/spamok-mail.js — Content script for SpamOK mailbox polling (steps 4, 7)
// Injected dynamically on https://spamok.com/<mailbox>

const SPAMOK_PREFIX = '[MultiPage:spamok-mail]';
const isTopFrame = window === window.top;
const SEEN_SPAMOK_MAIL_IDS_KEY = 'seenSpamokMailIds';

console.log(SPAMOK_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(SPAMOK_PREFIX, 'Skipping child frame');
} else {

let seenMailIds = new Set();

async function loadSeenMailIds() {
  try {
    const data = await chrome.storage.session.get(SEEN_SPAMOK_MAIL_IDS_KEY);
    if (Array.isArray(data[SEEN_SPAMOK_MAIL_IDS_KEY])) {
      seenMailIds = new Set(data[SEEN_SPAMOK_MAIL_IDS_KEY]);
      console.log(SPAMOK_PREFIX, `Loaded ${seenMailIds.size} previously seen mail ids`);
    }
  } catch (err) {
    console.warn(SPAMOK_PREFIX, 'Session storage unavailable, using in-memory seen mail ids:', err?.message || err);
  }
}

async function persistSeenMailIds() {
  try {
    await chrome.storage.session.set({ [SEEN_SPAMOK_MAIL_IDS_KEY]: [...seenMailIds] });
  } catch (err) {
    console.warn(SPAMOK_PREFIX, 'Could not persist seen mail ids, continuing in-memory only:', err?.message || err);
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
  const preview = normalizeText(mail.preview);
  const combined = normalizeText(mail.combinedText);
  const targetLocal = normalizeText((targetEmail || '').split('@')[0]);

  const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || combined.includes(f.toLowerCase()));
  const subjectMatch = subjectFilters.some(f => subject.includes(f.toLowerCase()) || preview.includes(f.toLowerCase()) || combined.includes(f.toLowerCase()));
  const mailboxMatch = Boolean(targetLocal) && combined.includes(targetLocal);
  const code = extractVerificationCode(mail.combinedText);
  const keywordMatch = /openai|chatgpt|verify|verification|confirm|login|验证码|代码/.test(combined);

  if (mailboxMatch) return { matched: true, mailboxMatch, code };
  if (senderMatch || subjectMatch) return { matched: true, mailboxMatch: false, code };
  if (code && keywordMatch) return { matched: true, mailboxMatch: false, code };
  return { matched: false, mailboxMatch: false, code };
}

function parseSpamokRows(root = document) {
  const rows = Array.from(root.querySelectorAll('table.table tbody tr'));
  return rows.map((row, index) => {
    const cells = row.querySelectorAll('td');
    const mainCell = cells[0];
    const strong = mainCell?.querySelector('strong');
    const sender = strong?.textContent?.trim() || '';
    const senderBlock = strong?.closest('div') || null;
    const subject = senderBlock?.nextElementSibling?.textContent?.trim() || '';
    const preview = senderBlock?.nextElementSibling?.nextElementSibling?.textContent?.trim() || '';
    const received = cells[1]?.textContent?.trim() || '';
    const combinedText = [sender, subject, preview, received].filter(Boolean).join(' ');
    const mailId = `${normalizeText(sender)}|${normalizeText(subject)}|${normalizeText(preview)}|${normalizeText(received)}|${index}`;

    return {
      row,
      sender,
      subject,
      preview,
      received,
      combinedText,
      mailId,
    };
  });
}

async function findMatchingSpamokMail(rows, senderFilters, subjectFilters, targetEmail, options = {}) {
  const { existingMailIds = null, allowExisting = true } = options;

  for (const mail of rows) {
    if (seenMailIds.has(mail.mailId)) continue;
    if (!allowExisting && existingMailIds?.has(mail.mailId)) continue;

    const match = rowMatchesFilters(mail, senderFilters, subjectFilters, targetEmail);
    if (!match.matched) continue;

    const code = match.code || extractVerificationCode(mail.combinedText);
    if (!code) continue;

    seenMailIds.add(mail.mailId);
    await persistSeenMailIds();

    log(
      `SpamOK: Matched mail (sender: ${mail.sender || 'unknown'}, subject: ${(mail.subject || '').slice(0, 60)}, code: ${code})`,
      'ok'
    );

    return {
      ok: true,
      code,
      emailTimestamp: Date.now(),
      mailId: mail.mailId,
    };
  }

  return null;
}

async function fetchMailboxDocument() {
  const response = await fetch(location.href, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`SpamOK mailbox request failed with status ${response.status}`);
  }

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc;
}

async function handlePollEmail(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    maxAttempts = 20,
    intervalMs = 3000,
    targetEmail = '',
    waitNewAttempts = 2,
  } = payload || {};
  const normalizedWaitNewAttempts = Number.isFinite(Number(waitNewAttempts))
    ? Math.min(120, Math.max(0, Number(waitNewAttempts)))
    : 2;

  log(`Step ${step}: Starting email poll on SpamOK mailbox page (max ${maxAttempts} attempts)`);

  try {
    await waitForElement('table.table, table.table tbody tr', 15000);
    log(`Step ${step}: SpamOK mailbox page loaded`);
  } catch {
    throw new Error('SpamOK mailbox page did not load.');
  }

  const initialLiveRows = parseSpamokRows(document);
  const existingMailIds = new Set(initialLiveRows.map(mail => mail.mailId));
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing SpamOK emails from live page DOM`);
  log(`Step ${step}: SpamOK will wait ${normalizedWaitNewAttempts} attempt(s) for new mail before falling back to existing rows`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling SpamOK mailbox... attempt ${attempt}/${maxAttempts}`);
    const allowExisting = attempt > normalizedWaitNewAttempts;

    const liveRows = parseSpamokRows(document);
    if (liveRows.length > 0) {
      log(`Step ${step}: Found ${liveRows.length} SpamOK rows in live page DOM`);
      const liveResult = await findMatchingSpamokMail(
        liveRows,
        senderFilters,
        subjectFilters,
        targetEmail,
        { existingMailIds, allowExisting }
      );
      if (liveResult) {
        log(`Step ${step}: Code found from live SpamOK page DOM: ${liveResult.code}`, 'ok');
        return liveResult;
      }
    } else {
      log(`Step ${step}: No SpamOK rows found in live page DOM on attempt ${attempt}`, 'warn');
    }

    try {
      const doc = await fetchMailboxDocument();
      const fetchedRows = parseSpamokRows(doc);
      log(`Step ${step}: Found ${fetchedRows.length} SpamOK rows in fetched mailbox HTML`);

      const fetchedResult = await findMatchingSpamokMail(
        fetchedRows,
        senderFilters,
        subjectFilters,
        targetEmail,
        { existingMailIds, allowExisting }
      );
      if (fetchedResult) {
        log(`Step ${step}: Code found from fetched SpamOK mailbox HTML: ${fetchedResult.code}`, 'ok');
        return fetchedResult;
      }
    } catch (err) {
      log(`Step ${step}: SpamOK HTML fetch fallback failed: ${err.message}`, 'warn');
    }

    if (normalizedWaitNewAttempts > 0 && attempt === normalizedWaitNewAttempts) {
      log(`Step ${step}: No new SpamOK emails yet, falling back to existing mailbox rows on the next attempt`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No matching verification email found in SpamOK mailbox after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check the mailbox page manually.'
  );
}

} // end of isTopFrame else block
