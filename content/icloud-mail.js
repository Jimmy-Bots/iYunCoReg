// content/icloud-mail.js — Content script for iCloud Mail (steps 4, 7)
// Injected dynamically on: www.icloud.com/mail/ or www.icloud.com.cn/mail/
//
// Strategy:
// 1. Ensure the inbox list is visible
// 2. Snapshot currently visible thread signatures
// 3. Refresh the list and prioritize unread/new matching threads
// 4. Extract the verification code directly from the thread row preview / aria-label

const ICLOUD_MAIL_PREFIX = '[MultiPage:icloud-mail]';
const ICLOUD_MAIL_GUARD_KEY = '__MULTIPAGE_ICLOUD_MAIL_INITIALIZED';

if (window[ICLOUD_MAIL_GUARD_KEY]) {
  console.log(ICLOUD_MAIL_PREFIX, 'Already initialized on', location.href);
} else {
window[ICLOUD_MAIL_GUARD_KEY] = true;

const isTopFrame = window === window.top;
console.log(ICLOUD_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'POLL_EMAIL') return;

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
  return true;
});

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isVisible(element) {
  if (!element) return false;
  try {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
  } catch {}
  return element.getClientRects().length > 0;
}

function readAttr(el, name) {
  try {
    return el?.getAttribute?.(name) || '';
  } catch {
    return '';
  }
}

const ICLOUD_DELETE_BUTTON_PATTERN = /(?:删除邮件|删除|trash message|trash email|move to trash|delete message|delete email|\btrash\b|\bdelete\b)/i;
const ICLOUD_DELETE_MENU_PATTERN = /(?:^删除$|删除邮件|移到废纸篓|trash message|trash email|move to trash|delete message|delete email|^trash$|^delete$)/i;
const ICLOUD_INBOX_PATTERN = /(?:收件箱|inbox)/i;
const ICLOUD_NO_SELECTION_PATTERN = /(?:未选择邮件|no message selected)/i;

let deepRootCacheAt = 0;
let deepRootCache = [];

function toSelectorList(selectors) {
  if (Array.isArray(selectors)) return selectors.filter(Boolean);
  return String(selectors || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function elementMatchesAnySelector(element, selectors) {
  if (!element?.matches) return false;
  for (const selector of toSelectorList(selectors)) {
    try {
      if (element.matches(selector)) return true;
    } catch {}
  }
  return false;
}

function getDeepSearchRoots(root = document) {
  const now = Date.now();
  if (root === document && deepRootCache.length > 0 && now - deepRootCacheAt < 1200) {
    return deepRootCache;
  }

  const roots = [];
  const queue = [root];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    roots.push(current);

    if (current.nodeType === Node.ELEMENT_NODE) {
      try {
        if (current.shadowRoot && !seen.has(current.shadowRoot)) {
          queue.push(current.shadowRoot);
        }
      } catch {}

      if (current.tagName === 'IFRAME') {
        try {
          const frameDocument = current.contentDocument;
          if (frameDocument && !seen.has(frameDocument)) {
            queue.push(frameDocument);
          }
        } catch {}
      }
    }

    let descendants = [];
    try {
      descendants = Array.from(current.querySelectorAll?.('*') || []);
    } catch {}

    for (const element of descendants) {
      try {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          queue.push(element.shadowRoot);
        }
      } catch {}

      if (element.tagName === 'IFRAME') {
        try {
          const frameDocument = element.contentDocument;
          if (frameDocument && !seen.has(frameDocument)) {
            queue.push(frameDocument);
          }
        } catch {}
      }
    }
  }

  if (root === document) {
    deepRootCacheAt = now;
    deepRootCache = roots;
  }

  return roots;
}

