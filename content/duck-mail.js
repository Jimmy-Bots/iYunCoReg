// content/duck-mail.js — Content script for DuckDuckGo Email Protection autofill settings

console.log('[MultiPage:duck-mail] Content script loaded on', location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'FETCH_DUCK_EMAIL') return;

  resetStopState();
  fetchDuckEmail(message.payload).then(result => {
    sendResponse(result);
  }).catch(err => {
    if (isStopError(err)) {
      log('Duck Mail: Stopped by user.', 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }
    sendResponse({ error: err.message });
  });

  return true;
});

async function fetchDuckEmail(payload = {}) {
  const { generateNew = true } = payload;

  log(`Duck Mail: ${generateNew ? 'Generating' : 'Reading'} private address...`);

  await waitForElement(
    'input.AutofillSettingsPanel__PrivateDuckAddressValue, button.AutofillSettingsPanel__GeneratorButton',
    15000
  );

  const getAddressInput = () => document.querySelector('input.AutofillSettingsPanel__PrivateDuckAddressValue');
  const getGeneratorButton = () => document.querySelector('button.AutofillSettingsPanel__GeneratorButton')
    || Array.from(document.querySelectorAll('button')).find(btn => /generate private duck address/i.test(btn.textContent || ''));
  const readEmail = () => {
    const value = getAddressInput()?.value?.trim() || '';
    return value.includes('@duck.com') ? value : '';
  };

  const waitForEmailValue = async (previousValue = '') => {
    for (let i = 0; i < 100; i++) {
      const nextValue = readEmail();
      if (nextValue && nextValue !== previousValue) {
        return nextValue;
      }
      await sleep(150);
    }
    throw new Error('Timed out waiting for Duck address to appear.');
  };

  const currentEmail = readEmail();
  if (currentEmail && !generateNew) {
    log(`Duck Mail: Found existing address ${currentEmail}`);
    return { email: currentEmail, generated: false };
  }

  await humanPause(500, 1300);
  const generatorButton = getGeneratorButton();
  if (!generatorButton) {
    if (currentEmail) {
      log(`Duck Mail: Reusing existing address ${currentEmail}`, 'warn');
      return { email: currentEmail, generated: false };
    }
    throw new Error('Could not find "Generate Private Duck Address" button.');
  }

  generatorButton.click();
  log('Duck Mail: Clicked "Generate Private Duck Address"');

  const nextEmail = await waitForEmailValue(currentEmail);
  log(`Duck Mail: Ready address ${nextEmail}`, 'ok');
  return { email: nextEmail, generated: true };
}
