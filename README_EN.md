# iYunCoReg

[中文](./README.md) | [English](./README_EN.md)

A Chrome extension built around `iCloud Hide My Email` for small-scale personal automation of the Codex OAuth sign-up and sign-in flow.

Its job is straightforward:

- Automatically fetch the OAuth link from the `CPA Auth / Sub2API` panel
- Automatically complete sign-up, mailbox polling, login, and consent confirmation
- Prefer reusing unused iCloud aliases
- Support both step-by-step execution and full `Auto` runs

## Who This Is For

If you already have:

- Chrome
- A working `CPA Auth` or `Sub2API` management panel
- An active iCloud session in the current browser
- At least one mailbox page that can receive verification codes

then this extension should work out of the box for you.

## Feature Overview

- Automatically read the OpenAI OAuth link from the `CPA Auth` or `Sub2API` panel
- Automatically open the sign-up page and enter `Sign up / Register`
- Automatically fill email, password, name, birthday, or age
- Automatically poll verification emails and fill the code back in
- Automatically handle the OAuth consent page
- Support `QQ Mail`, `163 Mail`, `Gmail`, and `Inbucket`
- Support both Chinese and English UI, with Chinese as the default
- Support `Skip` after a failure
- Support resuming after interruption
- Support multi-run `Auto`
- Support managing iCloud aliases:
  - View aliases
  - Delete manually
  - Bulk delete used aliases
  - Auto-delete aliases after successful use

## Before You Start

Please make sure:

- Chrome extension developer mode is enabled
- You are already signed in to `icloud.com.cn` or `icloud.com` in the current browser
- Your `CPA Auth` or `Sub2API` panel is reachable
- Your verification mailbox web page is accessible

Supported verification sources:

- `QQ Mail`
- `163 Mail`
- `Gmail`
- `Inbucket`

## Tested Scope and Limits

The current flow has mainly been tested under:

- An active iCloud session
- An iCloud paid-subscription environment

`Free iCloud` has not been fully tested yet, so behavior cannot be guaranteed there.

There are also some practical limits with the current iCloud interface:

- After generating enough aliases continuously, the API may temporarily stop creating new ones
- In that case, you can usually still create aliases manually on the official iCloud page, and the extension will prefer reusing unused aliases it detects
- After waiting for a while, extension-side API calls usually start working again

For normal personal use, this is usually fine, but it is not intended for large-scale or high-frequency registration.

Project positioning:

- Personal use
- Better day-to-day efficiency

Not recommended or supported for:

- Large-scale registration
- High-frequency abuse of the iCloud API
- Long-term bulk-production workflows

## Installation

1. Open `chrome://extensions/`
2. Enable Developer Mode
3. Click Load unpacked
4. Select this project directory
5. Open the extension side panel

## Quick Start

For your first run, the recommended order is:

1. Fill in the `Auth Panel` URL in the side panel
2. Choose the verification source in `Verify`
3. Click `Auto` to generate or reuse an iCloud email, or paste one manually
4. Leave `Password` empty to auto-generate, or provide your own
5. Run one full step-by-step test first to make sure the pages are recognized correctly
6. Once everything looks good, use the top-right `Auto`

## Side Panel Guide

### `Auth Panel`

Fill in your management panel URL, for example:

```txt
CPA Auth: http(s)://<your-host>/management.html#/oauth
Sub2API: https://<your-host>/admin/accounts
```

This URL is mainly used for:

- Step 1: getting the OAuth link
- Step 9: writing back the callback URL and verifying it

Additional notes:

- If the URL is a `CPA Auth` panel, the extension uses the original OAuth-fetch and callback verification flow
- If the URL is a `Sub2API /admin/accounts` page, the extension detects it automatically and switches to the `Sub2API` flow
- Under `Sub2API`, Step 1 will automatically create the account, select `OpenAI`, and generate the authorization link
- Under `Sub2API`, Step 9 will automatically fill the callback URL into the `Authorization Link or Code` field and click `Complete Authorization`