function deepQueryAll(selectors, root = document) {
  const selectorList = toSelectorList(selectors);
  const results = [];
  const seen = new Set();

  if (root?.nodeType === Node.ELEMENT_NODE && elementMatchesAnySelector(root, selectorList)) {
    seen.add(root);
    results.push(root);
  }

  for (const searchRoot of getDeepSearchRoots(root)) {
    for (const selector of selectorList) {
      let matches = [];
      try {
        matches = Array.from(searchRoot.querySelectorAll?.(selector) || []);
      } catch {}

      for (const element of matches) {
        if (!element || seen.has(element)) continue;
        seen.add(element);
        results.push(element);
      }
    }
  }

  return results;
}

function deepQueryFirst(selectors, root = document) {
  const selectorList = toSelectorList(selectors);

  if (root?.nodeType === Node.ELEMENT_NODE && elementMatchesAnySelector(root, selectorList)) {
    return root;
  }

  for (const searchRoot of getDeepSearchRoots(root)) {
    for (const selector of selectorList) {
      try {
        const match = searchRoot.querySelector?.(selector);
        if (match) return match;
      } catch {}
    }
  }

  return null;
}

function composedClosest(element, selectors) {
  const selectorList = toSelectorList(selectors);
  let current = element;

  while (current) {
    if (elementMatchesAnySelector(current, selectorList)) {
      return current;
    }

    const parentElement = current.parentElement;
    if (parentElement) {
      current = parentElement;
      continue;
    }

    const root = current.getRootNode?.();
    current = root?.host || null;
  }

  return null;
}

function getMailRowCandidates() {
  const selectors = [
    '.thread-list-item[role="treeitem"]',
    '.thread-list-item',
    '.thread-list-inner [role="treeitem"]',
    '.thread-list [role="treeitem"]',
    '[data-indexpath][role="treeitem"]',
    '[data-indexpath]',
    '.thread-details',
    '.thread-subject',
    '.thread-preview',
    '[role="treeitem"][aria-label*="openai" i]',
    '[role="treeitem"][aria-label*="chatgpt" i]',
    '[aria-label*="openai" i]',
    '[aria-label*="chatgpt" i]',
  ];

  const rows = [];
  const seen = new Set();

  for (const element of deepQueryAll(selectors)) {
    const row =
      composedClosest(element, ['.thread-list-item', '[data-indexpath]', '[role="treeitem"]'])
      || composedClosest(element, '.thread-details')
      || element;
    if (!row || seen.has(row)) continue;
    seen.add(row);
    rows.push(row);
  }

  return rows;
}

function getVisibleMailRows() {
  const rows = getMailRowCandidates();
  const visibleRows = rows.filter(isVisible);
  return visibleRows.length > 0 ? visibleRows : rows;
}

function hasMailboxSurface() {
  if (deepQueryFirst('.mailbox-list-item[role="option"]')) return true;
  if (deepQueryFirst('.thread-list-item[role="treeitem"]')) return true;
  if (deepQueryFirst('.thread-list, .thread-list-actual, .thread-list-title')) return true;
  if (deepQueryFirst('.mailbox-list-pane, .thread-list-pane, .thread-detail-pane, .conversation-list-item-wrapper')) return true;
  if (deepQueryFirst('#app-body, #root, ui-main-pane, ui-split-container')) {
    const title = normalizeText(document.title);
    if (/icloud\s*(?:邮件|mail)/i.test(title)) return true;
    if (location.pathname.startsWith('/mail')) return true;
  }
  if (deepQueryFirst('[aria-label="邮箱"], [aria-label="Mailboxes"], [aria-label="收件箱"], [aria-label="Inbox"]')) return true;
  if (/icloud\s*(?:邮件|mail)/i.test(normalizeText(document.title))) return true;
  if (/^邮件$|^mail$/i.test(normalizeText(document.title))) return true;
  return false;
}

function findMailLauncherEntry() {
  const candidates = deepQueryAll([
    'a[href*="/mail"]',
    'a[href*="#mail"]',
    '[role="button"][aria-label="邮件"]',
    '[role="button"][aria-label="Mail"]',
    '[title="邮件"]',
    '[title="Mail"]',
    '[aria-label="邮件"]',
    '[aria-label="Mail"]',
  ]);

  return candidates.find(candidate => isVisible(candidate)) || null;
}

