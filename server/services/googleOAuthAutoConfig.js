/**
 * Google OAuth Auto-Configure via CDP Browser
 *
 * Flow:
 * 1. User clicks "Setup with Browser" → opens Google Cloud Console
 * 2. User logs in and selects/creates a project manually
 * 3. User clicks "Continue" → automated script handles:
 *    a. Enable Google Calendar API
 *    b. Configure OAuth consent screen (Google Auth Platform wizard)
 *    c. Add user as test user
 *    d. Create OAuth Web client with redirect URI
 *    e. Extract client ID + secret from "Information and summary" panel
 *    f. Save to PortOS
 *
 * Selectors derived from live Playwright MCP walkthrough of Google Cloud Console (2026-03-14).
 * Google Auth Platform uses Angular Material components — selectors target ARIA roles and text.
 */
import { findOrOpenPage, evaluateOnPage, getPages } from './messagePlaywrightSync.js';
import { navigateToUrl } from './browserService.js';
import { saveCredentials, getAuthUrl, OAUTH_REDIRECT_URI } from './googleAuth.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getGcpPage() {
  const pages = await getPages();
  return pages.find(p => p.url?.includes('console.cloud.google.com'));
}

async function waitForPageLoad(maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const page = await getGcpPage();
    if (page) {
      const ready = await evaluateOnPage(page, `document.readyState === 'complete'`);
      if (ready) return page;
    }
    await sleep(1000);
  }
  return null;
}

async function navAndWait(url, waitMs = 4000) {
  await navigateToUrl(url);
  await sleep(waitMs);
  return waitForPageLoad();
}

/**
 * Click a button/link by matching its text content (case-insensitive).
 * Polls until found or timeout.
 */
async function clickByText(page, texts, maxWait = 10000) {
  const patterns = Array.isArray(texts) ? texts : [texts];
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const clicked = await evaluateOnPage(page, `
      (function() {
        const patterns = ${JSON.stringify(patterns)};
        const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], [role="radio"]')];
        for (const pattern of patterns) {
          const lp = pattern.toLowerCase();
          const match = candidates.find(el => {
            const text = (el.textContent || '').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            return (text === lp || text.startsWith(lp) || aria.includes(lp)) && !el.disabled;
          });
          if (match) { match.click(); return pattern; }
        }
        return null;
      })()
    `);
    if (clicked) return clicked;
    await sleep(1500);
  }
  return null;
}

/**
 * Fill a textbox found by its accessible name.
 */
async function fillByName(page, name, value) {
  const safeName = JSON.stringify(name.toLowerCase());
  const safeValue = JSON.stringify(value);
  return evaluateOnPage(page, `
    (function() {
      const nameToMatch = ${safeName};
      const valueToSet = ${safeValue};
      const inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
      for (const input of inputs) {
        const label = input.getAttribute('aria-label') || '';
        const placeholder = input.getAttribute('placeholder') || '';
        const id = input.id || '';
        const formLabel = input.closest('[class*="form"]')?.querySelector('label')?.textContent || '';
        if ([label, placeholder, formLabel].some(t => t.toLowerCase().includes(nameToMatch))) {
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) { setter.call(input, valueToSet); }
          else { input.value = valueToSet; }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    })()
  `);
}

// === Public API ===

export async function startAutoConfig(io) {
  console.log('📅 Starting Google OAuth auto-configuration via CDP browser');
  io?.emit('calendar:google:autoconfig', { step: 'launching', message: 'Opening Google Cloud Console...' });

  const page = await findOrOpenPage('https://console.cloud.google.com');
  if (!page) {
    return { error: 'Failed to open browser. Ensure portos-browser is running.', status: 503 };
  }

  io?.emit('calendar:google:autoconfig', { step: 'login', message: 'Google Cloud Console opened. Log in and select a project, then click Continue.' });
  console.log('📅 Google Cloud Console opened in CDP browser');
  return { status: 'started', message: 'Log in and select your project, then click Continue.' };
}

