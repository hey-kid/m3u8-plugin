import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// This verification uses an isolated browser profile and a loopback-only fixture.
// It never touches a normal Edge/Chrome profile or an external video website.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.resolve(root, process.env.EXTENSION_DIST || 'dist');
const screenshotPath = path.resolve(root, 'artifacts', 'verification');
const requestedBrowser = process.argv.find((value) => value.startsWith('--browser='))?.split('=')[1] || 'auto';
const headed = process.argv.includes('--headed');
const browserPaths = {
  edge: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  chrome: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
const checks = [];
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  browser: null,
  userAgent: null,
  passedChecks: checks,
  limitations: [],
  actionPopupVerified: false,
  bfcacheRestored: false,
  status: 'running',
  cleanup: { browserClosed: false, fixtureClosed: false, temporaryProfileRemoved: false, complete: false },
};

async function removeProfile(profile) {
  const resolved = path.resolve(profile);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()), 'Only a direct child of the temporary directory may be removed');
  assert.ok(path.basename(resolved).startsWith('m3u8-extension-verify-'), 'Only this verification script profile may be removed');
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function eventually(read, predicate, description, timeout = 10_000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}; last value: ${JSON.stringify(lastValue)}`);
}

async function evaluateTarget(cdp, sessionId, expression) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cdp.off('Target.receivedMessageFromTarget', receive);
      reject(new Error('Timed out evaluating the actual action popup target'));
    }, 5_000);
    const receive = (event) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== id) return;
      clearTimeout(timeout);
      cdp.off('Target.receivedMessageFromTarget', receive);
      if (message.error) reject(new Error(message.error.message));
      else if (message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result.result.value);
    };
    cdp.on('Target.receivedMessageFromTarget', receive);
    cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    }).catch((error) => {
      clearTimeout(timeout);
      cdp.off('Target.receivedMessageFromTarget', receive);
      reject(error);
    });
  });
}

async function verifyActionPopup(context, worker, fixturePage, tabId, popupUrl, expectedUrls) {
  const cdp = await context.newCDPSession(fixturePage);
  let target;
  try {
    try {
      await worker.evaluate(async (id) => {
        const tab = await chrome.tabs.get(id);
        await chrome.tabs.update(id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.action.openPopup({ windowId: tab.windowId });
      }, tabId);
    } catch (error) {
      const limitation = `The actual action popup entry could not open in this browser: ${error.message}`;
      report.limitations.push(limitation);
      console.log(`INCOMPLETE ${limitation}`);
      return;
    }
    try {
      target = await eventually(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find((info) => info.url === popupUrl);
      }, Boolean, 'The browser did not expose its action popup target', 5_000);
    } catch (error) {
      report.limitations.push(`Actual action popup DOM verification remains incomplete: ${error.message}`);
      console.log(`INCOMPLETE ${report.limitations.at(-1)}`);
      return;
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const snapshot = await eventually(
      () => evaluateTarget(cdp, sessionId, `JSON.stringify({title:document.querySelector('#page-title')?.textContent,urls:Array.from(document.querySelectorAll('[data-testid="resource-url"]'),node=>node.textContent),error:document.querySelector('#error-state')?.hidden===false})`),
      (value) => JSON.parse(value).urls?.length === expectedUrls.length,
      'The actual action popup must load the active webpage resources',
    );
    const actual = JSON.parse(snapshot);
    assert.equal(actual.error, false);
    assert.deepEqual(new Set(actual.urls), new Set(expectedUrls));
    report.actionPopupVerified = true;
    pass('The real browser action entry opens its popup and lists the active webpage resources');
  } finally {
    if (target) await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background?.service_worker, 'The build must contain a MV3 service worker');
  const popupFile = manifest.action?.default_popup;
  assert.ok(popupFile, 'The build must declare an action popup');

  const fixture = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/page-')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=60' });
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>HLS verification ${url.pathname}</title><body><h1>本地扩展验证页面</h1><p>由验证脚本发出测试请求。</p><script>window.__bfcacheRestored=false;window.addEventListener('pageshow',event=>{window.__bfcacheRestored=event.persisted;});window.requestPlaylist=async function(url){const response=await fetch(url,{cache:'no-store'});return response.text();};</script></body></html>`);
    } else if (url.pathname === '/navigation-error') {
      request.socket.destroy();
    } else if (url.pathname === '/attachment.txt') {
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="verification.txt"',
      });
      response.end('Local attachment navigation fixture.');
    } else if (url.pathname.endsWith('.m3u8') || url.pathname === '/api/playlist') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' });
      response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-1.ts\n#EXT-X-ENDLIST\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"fixture":true}');
    }
  });

  let context;
  let profile;
  let usedBrowser;
  let clipboardPage;
  let savedClipboard;
  let failure;
  try {
    await new Promise((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    console.log(`Fixture running: ${baseUrl} (PID ${process.pid}); the script closes it in finally.`);

    const choices = requestedBrowser === 'auto' ? ['edge', 'chromium'] : [requestedBrowser];
    assert.ok(choices.every((choice) => ['edge', 'chromium', 'chrome'].includes(choice)), 'Use --browser=edge|chromium|chrome|auto');
    const failures = [];
    let worker;
    for (const browserName of choices) {
      profile = await mkdtemp(path.join(tmpdir(), 'm3u8-extension-verify-'));
      try {
        if (browserName !== 'chromium' && !existsSync(browserPaths[browserName])) {
          throw new Error(`${browserName} executable is unavailable: ${browserPaths[browserName]}`);
        }
        context = await chromium.launchPersistentContext(profile, {
          ...(browserName === 'chromium' ? { channel: 'chromium' } : { executablePath: browserPaths[browserName] }),
          headless: !headed,
          ignoreDefaultArgs: ['--disable-back-forward-cache'],
          viewport: { width: 1200, height: 850 },
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-first-run',
            '--no-default-browser-check',
          ],
        });
        worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
        usedBrowser = browserName;
        const version = await worker.evaluate(() => navigator.userAgent);
        report.browser = browserName;
        report.userAgent = version;
        console.log(`Browser: ${browserName}; ${version}`);
        break;
      } catch (error) {
        failures.push(`${browserName}: ${error.message}`);
        console.log(`Browser attempt unavailable: ${failures.at(-1)}`);
        await context?.close().catch(() => {});
        context = undefined;
        await removeProfile(profile);
        profile = undefined;
      }
    }
    if (!context || !worker) {
      throw new Error(`Could not launch an extension-capable browser. ${failures.join('\n')}\nFor Chromium, run: npx playwright install chromium`);
    }

    const extensionId = new URL(worker.url()).hostname;
    console.log(`Loaded extension: ${extensionId}`);
    const workerErrors = [];
    worker.on('console', (message) => {
      if (message.type() === 'error') workerErrors.push(message.text());
    });
    const tabForPage = async (page) => worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === url)?.id;
    }, page.url());
    const captureFor = async (tabId) => worker.evaluate(async (id) => {
      const key = `tab:${id}`;
      return (await chrome.storage.session.get(key))[key] || { tabId: id, items: [] };
    }, tabId);
    const waitForItems = async (tabId, expected) => eventually(
      () => captureFor(tabId),
      (capture) => capture.items.length === expected,
      `Expected ${expected} captures for tab ${tabId}`,
    );
    const request = async (page, url) => page.evaluate(async (target) => {
      const response = await fetch(target, { cache: 'no-store' });
      await response.text();
      return response.status;
    }, url);
    const activate = async (tabId) => worker.evaluate(async (id) => {
      await chrome.tabs.update(id, { active: true });
    }, tabId);

    const pageA = await context.newPage();
    await pageA.goto(`${baseUrl}/page-a`);
    const tabA = await tabForPage(pageA);
    assert.equal(typeof tabA, 'number');
    const signedUrl = `${baseUrl}/streams/master.m3u8?token=a%2Bb%2Fz%3D&expires=20300101&quality=1080p`;
    const mimeOnlyUrl = `${baseUrl}/api/playlist?id=video-a&signature=signed%2Fvalue%3D`;
    await request(pageA, signedUrl);
    await request(pageA, mimeOnlyUrl);
    await request(pageA, `${baseUrl}/payload.json?source=example.m3u8`);
    const firstCapture = await waitForItems(tabA, 2);
    assert.ok(firstCapture.items.some((item) => item.url === signedUrl));
    assert.ok(firstCapture.items.some((item) => item.url === mimeOnlyUrl && item.detectedBy.includes('content-type')));
    assert.ok(firstCapture.items.every((item) => item.statusCode === 200));
    pass('URL detection preserves the complete signed query, and MIME detects a URL without .m3u8');
    pass('A .m3u8 string in a non-HLS URL query is ignored');

    await request(pageA, signedUrl);
    const repeated = await eventually(
      () => captureFor(tabA),
      (capture) => capture.items.find((item) => item.url === signedUrl)?.requestCount === 2,
      'The duplicate request should increment its count once',
    );
    assert.equal(repeated.items.length, 2);
    pass('Repeated HLS requests deduplicate and count once per request');

    const pageB = await context.newPage();
    await pageB.goto(`${baseUrl}/page-b`);
    const tabB = await tabForPage(pageB);
    const urlB = `${baseUrl}/streams/tab-b.m3u8?token=only-b`;
    await request(pageB, urlB);
    const captureB = await waitForItems(tabB, 1);
    assert.equal(captureB.items[0].url, urlB);
    assert.equal((await captureFor(tabA)).items.length, 2);
    pass('Captures are isolated by browser tab');

    // Opening the actual popup HTML as an inactive extension tab preserves the
    // real currentWindow/active tab query, without mocking any extension API.
    await activate(tabA);
    const popupUrl = `chrome-extension://${extensionId}/${popupFile}`;
    await verifyActionPopup(context, worker, pageA, tabA, popupUrl, [signedUrl, mimeOnlyUrl]);
    const popupPromise = context.waitForEvent('page');
    await worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, popupUrl);
    const popup = await popupPromise;
    await popup.setViewportSize({ width: 440, height: 590 });
    await popup.waitForLoadState('domcontentloaded');
    await popup.locator('[data-testid="resource-item"]').first().waitFor();
    assert.equal(await popup.locator('[data-testid="resource-item"]').count(), 2);
    const initialShownUrls = await popup.locator('[data-testid="resource-url"]').allTextContents();
    assert.deepEqual(new Set(initialShownUrls.map((url) => url.trim())), new Set([signedUrl, mimeOnlyUrl]));
    pass('The real popup HTML lists only the active webpage captures');

    const liveUpdateUrl = `${baseUrl}/streams/live-update.m3u8?token=arrives-while-popup-open`;
    await request(pageA, liveUpdateUrl);
    await eventually(
      () => popup.locator('[data-testid="resource-item"]').count(),
      (count) => count === 3,
      'An open popup should show newly captured resources automatically',
    );
    const expectedUrls = [signedUrl, mimeOnlyUrl, liveUpdateUrl];
    const shownUrls = await popup.locator('[data-testid="resource-url"]').allTextContents();
    assert.deepEqual(new Set(shownUrls.map((url) => url.trim())), new Set(expectedUrls));
    pass('An open popup automatically displays new captures');

    const popupErrors = [];
    popup.on('pageerror', (error) => popupErrors.push(error.message));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await popup.bringToFront();
    clipboardPage = popup;
    savedClipboard = await popup.evaluate(() => navigator.clipboard.readText());
    await popup.locator('[data-testid="resource-item"]').filter({ hasText: signedUrl }).locator('[data-testid="copy-one"]').click();
    await eventually(
      () => popup.evaluate(() => navigator.clipboard.readText()),
      (value) => value === signedUrl,
      'Single copy must write the complete URL to the actual clipboard',
    );
    pass('Single copy writes the exact signed URL to the real browser clipboard');
    await popup.locator('[data-testid="copy-all"]').click();
    await eventually(
      () => popup.evaluate(() => navigator.clipboard.readText()),
      (value) => new Set(value.split(/\r?\n/)).size === expectedUrls.length && expectedUrls.every((url) => value.split(/\r?\n/).includes(url)),
      'Copy all must write every full URL, separated by newlines',
    );
    pass('Copy all writes all complete URLs to the real browser clipboard');
    await mkdir(screenshotPath, { recursive: true });
    const screenshotFile = path.join(screenshotPath, `${usedBrowser}-popup.png`);
    await popup.locator('#toast').waitFor({ state: 'hidden' });
    await popup.locator('#resource-list').evaluate((list) => { list.scrollTop = 0; });
    await popup.locator('.app').screenshot({ path: screenshotFile });
    console.log(`Screenshot: ${screenshotFile}`);
    const signedCard = popup.locator('[data-testid="resource-item"]').filter({ hasText: signedUrl });
    await signedCard.locator('summary').click();
    await signedCard.locator('[data-testid="resource-url"]').scrollIntoViewIfNeeded();
    const expandedScreenshotFile = path.join(screenshotPath, `${usedBrowser}-expanded.png`);
    await popup.locator('.app').screenshot({ path: expandedScreenshotFile });
    console.log(`Screenshot: ${expandedScreenshotFile}`);
    assert.deepEqual(popupErrors, [], 'The popup must not raise page errors');
    await popup.evaluate((value) => navigator.clipboard.writeText(value), savedClipboard);
    savedClipboard = undefined;
    clipboardPage = undefined;
    await popup.close();

    const afterCloseUrl = `${baseUrl}/streams/after-popup-close.m3u8?auth=still-captured`;
    await request(pageA, afterCloseUrl);
    assert.ok((await waitForItems(tabA, 4)).items.some((item) => item.url === afterCloseUrl));
    pass('Background capture continues after the popup is closed');

    await pageA.evaluate((src) => new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.onload = () => resolve();
      frame.src = src;
      document.body.append(frame);
    }), `${baseUrl}/page-iframe`);
    const iframe = pageA.frame({ url: `${baseUrl}/page-iframe` });
    assert.ok(iframe, 'The local fixture iframe must load');
    const frameUrl = `${baseUrl}/streams/embedded.m3u8?token=iframe-source`;
    await request(iframe, frameUrl);
    assert.ok((await waitForItems(tabA, 5)).items.some((item) => item.url === frameUrl));
    pass('An embedded iframe capture belongs to its containing webpage and does not clear it');

    await pageA.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = 'Download attachment navigation fixture';
      link.dataset.testid = 'attachment-link';
      document.body.append(link);
    }, `${baseUrl}/attachment.txt`);
    const downloadPromise = pageA.waitForEvent('download');
    await pageA.locator('[data-testid="attachment-link"]').click();
    const download = await downloadPromise;
    await download.delete();
    assert.equal(pageA.url(), `${baseUrl}/page-a`);
    const afterAttachmentUrl = `${baseUrl}/streams/after-attachment.m3u8?token=still-the-original-page`;
    await request(pageA, afterAttachmentUrl);
    const afterAttachment = await waitForItems(tabA, 6);
    assert.ok(afterAttachment.items.some((item) => item.url === signedUrl));
    assert.ok(afterAttachment.items.some((item) => item.url === afterAttachmentUrl));
    pass('An attachment download preserves the original page captures and allows later HLS requests');

    await pageA.goto(`${baseUrl}/page-next`);
    assert.equal(await tabForPage(pageA), tabA);
    await waitForItems(tabA, 0);
    await activate(tabA);
    const emptyPopupPromise = context.waitForEvent('page');
    await worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, popupUrl);
    const emptyPopup = await emptyPopupPromise;
    await emptyPopup.setViewportSize({ width: 440, height: 590 });
    await emptyPopup.locator('[data-testid="empty-state"]').waitFor();
    assert.equal(await emptyPopup.locator('[data-testid="resource-item"]').count(), 0);
    assert.ok(await emptyPopup.locator('[data-testid="copy-all"]').isDisabled());
    const emptyScreenshotFile = path.join(screenshotPath, `${usedBrowser}-empty.png`);
    await emptyPopup.locator('.app').screenshot({ path: emptyScreenshotFile });
    console.log(`Screenshot: ${emptyScreenshotFile}`);
    await emptyPopup.close();
    pass('A new webpage shows the popup empty state with copy-all disabled');
    const nextUrl = `${baseUrl}/streams/new-page.m3u8?token=new-page`;
    await request(pageA, nextUrl);
    const nextCapture = await waitForItems(tabA, 1);
    assert.equal(nextCapture.items[0].url, nextUrl);
    assert.equal((await captureFor(tabB)).items[0].url, urlB);
    pass('Main-frame navigation clears the previous page without changing another tab');

    // A BFCache restoration emits pageshow, not DOMContentLoaded. Waiting for
    // Playwright's DOMContentLoaded navigation lifecycle would time out even
    // after the browser has successfully restored the document.
    await pageA.evaluate(() => { history.back(); });
    await eventually(async () => pageA.url(), (url) => url === `${baseUrl}/page-a`, 'History Back should restore the original webpage URL');
    await pageA.waitForFunction(() => window.__bfcacheRestored === true, undefined, { timeout: 3_000 }).catch(() => {});
    const bfcacheRestored = await pageA.evaluate(() => window.__bfcacheRestored === true);
    report.bfcacheRestored = bfcacheRestored;
    if (bfcacheRestored) {
      await waitForItems(tabA, 0);
      // Chromium restores this iframe DOM from BFCache without re-emitting all
      // CDP frame-attachment events, so read the real DOM instead of relying on
      // Playwright's stale frame inventory. The helper runs in the iframe realm.
      assert.equal(await pageA.evaluate(() => document.querySelector('iframe')?.contentDocument?.title), 'HLS verification /page-iframe');
      const restoredUrl = `${baseUrl}/streams/bfcache-restored-frame.m3u8?token=resumed-frame`;
      await pageA.evaluate(async (url) => {
        await document.querySelector('iframe').contentWindow.requestPlaylist(url);
      }, restoredUrl);
      const restoredCapture = await waitForItems(tabA, 1);
      assert.equal(restoredCapture.items[0].url, restoredUrl);
      pass('A real BFCache restore permits HLS requests from the restored embedded iframe');
    } else {
      const limitation = 'BFCache was not used by this browser run; restored-iframe capture verification remains incomplete.';
      report.limitations.push(limitation);
      console.log(`INCOMPLETE ${limitation}`);
    }

    const errorPage = await context.newPage();
    await errorPage.goto(`${baseUrl}/page-error-source`);
    const errorTab = await tabForPage(errorPage);
    await request(errorPage, `${baseUrl}/streams/before-network-error.m3u8?token=old-document`);
    await waitForItems(errorTab, 1);
    let navigationError;
    try {
      await errorPage.goto(`${baseUrl}/navigation-error`, { waitUntil: 'commit', timeout: 10_000 });
    } catch (error) { navigationError = error; }
    assert.ok(navigationError?.message.includes('net::ERR_'), 'The fixture must cause a genuine main-frame network failure');
    await eventually(
      () => errorPage.evaluate(() => document.documentURI).catch(() => ''),
      (uri) => uri.startsWith('chrome-error:'),
      'The browser must replace the previous page with its error document',
    );
    await waitForItems(errorTab, 0);
    await errorPage.close();
    pass('A failed main-frame navigation that opens an error document discards the previous webpage captures');

    await pageB.close();
    await eventually(
      () => worker.evaluate(async (tabId) => Object.keys(await chrome.storage.session.get(null)).includes(`tab:${tabId}`), tabB),
      (exists) => !exists,
      'Closing a browser tab must discard its capture state',
    );
    pass('Closing a browser tab removes its stored capture state');
    assert.deepEqual(workerErrors, [], 'The background worker must not report errors');
    console.log(`\nVerified ${checks.length} checks in ${usedBrowser}.`);
  } catch (error) {
    failure = error;
    report.error = error.stack || error.message;
    throw error;
  } finally {
    if (clipboardPage && savedClipboard !== undefined && !clipboardPage.isClosed()) {
      await clipboardPage.bringToFront().catch(() => {});
      await clipboardPage.evaluate((value) => navigator.clipboard.writeText(value), savedClipboard).catch(() => {});
    }
    try {
      await context?.close();
      report.cleanup.browserClosed = true;
    } catch (error) { console.error(`Browser close: ${error.message}`); }
    await new Promise((resolve) => fixture.close(resolve));
    report.cleanup.fixtureClosed = !fixture.listening;
    try {
      if (profile) await removeProfile(profile);
      report.cleanup.temporaryProfileRemoved = !profile || !existsSync(profile);
    } catch (error) { console.error(`Profile cleanup: ${error.message}`); }
    report.cleanup.complete = report.cleanup.browserClosed && report.cleanup.fixtureClosed && report.cleanup.temporaryProfileRemoved;
    report.finishedAt = new Date().toISOString();
    report.status = failure || !report.cleanup.complete ? 'failed' : report.limitations.length ? 'partial' : 'passed';
    await mkdir(screenshotPath, { recursive: true });
    const reportFile = path.join(screenshotPath, `${usedBrowser || requestedBrowser}-report.json`);
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Verification report: ${reportFile} (${report.status})`);
    if (report.cleanup.complete) console.log('Cleanup complete: verification browser, temporary profile, and loopback HTTP fixture are closed.');
    if (!failure && report.status !== 'passed') process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