function getRowText(row, selector) {
  return normalizeText(deepQueryFirst(selector, row)?.textContent || '');
}

function extractMailMeta(row) {
  const sender = getRowText(row, '.thread-participants');
  const subject = getRowText(row, '.thread-subject');
  const preview = getRowText(row, '.thread-preview');
  const timestamp = getRowText(row, '.thread-timestamp');
  const ariaLabel = normalizeText(readAttr(row, 'aria-label'));
  const itemText = normalizeText(row.innerText || row.textContent || '');
  const combinedText = normalizeText([
    sender,
    subject,
    preview,
    timestamp,
    ariaLabel,
    itemText,
  ].join(' '));

  return {
    sender,
    subject,
    preview,
    timestamp,
    ariaLabel,
    combinedText,
    unread: Boolean(deepQueryFirst('.adornment-unread', row)) || /\b(?:未读|unread)\b/i.test(ariaLabel),
  };
}

function getMailSignature(meta) {
  return normalizeText([
    meta.sender,
    meta.subject,
    meta.preview,
    meta.timestamp,
    meta.ariaLabel,
  ].join(' | '));
}

function getCurrentMailSignatures() {
  const signatures = new Set();
  for (const row of getVisibleMailRows()) {
    const signature = getMailSignature(extractMailMeta(row));
    if (signature) signatures.add(signature);
  }
  return signatures;
}

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

function rowMatchesFilters(meta, senderFilters, subjectFilters) {
  const senderText = `${meta.sender} ${meta.ariaLabel} ${meta.combinedText}`.toLowerCase();
  const subjectText = `${meta.subject} ${meta.preview} ${meta.ariaLabel} ${meta.combinedText}`.toLowerCase();
  const senderMatch = senderFilters.some(filter => senderText.includes(String(filter || '').toLowerCase()));
  const subjectMatch = subjectFilters.some(filter => subjectText.includes(String(filter || '').toLowerCase()));
  return senderMatch || subjectMatch;
}

function clickElement(target, options = {}) {
  const { preferNestedButton = true } = options;
  const actualTarget = preferNestedButton ? (deepQueryFirst('button', target) || target) : target;
  try {
    actualTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}

  try {
    actualTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    actualTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    actualTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    actualTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  } catch {}

  try {
    if (typeof actualTarget.click === 'function') {
      actualTarget.click();
      return;
    }
  } catch {}

  simulateClick(actualTarget);
}

function getElementClickPoint(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect) {
    return { clientX: 0, clientY: 0 };
  }

  return {
    clientX: Math.round(rect.left + Math.max(4, Math.min(rect.width - 4, rect.width / 2))),
    clientY: Math.round(rect.top + Math.max(4, Math.min(rect.height - 4, rect.height / 2))),
  };
}

function dispatchRealisticPrimaryClick(target) {
  if (!target) return;

  const point = getElementClickPoint(target);
  const base = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    button: 0,
    clientX: point.clientX,
    clientY: point.clientY,
  };

  try {
    target.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 }));
  } catch {}

  try {
    target.focus?.();
  } catch {}

  try {
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  } catch {}

  try {
    target.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  } catch {}

  try {
    target.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  } catch {}

  try {
    if (typeof target.click === 'function') {
      target.click();
      return;
    }
  } catch {}

  simulateClick(target);
}

function getMailRowClickTarget(row) {
  return deepQueryFirst([
    '.selection-background',
    '.thread-list-item',
    '.content-container',
    '.thread-details',
    '.thread-header',
    '.thread-subject',
    '.thread-preview',
  ], row) || row;
}