export async function runAutomatedSetup(userEmail, io) {
  console.log('📅 Running automated Google OAuth setup via CDP');
  const emit = (step, message) => {
    io?.emit('calendar:google:autoconfig', { step, message });
    console.log(`📅 Auto-config: ${message}`);
  };

  let page = await getGcpPage();
  if (!page) return { error: 'Google Cloud Console not open. Click "Setup with Browser" first.', status: 400 };

  // Detect the project from the current URL
  const projectMatch = page.url?.match(/project=([^&]+)/);
  const project = projectMatch ? projectMatch[1] : '';
  const projectParam = project ? `?project=${project}` : '';

  // === Step 1: Enable Google Calendar API ===
  emit('enable-api', 'Enabling Google Calendar API...');
  page = await navAndWait(`https://console.cloud.google.com/apis/library/calendar-json.googleapis.com${projectParam}`, 5000);
  if (page) {
    const alreadyEnabled = await evaluateOnPage(page, `
      document.body.innerText.includes('API enabled') || document.body.innerText.includes('MANAGE') || document.body.innerText.includes('Manage')
    `);
    if (!alreadyEnabled) {
      // Button text is "Enable" with aria-label "enable this API"
      const clicked = await clickByText(page, ['enable this api', 'Enable']);
      if (clicked) {
        emit('enable-api', 'Calendar API enable clicked, waiting...');
        await sleep(6000);
      }
    } else {
      emit('enable-api', 'Calendar API already enabled');
    }
  }

  // === Step 2: Configure OAuth consent / Google Auth Platform ===
  emit('consent', 'Configuring OAuth consent screen...');
  page = await navAndWait(`https://console.cloud.google.com/auth/overview${projectParam}`, 5000);
  if (page) {
    const needsSetup = await evaluateOnPage(page, `
      document.body.innerText.includes('not configured yet') || document.body.innerText.includes('Get started')
    `);

    if (needsSetup) {
      // Click "Get started" link
      await clickByText(page, ['Get started']);
      await sleep(4000);
      page = await waitForPageLoad();

      if (page) {
        // Step 1/4: App Information — fill app name, select email
        emit('consent', 'Filling app information...');
        await fillByName(page, 'app name', 'PortOS');
        await sleep(500);

        // Open the support email combobox and select the first option
        await evaluateOnPage(page, `
          (function() {
            const combo = document.querySelector('[role="combobox"][aria-label*="support"]') ||
                          document.querySelector('cfc-select[formcontrolname="userSupportEmail"]');
            if (combo) combo.click();
          })()
        `);
        await sleep(1000);
        // Click the first email option
        await evaluateOnPage(page, `
          (function() {
            const options = document.querySelectorAll('[role="option"]');
            for (const opt of options) {
              if (opt.textContent.includes('@') && !opt.hasAttribute('disabled')) {
                opt.click();
                return true;
              }
            }
            return false;
          })()
        `);
        await sleep(500);

        // Click Next
        await clickByText(page, ['Next']);
        await sleep(2000);

        // Step 2/4: Audience — select External
        emit('consent', 'Setting audience to External...');
        await clickByText(page, ['External']);
        await sleep(500);
        await clickByText(page, ['Next']);
        await sleep(2000);

        // Step 3/4: Contact Information — fill email
        emit('consent', 'Filling contact email...');
        const email = userEmail || 'portos@localhost';
        await evaluateOnPage(page, `
          (function() {
            const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
            const emailInput = [...inputs].find(i => {
              const ph = i.placeholder || '';
              const label = i.closest('[class*="form"]')?.querySelector('label')?.textContent || '';
              return !i.value && (ph.includes('email') || label.toLowerCase().includes('email'));
            }) || [...inputs].find(i => !i.value);
            if (emailInput) {
              emailInput.focus();
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              if (setter) setter.call(emailInput, '${email}');
              else emailInput.value = '${email}';
              emailInput.dispatchEvent(new Event('input', { bubbles: true }));
              emailInput.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          })()
        `);
        await sleep(500);
        await clickByText(page, ['Next']);
        await sleep(2000);

        // Step 4/4: Finish — check agreement, click Continue then Create
        emit('consent', 'Accepting terms...');
        await evaluateOnPage(page, `
          (function() {
            const cb = document.querySelector('[role="checkbox"]') || document.querySelector('input[type="checkbox"]');
            if (cb && !cb.checked) cb.click();
          })()
        `);
        await sleep(500);
        await clickByText(page, ['Continue', 'Create']);
        await sleep(3000);
        await clickByText(page, ['Create']);
        await sleep(3000);

        // Close any notification
        await clickByText(page, ['Close message'], 3000);
        await sleep(1000);
      }
    } else {
      emit('consent', 'OAuth consent already configured');
    }
  }

  // === Step 3: Add test user ===
  emit('test-user', 'Adding test user...');
  page = await navAndWait(`https://console.cloud.google.com/auth/audience${projectParam}`, 5000);
  if (page) {
    const hasUser = await evaluateOnPage(page, `
      document.body.innerText.includes('${userEmail || ''}') && !'${userEmail}'.includes('portos')
    `);
    if (!hasUser && userEmail) {
      await clickByText(page, ['Add users']);
      await sleep(2000);
      // Fill email in the dialog
      await evaluateOnPage(page, `
        (function() {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return false;
          const input = dialog.querySelector('input[type="text"], input:not([type])');
          if (!input) return false;
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, '${userEmail}');
          else input.value = '${userEmail}';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()
      `);
      await sleep(1500);
      await clickByText(page, ['Save']);
      await sleep(2000);
    }
  }

  // === Step 4: Create OAuth client ===
  emit('credentials', 'Creating OAuth client...');
  page = await navAndWait(`https://console.cloud.google.com/auth/clients/create${projectParam}`, 5000);
  if (page) {
    // Select "Web application" from Application type dropdown
    await evaluateOnPage(page, `
      (function() {
        const combo = document.querySelector('[role="combobox"]');
        if (combo) combo.click();
      })()
    `);
    await sleep(1500);
    await clickByText(page, ['Web application']);
    await sleep(2000);

    // Rename from "Web client 1" to "PortOS Web"
    await evaluateOnPage(page, `
      (function() {
        const nameInput = document.querySelector('input[aria-label="Name"], input[formcontrolname="displayName"]')
          || [...document.querySelectorAll('input')].find(i => i.value === 'Web client 1');
        if (nameInput) {
          nameInput.focus();
          nameInput.select();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(nameInput, 'PortOS Web');
          else nameInput.value = 'PortOS Web';
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          nameInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      })()
    `);
    await sleep(500);

    // Add redirect URI — click "Add URI" in the redirect URIs section
    await evaluateOnPage(page, `
      (function() {
        // Find the "Add URI" button in the redirect URIs fieldset
        const fieldsets = document.querySelectorAll('fieldset');
        for (const fs of fieldsets) {
          if (fs.textContent.includes('redirect URI')) {
            const btn = fs.querySelector('button');
            if (btn) { btn.click(); return true; }
          }
        }
        // Fallback: click the last "Add URI" button
        const buttons = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Add URI');
        if (buttons.length > 0) { buttons[buttons.length - 1].click(); return true; }
        return false;
      })()
    `);
    await sleep(1000);

    // Fill the redirect URI (the last empty input)
    await evaluateOnPage(page, `
      (function() {
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
        const empty = inputs.reverse().find(i => !i.value && i.placeholder?.includes('example'));
        if (!empty) return false;
        empty.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(empty, '${OAUTH_REDIRECT_URI}');
        else empty.value = '${OAUTH_REDIRECT_URI}';
        empty.dispatchEvent(new Event('input', { bubbles: true }));
        empty.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(1000);

    // Click Create
    emit('credentials', 'Submitting OAuth client...');
    await clickByText(page, ['Create']);
    await sleep(5000);
    page = await waitForPageLoad();
  }

  // === Step 5: Extract credentials ===
  emit('capturing', 'Extracting credentials...');
  await sleep(2000);

  // First try: capture from the creation dialog (shows client ID, might have secret)
  let credentials = await extractFromDialog(page);

  if (!credentials?.clientSecret) {
    // Close dialog and navigate to client detail to get secret from "Information and summary"
    await clickByText(page, ['OK', 'Close'], 3000);
    await sleep(2000);

    // Find and click the client in the list
    page = await getGcpPage();
    if (page) {
      // Click on the client link (matches "PortOS Web" or "Web client")
      await evaluateOnPage(page, `
        (function() {
          const links = document.querySelectorAll('a');
          for (const link of links) {
            if (link.href?.includes('/auth/clients/') && (link.textContent.includes('PortOS Web') || link.textContent.includes('Web client'))) {
              link.click();
              return true;
            }
          }
          return false;
        })()
      `);
      await sleep(3000);
      page = await waitForPageLoad();

      if (page) {
        // Click "Information and summary" button
        await clickByText(page, ['Information and summary']);
        await sleep(2000);

        // Extract from the summary panel — secret is in a copy button's aria-label
        credentials = await evaluateOnPage(page, `
          (function() {
            const allText = document.body.innerText;
            const clientIdMatch = allText.match(/([0-9]+-[a-zA-Z0-9_]+\\.apps\\.googleusercontent\\.com)/);

            // Secret is in a button aria-label: "Copy to clipboard: GOCSPX-..."
            const buttons = document.querySelectorAll('button[aria-label*="GOCSPX"]');
            let clientSecret = null;
            for (const btn of buttons) {
              const label = btn.getAttribute('aria-label') || '';
              const secretMatch = label.match(/(GOCSPX-[a-zA-Z0-9_-]+)/);
              if (secretMatch) { clientSecret = secretMatch[1]; break; }
            }

            // Also check text content
            if (!clientSecret) {
              const secretTextMatch = allText.match(/(GOCSPX-[a-zA-Z0-9_-]+)/);
              if (secretTextMatch) clientSecret = secretTextMatch[1];
            }

            if (clientIdMatch && clientSecret) {
              return { clientId: clientIdMatch[1], clientSecret };
            }
            return clientIdMatch ? { clientId: clientIdMatch[1], partial: true } : null;
          })()
        `);
      }
    }
  }

  if (!credentials?.clientId || !credentials?.clientSecret) {
    emit('error', 'Could not capture credentials automatically');
    return {
      status: 'partial',
      error: 'Automation completed but could not extract the client secret. Use "Download JSON" from the Google Cloud Console client page and paste the credentials manually.',
      clientId: credentials?.clientId || null
    };
  }

  // Save credentials
  await saveCredentials(credentials);
  emit('done', 'Credentials captured and saved!');
  console.log(`📅 OAuth credentials captured: ${credentials.clientId}`);

  const authResult = await getAuthUrl();
  return {
    status: 'success',
    clientId: credentials.clientId,
    authUrl: authResult.url || null
  };
}

async function extractFromDialog(page) {
  if (!page) return null;
  return evaluateOnPage(page, `
    (function() {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const text = dialog.innerText;
      const clientIdMatch = text.match(/([0-9]+-[a-zA-Z0-9_]+\\.apps\\.googleusercontent\\.com)/);
      const secretMatch = text.match(/(GOCSPX-[a-zA-Z0-9_-]+)/);

      // Also check button aria-labels
      let secret = secretMatch?.[1] || null;
      if (!secret) {
        const btns = dialog.querySelectorAll('button[aria-label*="GOCSPX"]');
        for (const btn of btns) {
          const m = btn.getAttribute('aria-label')?.match(/(GOCSPX-[a-zA-Z0-9_-]+)/);
          if (m) { secret = m[1]; break; }
        }
      }

      if (clientIdMatch) return { clientId: clientIdMatch[1], clientSecret: secret };
      return null;
    })()
  `);
}

export async function captureCredentials(io) {
  const page = await getGcpPage();
  if (!page) return { error: 'Google Cloud Console not open in browser', status: 404 };

  io?.emit('calendar:google:autoconfig', { step: 'capturing', message: 'Scanning for credentials...' });

  // Try dialog first, then page text, then summary panel button labels
  const credentials = await evaluateOnPage(page, `
    (function() {
      const allText = document.body.innerText;
      const clientIdMatch = allText.match(/([0-9]+-[a-zA-Z0-9_]+\\.apps\\.googleusercontent\\.com)/);

      // Check button aria-labels for secret (Google hides it there)
      const buttons = document.querySelectorAll('button[aria-label*="GOCSPX"]');
      let clientSecret = null;
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label') || '';
        const m = label.match(/(GOCSPX-[a-zA-Z0-9_-]+)/);
        if (m) { clientSecret = m[1]; break; }
      }

      if (!clientSecret) {
        const secretMatch = allText.match(/(GOCSPX-[a-zA-Z0-9_-]+)/);
        if (secretMatch) clientSecret = secretMatch[1];
      }

      if (clientIdMatch && clientSecret) return { clientId: clientIdMatch[1], clientSecret };
      if (clientIdMatch) return { clientId: clientIdMatch[1], partial: true };
      return null;
    })()
  `);

  if (!credentials?.clientId) {
    return { error: 'Could not find credentials on the page.', status: 404 };
  }
  if (!credentials.clientSecret) {
    return { error: 'Found Client ID but not secret. Click "Information and summary" on the client detail page first.', clientId: credentials.clientId, status: 404 };
  }

  await saveCredentials(credentials);
  io?.emit('calendar:google:autoconfig', { step: 'captured', message: 'Credentials captured and saved!' });
  console.log('📅 OAuth credentials captured and saved');

  const authResult = await getAuthUrl();
  return { status: 'captured', clientId: credentials.clientId, authUrl: authResult.url || null };
}