### `Language`

You can switch between:

- `中文`
- `English`

The default UI language is Chinese.

### `Cleanup`

You can optionally enable automatic deletion of iCloud aliases after successful use.

Behavior:

- It only runs after Step 9 succeeds
- Delete failures do not interrupt the whole run
- If the current email is not an iCloud alias, it is skipped automatically

### `Verify`

Use this field to choose the verification-code source:

- `163 Mail`
- `QQ Mail`
- `Gmail`
- `Inbucket`

Additional notes:

- For `Gmail`, it is best to keep the page on `Inbox`, ideally the `Primary` tab
- If `QQ Mail`, `163 Mail`, or `Gmail` is not signed in the first time it opens, the extension will show a reminder
- After signing in, return to the side panel and click `OK`
- In step-by-step mode, the current step will retry automatically; in `Auto`, the full flow will resume automatically

### `Email`

This is the email used during registration.

When you click `Auto`, the extension handles it in this order:

1. Reuse an iCloud alias that is not marked as `used`
2. If none are available, generate a new alias
3. If automatic fetching fails, you can still paste an email manually and continue

### `Password`

- Leave empty: auto-generate a strong password
- Fill manually: use your custom password
- Use `Show / Hide` to toggle visibility

## Workflow

### Step-by-Step Mode

There are 9 steps in the side panel:

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Fill Name / Birthday`
6. `Login via OAuth`
7. `Get Login Code`
8. `OAuth Auto Confirm`
9. `Auth Panel Verify`

Best for:

- First-time testing
- Troubleshooting after a page structure change
- Manually continuing after a specific step fails

### Auto Mode

`Auto` runs the full workflow in sequence.

Default flow:

1. Get the `CPA Auth / Sub2API` OAuth link
2. Open the sign-up page
3. Fetch an email automatically
4. Receive the sign-up code
5. Complete the registration profile
6. Log in
7. Receive the login code
8. Confirm OAuth automatically
9. Return to the `Auth Panel` and finish verification

If the auto flow is interrupted:

- You can fix the issue and click `Continue`
- Or use `Skip` on the failed step

## FAQ

### 1. Auto failed to fetch an iCloud email

Check the following first:

- Are you really signed in to iCloud in the current browser?
- Has the opened iCloud login page already finished signing in?
- After signing in, did you click `I've Signed In` in the side panel?

### 2. The verification mailbox fails to load or shows no list on first open

This usually happens when:

- `QQ Mail` is not signed in
- `163 Mail` is not signed in
- `Gmail` is not signed in, or the page is not on `Inbox / Primary`

How to handle it:

- Finish signing in on the newly opened mailbox page
- For `Gmail`, try to keep it on `Inbox / Primary`
- Return to the side panel and click `OK`
- In step-by-step mode, the current step retries automatically; in `Auto`, the full flow resumes automatically

### 3. Is Step 8 the most fragile step?

Yes.

It is the most dependent on page structure and the easiest to break when the site changes.

### 4. I got `debugger attach failed`

This usually means the target tab is already occupied by DevTools.

Close DevTools on that page and try again.

### 5. Why was a used mailbox not deleted immediately?

Because deletion is optional and only runs after Step 9 succeeds.

### 6. Why was the alias not auto-deleted?

Common reasons:

- `Cleanup` is not enabled
- The current email is not an iCloud alias
- The iCloud session has expired
- The delete API failed at that moment

## Acknowledgements

Thanks to [StepFlow-Duck](https://github.com/whwh1233/StepFlow-Duck) for the base version.

This project was also inspired and supported by the [LINUX DO](https://linux.do/) community.

## License

This project is licensed under the MIT License.

It includes code derived from:

- [StepFlow-Duck](https://github.com/whwh1233/StepFlow-Duck)

[中文说明](./README.md)