function getMailRowClickTargets(row) {
  const candidates = [
    deepQueryFirst('.selection-background', row),
    row,
    deepQueryFirst('.content-container', row),
    deepQueryFirst('.thread-details', row),
    deepQueryFirst('.thread-subject', row),
    deepQueryFirst('.thread-preview', row),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function getMailTreeRoot(row) {
  return composedClosest(row, ['.thread-list-inner[role="tree"]', '[role="tree"]']);
}

function hoverElement(target) {
  if (!target) return;

  const point = getElementClickPoint(target);
  const base = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 0,
    button: 0,
    buttons: 0,
    clientX: point.clientX,
    clientY: point.clientY,
  };

  try {
    target.dispatchEvent(new MouseEvent('mouseover', base));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
    target.dispatchEvent(new MouseEvent('mousemove', base));
  } catch {}
}

function isElementDisabled(element) {
  if (!element) return true;

  const ariaDisabled = readAttr(element, 'aria-disabled');
  if (ariaDisabled === 'true') return true;

  if ('disabled' in element && element.disabled) return true;

  const nestedButton = deepQueryFirst('button', element);
  if (nestedButton?.disabled) return true;

  return false;
}

function isPotentiallyVisibleAction(element) {
  if (!element) return false;
  if (isVisible(element)) return true;

  const nestedButton = deepQueryFirst('button', element);
  if (nestedButton && isVisible(nestedButton)) return true;

  const rect = nestedButton?.getBoundingClientRect?.();
  if (rect && rect.width > 0 && rect.height > 0) return true;

  return false;
}

function getActionCandidates() {
  const selectors = [
    'ui-button',
    'ui-toggle-button',
    '[role="button"]',
    'button',
  ];

  const candidates = [];
  const seen = new Set();

  for (const element of deepQueryAll(selectors)) {
    if (!element || seen.has(element)) continue;
    seen.add(element);
    candidates.push(element);
  }

  return candidates;
}

function matchActionLabel(element, pattern) {
  const text = normalizeText([
    readAttr(element, 'title'),
    readAttr(element, 'aria-label'),
    element.textContent || '',
  ].join(' '));

  return pattern.test(text);
}

function getCurrentMailboxTitle() {
  return normalizeText(deepQueryFirst('.thread-list-title')?.textContent || '');
}

async function findInboxItem(timeout = 6000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const items = deepQueryAll('.mailbox-list-item[role="option"]');
    const inboxItem = items.find(item => {
      const text = normalizeText(readAttr(item, 'aria-label') || item.textContent || '');
      return ICLOUD_INBOX_PATTERN.test(text);
    });

    if (inboxItem) {
      return inboxItem;
    }

    await sleep(200);
  }

  return null;
}

async function ensureInboxSelected() {
  const currentMailboxTitle = getCurrentMailboxTitle();
  if (ICLOUD_INBOX_PATTERN.test(currentMailboxTitle)) {
    return;
  }

  const inboxItem = await findInboxItem(6000);

  if (!inboxItem) {
    const rowCount = getVisibleMailRows().length;
    if (rowCount > 0 || currentMailboxTitle) {
      log(
        `iCloud Mail: Inbox item not found, continuing with current view "${currentMailboxTitle || 'unknown'}" (${rowCount} visible threads).`,
        'info'
      );
      return;
    }

    log('iCloud Mail: Inbox item not found and no current mailbox title was detected, continuing with current view.', 'warn');
    return;
  }

  if (inboxItem.getAttribute('aria-selected') === 'true') {
    return;
  }

  clickElement(inboxItem);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    throwIfStopped();
    if (inboxItem.getAttribute('aria-selected') === 'true') {
      log('iCloud Mail: Inbox selected');
      return;
    }
    await sleep(100);
  }

  log('iCloud Mail: Inbox selection did not confirm, continuing anyway.', 'warn');
}

function getIcloudMailLoginHint() {
  const loginSelectors = [
    'input[type="password"]',
    'input[type="email"]',
    'input[name="account_name_text_field"]',
    'input[id*="account_name" i]',
    'button[id*="sign-in" i]',
  ];
  return Boolean(deepQueryFirst(loginSelectors));
}

async function waitForIcloudMailSurface(timeout = 45000) {
  const start = Date.now();
  let launcherClickedAt = 0;

  while (Date.now() - start < timeout) {
    throwIfStopped();

    if (hasMailboxSurface()) {
      return;
    }

    const launcher = findMailLauncherEntry();
    const shouldTryLauncher = launcher && (Date.now() - launcherClickedAt >= 5000);
    if (shouldTryLauncher) {
      clickElement(launcher);
      launcherClickedAt = Date.now();
      log('iCloud Mail: Mail launcher detected, clicked to open the Mail app.');
    }

    await sleep(250);
  }

  const context = [
    `URL: ${location.href}`,
    `Title: ${document.title || 'unknown'}`,
  ];
  if (getIcloudMailLoginHint()) {
    context.push('Login form detected');
  }

  throw new Error(`iCloud Mail surface did not appear within ${Math.round(timeout / 1000)}s. ${context.join(' | ')}`);
}

async function waitForMailRows(timeout = 15000) {
  const start = Date.now();
  let lastDebugAt = 0;
  while (Date.now() - start < timeout) {
    throwIfStopped();
    const rows = getVisibleMailRows();
    if (rows.length > 0) {
      return rows;
    }

    const now = Date.now();
    if (now - lastDebugAt >= 2000) {
      lastDebugAt = now;
      const rawCount = getMailRowCandidates().length;
      const rootCount = getDeepSearchRoots().length;
      const title = getCurrentMailboxTitle() || document.title || 'unknown';
      log(`iCloud Mail: Waiting for mail rows... roots=${rootCount}, raw=${rawCount}, visible=${rows.length}, title="${title}"`);
    }

    await sleep(250);
  }
  return [];
}

function findRefreshButton() {
  const pattern = /^(?:刷新|refresh)$/i;
  for (const candidate of getActionCandidates()) {
    if (!isPotentiallyVisibleAction(candidate)) continue;
    if (isElementDisabled(candidate)) continue;
    if (matchActionLabel(candidate, pattern)) {
      return candidate;
    }
  }

  return null;
}

async function refreshInbox() {
  const refreshButton = findRefreshButton();
  if (!refreshButton) {
    log(`iCloud Mail: Refresh button not found, continuing with current list. actionCandidates=${getActionCandidates().length}`, 'warn');
    return false;
  }

  clickElement(refreshButton);
  log('iCloud Mail: Refresh clicked');
  await sleep(1800);
  return true;
}

function getThreadDetailText() {
  const detailPane = deepQueryFirst('.thread-detail-pane');
  if (!detailPane) return '';
  return normalizeText(detailPane.innerText || detailPane.textContent || '');
}

function isNoMessageSelectedState() {
  const text = getThreadDetailText();
  return ICLOUD_NO_SELECTION_PATTERN.test(text);
}

function isMailShownInDetailPane(meta) {
  const detailText = getThreadDetailText().toLowerCase();
  if (!detailText || isNoMessageSelectedState()) return false;

  const subject = normalizeText(meta?.subject || '').toLowerCase();
  const sender = normalizeText(meta?.sender || '').toLowerCase();
  const preview = normalizeText(meta?.preview || '').toLowerCase();

  if (subject && subject.length >= 8 && detailText.includes(subject)) return true;
  if (preview && preview.length >= 16 && detailText.includes(preview.slice(0, 48))) return true;
  if (sender && sender.length >= 6 && detailText.includes(sender) && subject && detailText.includes(subject.slice(0, Math.min(subject.length, 24)))) return true;

  return false;
}

function isMailRowActivated(row, meta) {
  if (row?.getAttribute?.('aria-selected') === 'true') {
    return true;
  }

  if (findDeleteButton()) {
    return true;
  }

  return isMailShownInDetailPane(meta);
}

async function selectMailRow(row, meta) {
  const clickTargets = getMailRowClickTargets(row);
  const treeRoot = getMailTreeRoot(row);

  try {
    row.focus?.();
  } catch {}

  for (const target of clickTargets) {
    dispatchRealisticPrimaryClick(target);

    const attemptStartedAt = Date.now();
    while (Date.now() - attemptStartedAt < 700) {
      throwIfStopped();
      if (isMailRowActivated(row, meta)) {
        log('iCloud Mail: Mail row selected', 'info');
        return;
      }
      await sleep(80);
    }
  }

  for (const keyboardTarget of [treeRoot, row].filter(Boolean)) {
    for (const key of ['Home', 'ArrowDown', 'Enter', ' ']) {
      try {
        keyboardTarget.focus?.();
        keyboardTarget.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        keyboardTarget.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      } catch {}

      const attemptStartedAt = Date.now();
      while (Date.now() - attemptStartedAt < 500) {
        throwIfStopped();
        if (isMailRowActivated(row, meta)) {
          log('iCloud Mail: Mail row selected', 'info');
          return;
        }
        await sleep(80);
      }
    }
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 4000) {
    throwIfStopped();
    if (isMailRowActivated(row, meta)) {
      log('iCloud Mail: Mail row selected', 'info');
      return;
    }

    if (Date.now() - startedAt > 1200 && Date.now() - startedAt < 1400) {
      dispatchRealisticPrimaryClick(row);
    }
    await sleep(100);
  }

  throw new Error('Could not select iCloud Mail row.');
}

function findDeleteButton() {
  for (const candidate of getActionCandidates()) {
    if (!isPotentiallyVisibleAction(candidate)) continue;
    if (isElementDisabled(candidate)) continue;
    if (matchActionLabel(candidate, ICLOUD_DELETE_BUTTON_PATTERN)) {
      return candidate;
    }
  }

  return null;
}

function findRowQuickActionButton(row) {
  hoverElement(row);
  hoverElement(deepQueryFirst('.content-container, .thread-details, .selection-background', row) || row);

  return deepQueryFirst([
    'button[aria-label="更多操作"]',
    'button[title="更多操作"]',
    'button[aria-label="More actions"]',
    'button[title="More actions"]',
    'button[aria-label*="更多操作"]',
    'button[title*="更多操作"]',
    'button[aria-label*="More action" i]',
    'button[title*="More action" i]',
  ], row);
}

function findDeleteMenuItem() {
  const selectors = [
    '[role="menuitem"]',
    'button',
    '[role="button"]',
    'li',
    'ui-menu-item',
  ];
  const candidates = deepQueryAll(selectors);
  for (const candidate of candidates) {
    if (!isVisible(candidate)) continue;
    const text = normalizeText([
      readAttr(candidate, 'aria-label'),
      readAttr(candidate, 'title'),
      candidate.textContent || '',
    ].join(' '));
    if (ICLOUD_DELETE_MENU_PATTERN.test(text)) {
      return candidate;
    }
  }

  return null;
}

async function waitForDeleteMenuItem(timeout = 3000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const item = findDeleteMenuItem();
    if (item) return item;
    await sleep(120);
  }

  return null;
}

async function deleteMailRowViaQuickAction(row, meta, step) {
  const button = findRowQuickActionButton(row);
  if (!button) {
    throw new Error('Could not find iCloud Mail row quick action button.');
  }

  clickElement(button, { preferNestedButton: false });
  const deleteItem = await waitForDeleteMenuItem(3000);
  if (!deleteItem) {
    throw new Error('Could not find iCloud Mail delete menu item.');
  }

  const signature = getMailSignature(meta);
  clickElement(deleteItem, { preferNestedButton: false });
  log(`Step ${step}: Clicked iCloud Mail row delete action`, 'ok');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    throwIfStopped();
    const signatures = getCurrentMailSignatures();
    if (!signatures.has(signature)) {
      return;
    }
    await sleep(150);
  }

  throw new Error('Selected iCloud Mail row did not disappear after quick-action delete.');
}

async function waitForDeleteButton(timeout = 4000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const deleteButton = findDeleteButton();
    if (deleteButton) {
      return deleteButton;
    }
    await sleep(120);
  }

  return null;
}

async function deleteMailRow(row, meta, step) {
  try {
    try {
      await deleteMailRowViaQuickAction(row, meta, step);
      return;
    } catch (quickActionError) {
      log(`Step ${step}: iCloud Mail quick-action delete unavailable, falling back to row selection. ${quickActionError.message}`, 'warn');
    }

    await selectMailRow(row, meta);
    await sleep(250);

    const deleteButton = await waitForDeleteButton(4500);
    if (!deleteButton) {
      throw new Error('Could not find iCloud Mail delete button.');
    }

    const signature = getMailSignature(meta);
    clickElement(deleteButton);
    log(`Step ${step}: Clicked iCloud Mail delete`, 'ok');

    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      throwIfStopped();
      const signatures = getCurrentMailSignatures();
      if (!signatures.has(signature)) {
        return;
      }
      await sleep(150);
    }

    throw new Error('Selected iCloud Mail row did not disappear after delete.');
  } catch (err) {
    log(`Step ${step}: iCloud Mail delete failed: ${err.message}`, 'warn');
  }
}

function collectLooseThreadCandidates() {
  const roots = getMailRowCandidates();
  const candidates = [];
  const seen = new Set();

  for (const root of roots) {
    const meta = extractMailMeta(root);
    const signature = getMailSignature(meta);
    const combined = normalizeText([
      meta.sender,
      meta.subject,
      meta.preview,
      meta.ariaLabel,
      root.innerText || root.textContent || '',
    ].join(' '));

    if (!combined || combined.length < 12) continue;

    const dedupeKey = signature || combined.slice(0, 240);
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    candidates.push({
      root,
      meta: { ...meta, combinedText: combined },
      signature: dedupeKey,
    });
  }

  return candidates;
}

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll on iCloud Mail (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);

  try {
    await waitForIcloudMailSurface(45000);
  } catch (err) {
    throw new Error(`iCloud Mail UI did not load. ${err.message}`);
  }

  await ensureInboxSelected();
  await sleep(600);

  let rows = await waitForMailRows(12000);
  if (rows.length === 0) {
    await refreshInbox();
    rows = await waitForMailRows(8000);
  }

  const looseCandidates = collectLooseThreadCandidates();
  if (rows.length === 0 && looseCandidates.length === 0) {
    throw new Error(`iCloud Mail list did not load. URL: ${location.href} | Title: ${document.title || 'unknown'}`);
  }

  const existingSignatures = new Set(
    looseCandidates.length > 0
      ? looseCandidates.map(candidate => candidate.signature)
      : Array.from(getCurrentMailSignatures())
  );
  log(`Step ${step}: Snapshotted ${existingSignatures.size} visible iCloud Mail threads as "old"`);

  const FALLBACK_AFTER = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling iCloud Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      try {
        await refreshInbox();
      } catch (err) {
        log(`Step ${step}: iCloud Mail refresh was unavailable, continuing with the current list. ${err.message}`, 'warn');
      }
    }

    const useFallback = attempt > FALLBACK_AFTER;
    const orderedCandidates = [
      ...collectLooseThreadCandidates().filter(candidate => candidate.meta.unread),
      ...collectLooseThreadCandidates().filter(candidate => !candidate.meta.unread),
    ];

    for (const candidate of orderedCandidates) {
      const { root: row, meta, signature } = candidate;
      if (!signature) continue;
      if (!useFallback && existingSignatures.has(signature)) continue;
      if (!rowMatchesFilters(meta, senderFilters, subjectFilters)) continue;

      const code = extractVerificationCode(meta.combinedText);
      if (!code) {
        log(`Step ${step}: iCloud Mail thread matched filters but list preview had no code. Subject: ${meta.subject.slice(0, 80)}`, 'info');
        continue;
      }

      const source = existingSignatures.has(signature) ? 'current-visible-match' : 'new';
      await deleteMailRow(row, meta, step);
      log(`Step ${step}: Code found: ${code} (${source}, subject: ${meta.subject.slice(0, 60)})`, 'ok');
      return { ok: true, code, emailTimestamp: Date.now(), mailId: signature };
    }

    if (FALLBACK_AFTER > 0 && attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new iCloud Mail threads after ${FALLBACK_AFTER} attempts, falling back to first matching email`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found on iCloud Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check iCloud Mail manually and make sure the inbox thread list is visible.'
  );
}

} // end singleton guard
