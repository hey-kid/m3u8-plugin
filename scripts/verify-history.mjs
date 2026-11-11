import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// All traffic and records belong to an isolated fixture and temporary profile.
// The user's normal Edge profile and browsing history are never opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.resolve(root, process.env.EXTENSION_DIST || 'dist');
const artifactPath = path.resolve(root, 'artifacts', 'verification');
const executablePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const headed = process.argv.includes('--headed');
const checks = [];
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  browser: 'edge',
  mode: headed ? 'headed' : 'headless',
  userAgent: null,
  profileIsolation: 'A newly created temporary profile; never a normal user profile.',
  fixture: null,
  realIndexedDB: false,
  browserRestarts: 0,
  expectedShutdownMessages: 0,
  passedChecks: checks,
  limitations: ['Controlled local HTTP fixtures; external video websites are not covered.'],
  status: 'running',
  cleanup: {
    clipboardRestored: true,
    browserClosed: false,
    fixtureClosed: false,
    fixturePortReleased: false,
    temporaryProfileRemoved: false,
    temporaryDownloadsRemoved: false,
    complete: false,
  },
};

function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function eventually(read, predicate, description, timeout = 20_000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeout) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}; last value: ${JSON.stringify(lastValue)}`);
}

async function removeTemporary(directory, prefix) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()), 'Cleanup must stay inside the temporary directory');
  assert.ok(path.basename(resolved).startsWith(prefix), 'Cleanup may only remove this script temporary directory');
  await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function evaluateTarget(cdp, sessionId, expression) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cdp.off('Target.receivedMessageFromTarget', receive);
      reject(new Error('Timed out evaluating the real action popup'));
    }, 5_000);
    const receive = (event) => {
      if (event.sessionId !== sessionId) return;
      const value = JSON.parse(event.message);
      if (value.id !== id) return;
      clearTimeout(timeout);
      cdp.off('Target.receivedMessageFromTarget', receive);
      if (value.error) reject(new Error(value.error.message));
      else if (value.result.exceptionDetails) reject(new Error(value.result.exceptionDetails.text));
      else resolve(value.result.result.value);
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

function fixtureServer() {
  const pending = new Map();
  const fixture = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/page-')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>历史验证 ${url.pathname}</title><body><h1>仅本地扩展验收</h1><p>验证脚本生成的测试请求。</p></body></html>`);
      return;
    }
    const sendPlaylist = () => {
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' });
      response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment.ts\n#EXT-X-ENDLIST\n');
    };
    if (url.pathname === '/slow-deletion.m3u8' && !pending.has('released')) {
      pending.set('release', sendPlaylist);
      return;
    }
    if (url.pathname.endsWith('.m3u8') || url.pathname === '/api/playlist') {
      sendPlaylist();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"fixture":true}');
  });
  return {
    fixture,
    releaseSlow() {
      pending.set('released', true);
      pending.get('release')?.();
      pending.delete('release');
    },
  };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
  assert.ok(manifest.background?.service_worker);
  assert.ok(manifest.action?.default_popup);
  assert.ok(existsSync(executablePath), `Microsoft Edge unavailable: ${executablePath}`);

  const { fixture, releaseSlow } = fixtureServer();
  let context;
  let worker;
  let profile;
  let downloads;
  let clipboardPage;
  let originalClipboard;
  let failure;
  let popupUrl;
  let browserClosing = false;
  const runtimeErrors = [];
  const watchPage = (page) => page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const launch = async () => {
    browserClosing = false;
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: !headed,
      acceptDownloads: true,
      downloadsPath: downloads,
      viewport: { width: 1200, height: 850 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    worker.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (browserClosing && message.text() === 'Unable to update captured playlist records. Error: The browser is shutting down.') {
        report.expectedShutdownMessages += 1;
        return;
      }
      runtimeErrors.push(message.text());
    });
    report.userAgent = await worker.evaluate(() => navigator.userAgent);
    assert.match(report.userAgent, /Edg\/\d+\./, 'This verification requires Microsoft Edge');
    popupUrl = `chrome-extension://${new URL(worker.url()).hostname}/${manifest.action.default_popup}`;
    console.log(`Browser: ${report.userAgent}; ${report.mode}; profile=${profile}`);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  };
  const tabForPage = async (page) => worker.evaluate(async (url) => (
    await chrome.tabs.query({})
  ).find((tab) => tab.url === url)?.id, page.url());
  const activeInternalTab = async (page) => {
    // The extension deliberately has no tabs permission, so privileged page
    // URLs are hidden from chrome.tabs.query. Their active tab IDs remain usable.
    await page.bringToFront();
    return worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  };
  const activate = async (tabId) => worker.evaluate(async (id) => { await chrome.tabs.update(id, { active: true }); }, tabId);
  const capture = async (tabId) => worker.evaluate(async (id) => {
    const key = `tab:${id}`;
    return (await chrome.storage.session.get(key))[key] || { tabId: id, items: [] };
  }, tabId);
  const history = async () => worker.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('m3u8-catcher-history');
    opening.onerror = () => reject(new Error(opening.error?.message || 'Unable to read real history database'));
    opening.onsuccess = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains('playlists')) {
        db.close();
        reject(new Error('Persistent history object store was not created'));
        return;
      }
      const transaction = db.transaction('playlists', 'readonly');
      const reading = transaction.objectStore('playlists').getAll();
      let records;
      reading.onsuccess = () => { records = reading.result; };
      transaction.oncomplete = () => { db.close(); resolve(records); };
      transaction.onerror = () => { db.close(); reject(new Error(transaction.error?.message || 'History read transaction failed')); };
    };
  }));
  const request = async (page, url) => page.evaluate(async (target) => {
    const response = await fetch(target, { cache: 'no-store' });
    await response.text();
    return response.status;
  }, url);
  const openPopup = async (activeTabId) => {
    if (activeTabId !== undefined) await activate(activeTabId);
    const waiting = context.waitForEvent('page');
    await worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, popupUrl);
    const page = await waiting;
    watchPage(page);
    await page.setViewportSize({ width: 440, height: 700 });
    await page.waitForLoadState('domcontentloaded');
    await page.locator('[data-testid="view-history"]').waitFor();
    return page;
  };
  const restoreClipboard = async () => {
    if (originalClipboard === undefined || !clipboardPage || clipboardPage.isClosed()) return;
    await clipboardPage.bringToFront();
    await clipboardPage.evaluate((text) => navigator.clipboard.writeText(text), originalClipboard);
    const restored = await clipboardPage.evaluate(() => navigator.clipboard.readText());
    report.cleanup.clipboardRestored = restored === originalClipboard;
    assert.ok(report.cleanup.clipboardRestored, 'Original clipboard text must be restored');
    clipboardPage = undefined;
  };

  try {
    profile = await mkdtemp(path.join(tmpdir(), 'm3u8-history-verify-'));
    downloads = await mkdtemp(path.join(tmpdir(), 'm3u8-history-downloads-'));
    await new Promise((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
    report.fixture = { host: '127.0.0.1', port: fixture.address().port, processId: process.pid };
    console.log(`Fixture started: ${baseUrl}; PID ${process.pid}. This script owns and closes the fixture, Edge, temporary profile and downloads in finally. Manual stop: Ctrl+C.`);
    await launch();
    await mkdir(artifactPath, { recursive: true });

    pass('An isolated Microsoft Edge context loads the persistent-history build');

    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto(`${baseUrl}/page-a`);
    await pageB.goto(`${baseUrl}/page-b`);
    const tabA = await tabForPage(pageA);
    const tabB = await tabForPage(pageB);
    assert.equal(typeof tabA, 'number');
    assert.equal(typeof tabB, 'number');
    const signedUrl = `${baseUrl}/streams/master.m3u8?token=a%2Bb%2Fz%3D&expires=20300101&quality=1080p`;
    const mimeOnlyUrl = `${baseUrl}/api/playlist?id=video-a&signature=signed%2Fvalue%3D`;
    const urlB = `${baseUrl}/streams/tab-b.m3u8?token=only-b`;
    const expectedUrls = new Set([signedUrl, mimeOnlyUrl, urlB]);
    await request(pageA, signedUrl);
    await request(pageA, mimeOnlyUrl);
    await request(pageA, signedUrl);
    await request(pageB, urlB);
    await request(pageB, signedUrl);
    const initialHistory = await eventually(history, (items) => items.length === 3
      && items.find((item) => item.url === signedUrl)?.requestCount === 3,
    'Global history must merge duplicate full URLs across tabs');
    assert.equal(initialHistory.find((item) => item.url === signedUrl).statusCode, 200);
    assert.ok(initialHistory.find((item) => item.url === mimeOnlyUrl).detectedBy.includes('content-type'));
    assert.ok(initialHistory.every((item) => item.pageUrl.startsWith(baseUrl)));
    const databases = await worker.evaluate(() => indexedDB.databases());
    assert.ok(databases.some((database) => database.name === 'm3u8-catcher-history'));
    report.realIndexedDB = true;
    pass('Real IndexedDB stores full signed and MIME-only URLs, source webpages, and cross-tab duplicate counts');

    const batchUrls = Array.from({ length: 325 }, (_, index) =>
      `${baseUrl}/streams/batch-${String(index).padStart(3, '0')}.m3u8?signature=full%2F${index}%2Btoken%3D`);
    for (const url of batchUrls) expectedUrls.add(url);
    await pageA.evaluate(async (urls) => {
      for (let start = 0; start < urls.length; start += 12) {
        await Promise.all(urls.slice(start, start + 12).map(async (url) => {
          const response = await fetch(url, { cache: 'no-store' });
          await response.text();
        }));
      }
    }, batchUrls);
    await eventually(history, (items) => items.length === expectedUrls.size
      && items.every((item) => item.statusCode === 200),
      'All 325 additional real HTTP resources must be archived', 45_000);
    const cappedCurrent = await eventually(() => capture(tabA), (state) => state.items.length === 300 && state.limitReached,
      'Current page must retain its independent 300-item cap');
    assert.equal(cappedCurrent.items.length, 300);
    const allCaptured = await history();
    assert.ok(batchUrls.every((url) => allCaptured.some((item) => item.url === url)));
    let previousSnapshot;
    let stableSince = Date.now();
    await eventually(async () => JSON.stringify((await history()).map((item) => [item.url, item.lastSeen, item.statusCode])),
      (snapshot) => {
        if (snapshot !== previousSnapshot) { previousSnapshot = snapshot; stableSince = Date.now(); }
        return Date.now() - stableSince >= 400;
      }, 'Initial real network writes must settle before comparing ordered pagination');
    pass('All 325 new URLs persist even beyond the current-page 300-item display cap');

    const popup = await openPopup(tabA);
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 300,
      'Current webpage view must keep its existing independent capture list');
    await popup.locator('[data-testid="view-history"]').click();
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 30,
      'History view must render a page of 30 records');
    const firstPageUrls = await popup.locator('[data-testid="resource-url"]').allTextContents();
    await popup.locator('[data-testid="history-next"]').click();
    await eventually(() => popup.locator('[data-testid="resource-url"]').allTextContents(),
      (urls) => urls.length === 30 && JSON.stringify(urls) !== JSON.stringify(firstPageUrls),
      'Next page must display a different group of history entries');
    await popup.locator('[data-testid="history-prev"]').click();
    await eventually(() => popup.locator('[data-testid="resource-url"]').allTextContents(),
      (urls) => JSON.stringify(urls) === JSON.stringify(firstPageUrls),
      'Previous page must restore the first page of history');
    pass('Popup keeps the current-page list and provides real paginated global history');

    await popup.bringToFront();
    clipboardPage = popup;
    originalClipboard = await popup.evaluate(() => navigator.clipboard.readText());
    report.cleanup.clipboardRestored = false;
    await popup.locator('[data-testid="history-search"]').fill('历史验证 /page-b');
    await eventually(() => popup.locator('[data-testid="resource-url"]').allTextContents(),
      (urls) => urls.length === 2 && urls.every((url) => [signedUrl, urlB].includes(url.trim())),
      'Search must match saved source webpage titles, including non-ASCII text');
    pass('History search finds saved source webpage titles as well as playlist URLs');
    await popup.locator('[data-testid="history-search"]').fill('batch-');
    await eventually(() => popup.locator('[data-testid="resource-url"]').allTextContents(),
      (urls) => urls.length === 30 && urls.every((url) => url.includes('batch-')),
      'Search must filter all history records');
    const firstResultUrl = (await popup.locator('[data-testid="resource-url"]').first().textContent()).trim();
    await popup.locator('[data-testid="copy-one"]').first().click();
    await eventually(() => popup.evaluate(() => navigator.clipboard.readText()), (value) => value === firstResultUrl,
      'Single copy must preserve the exact signed history URL');
    await popup.locator('[data-testid="copy-all"]').click();
    await eventually(() => popup.evaluate(() => navigator.clipboard.readText()), (value) => {
      const urls = value.split(/\r?\n/).filter(Boolean);
      return urls.length === batchUrls.length && new Set(urls).size === batchUrls.length
        && batchUrls.every((url) => urls.includes(url));
    }, 'Filtered copy all must include all 325 matches, across every page');
    await popup.locator('#toast').waitFor({ state: 'hidden' });
    await popup.locator('.app').screenshot({ path: path.join(artifactPath, 'history-search.png') });
    pass('Search and real clipboard copying preserve all signed matching URLs across pagination');

    await popup.locator('[data-testid="history-search"]').fill('no-such-hls-resource');
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 0,
      'An unmatched search must show an empty state');
    assert.ok(await popup.locator('[data-testid="copy-all"]').isDisabled());
    await popup.locator('[data-testid="empty-state"]').waitFor();
    await popup.locator('.app').screenshot({ path: path.join(artifactPath, 'history-empty.png') });
    await popup.locator('[data-testid="history-search"]').fill('');
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 30,
      'Clearing search must restore the history list');
    pass('No-match history search displays a clear empty state and disables copy all');

    const popup2 = await openPopup(tabA);
    await popup2.locator('[data-testid="view-history"]').click();
    await eventually(() => popup2.locator('[data-testid="resource-item"]').count(), (count) => count === 30,
      'A second popup must read the same persistent history');
    const liveUrl = `${baseUrl}/streams/live-history.m3u8?signature=arrives%2Bwhile%2Fopen%3D`;
    expectedUrls.add(liveUrl);
    await request(pageA, liveUrl);
    for (const page of [popup, popup2]) {
      await eventually(() => page.locator('[data-testid="resource-url"]').allTextContents(),
        (urls) => urls.some((url) => url.trim() === liveUrl),
        'Every open popup must refresh when new history is captured');
    }
    await Promise.all([
      pageA.evaluate(async (url) => {
        await Promise.all(Array.from({ length: 6 }, async () => (await fetch(url, { cache: 'no-store' })).text()));
      }, signedUrl),
      pageB.evaluate(async (url) => {
        await Promise.all(Array.from({ length: 6 }, async () => (await fetch(url, { cache: 'no-store' })).text()));
      }, signedUrl),
    ]);
    await eventually(history, (items) => items.find((item) => item.url === signedUrl)?.requestCount === 15,
      'Concurrent real requests from two tabs must not lose duplicate counts');
    pass('Two open popups update live, and concurrent cross-tab writes preserve exact duplicate counts');

    const racingUpdate = request(pageB, liveUrl);
    await popup.locator('[data-testid="history-search"]').fill('batch-00');
    await popup.locator('[data-testid="history-search"]').fill('batch-01');
    await popup.locator('[data-testid="history-search"]').fill('batch-0');
    await racingUpdate;
    await eventually(() => popup.locator('[data-testid="resource-url"]').allTextContents(),
      (urls) => urls.length === 30 && urls.every((url) => url.includes('/batch-0')),
      'A live update racing rapid search edits must not overwrite the latest filter');
    await popup.bringToFront();
    await popup.locator('[data-testid="copy-all"]').click();
    const narrowedUrls = batchUrls.filter((url) => url.includes('/batch-0'));
    await eventually(() => popup.evaluate(() => navigator.clipboard.readText()), (value) => {
      const urls = value.split(/\r?\n/).filter(Boolean);
      return urls.length === narrowedUrls.length && new Set(urls).size === narrowedUrls.length
        && narrowedUrls.every((url) => urls.includes(url));
    }, 'Copy all must respect the latest search despite concurrent background writes');
    pass('Rapid search changes racing a background capture retain the latest filter and exact matching copy-all');

    const slowUrl = `${baseUrl}/slow-deletion.m3u8?token=delete%2Fduring%2Brequest%3D`;
    const slowRequest = request(pageA, slowUrl);
    // Keep an early assertion failure from turning browser shutdown into an
    // unhandled rejection before the shared finally cleanup can complete.
    slowRequest.catch(() => {});
    await eventually(history, (items) => items.some((item) => item.url === slowUrl),
      'URL detection must archive the slow request before response headers arrive');
    await popup.locator('[data-testid="status-pending"]').click();
    await popup.locator('[data-testid="history-search"]').fill('slow-deletion');
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 1,
      'The pending request must be findable in history');
    await popup.locator('[data-testid="delete-one"]').click();
    await popup.locator('[data-testid="cancel-delete"]').click();
    assert.ok((await history()).some((item) => item.url === slowUrl), 'Cancelling deletion must preserve the record');
    await popup.locator('[data-testid="delete-one"]').click();
    await popup.locator('[data-testid="confirm-delete"]').click();
    await eventually(history, (items) => !items.some((item) => item.url === slowUrl),
      'Confirmed deletion must commit to IndexedDB');
    releaseSlow();
    assert.equal(await slowRequest, 200);
    await eventually(() => capture(tabA), (state) => state.items.every((item) => item.url !== slowUrl || item.statusCode === 200),
      'The original slow request must finish');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!(await history()).some((item) => item.url === slowUrl), 'Late headers/completed events must not resurrect a deleted record');
    await request(pageA, slowUrl);
    expectedUrls.add(slowUrl);
    const recaptured = await eventually(history, (items) => items.some((item) => item.url === slowUrl && item.statusCode === 200),
      'A genuinely new request must allow a deleted URL to be captured again');
    assert.equal(recaptured.find((item) => item.url === slowUrl).requestCount, 1);
    pass('Delete confirmation is reversible before commit; late request events do not resurrect a deletion, but a new request captures it again');

    await popup.locator('[data-testid="status-normal"]').click();
    await popup.locator('[data-testid="history-search"]').fill('tab-b.m3u8');
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 1,
      'A different stored record must be searchable for deletion');
    await popup.locator('[data-testid="delete-one"]').click();
    await popup.locator('[data-testid="confirm-delete"]').click();
    expectedUrls.delete(urlB);
    await eventually(history, (items) => items.length === expectedUrls.size && !items.some((item) => item.url === urlB),
      'Deleting one URL must preserve every other historical record');
    await popup.locator('[data-testid="history-search"]').fill('batch-');
    await eventually(() => popup.locator('[data-testid="resource-url"]').allTextContents(),
      (urls) => urls.length === 30 && urls.every((url) => url.includes('batch-')),
      'Export is verified while a search filter is active');
    await popup.bringToFront();
    const downloadWaiting = popup.waitForEvent('download');
    await popup.locator('[data-testid="export-history"]').click();
    const download = await downloadWaiting;
    assert.match(download.suggestedFilename(), /\.json$/i);
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.format, 'm3u8-catcher-history');
    assert.equal(exported.version, 1);
    assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
    assert.equal(exported.count, expectedUrls.size);
    assert.equal(exported.items.length, expectedUrls.size);
    assert.deepEqual(new Set(exported.items.map((item) => item.url)), expectedUrls);
    assert.ok(exported.items.some((item) => item.url === signedUrl && item.requestCount === 15));
    assert.ok(exported.items.every((item) => item.pageUrl && typeof item.pageTitle === 'string'));
    await download.delete();
    report.exportedRecords = exported.count;
    pass('A real JSON download exports the entire database, unaffected by the active search filter');

    await pageA.reload();
    await eventually(() => capture(tabA), (state) => state.items.length === 0,
      'Refreshing the webpage resets its current-page list');
    assert.deepEqual(new Set((await history()).map((item) => item.url)), expectedUrls);
    await pageA.close();
    await pageB.close();
    const internal = await context.newPage();
    await internal.goto('edge://extensions/');
    const internalTab = await activeInternalTab(internal);
    assert.equal(typeof internalTab, 'number', 'The internal Edge page must resolve to a real browser tab');
    await activate(internalTab);
    await popup.locator('[data-testid="history-search"]').fill('');
    await popup.reload();
    await popup.locator('[data-testid="view-history"]').click();
    await eventually(() => popup.locator('[data-testid="resource-item"]').count(), (count) => count === 30,
      'Global history must remain available from an Edge internal page after all source tabs close');
    await popup.locator('#toast').waitFor({ state: 'hidden' });
    await popup.locator('#resource-list').evaluate((list) => { list.scrollTop = 0; });
    await eventually(() => popup.locator('[data-testid="copy-all"]').isEnabled(), Boolean,
      'History actions must be ready before the final screenshot');
    await popup.locator('.app').screenshot({ path: path.join(artifactPath, 'history-popup.png') });
    assert.deepEqual(new Set((await history()).map((item) => item.url)), expectedUrls);
    pass('Refresh and closing all source tabs preserve history; it remains accessible on an Edge internal page');

    const popupCdp = await context.newCDPSession(internal);
    let actionTarget;
    try {
      const existingTargets = new Set((await popupCdp.send('Target.getTargets')).targetInfos.map((info) => info.targetId));
      await worker.evaluate(async (id) => {
        const tab = await chrome.tabs.get(id);
        await chrome.tabs.update(id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.action.openPopup({ windowId: tab.windowId });
      }, internalTab);
      actionTarget = await eventually(async () => {
        const { targetInfos } = await popupCdp.send('Target.getTargets');
        return targetInfos.find((info) => info.url === popupUrl && !existingTargets.has(info.targetId));
      }, Boolean, 'The actual browser action must expose its popup target');
      const { sessionId } = await popupCdp.send('Target.attachToTarget', { targetId: actionTarget.targetId, flatten: false });
      await evaluateTarget(popupCdp, sessionId, "document.querySelector('[data-testid=\"view-history\"]').click(); true");
      await eventually(() => evaluateTarget(popupCdp, sessionId,
        "JSON.stringify({urls:Array.from(document.querySelectorAll('[data-testid=\"resource-url\"]'),node=>node.textContent),total:document.querySelector('[data-testid=\"history-total\"]')?.textContent,error:document.querySelector('#error-state')?.hidden===false})"),
      (value) => {
        const state = JSON.parse(value);
        return state.urls.length === 30 && Number(state.total) === expectedUrls.size && !state.error
          && state.urls.every((url) => expectedUrls.has(url.trim()));
      }, 'The actual action popup must show persisted global history on the internal Edge page');
      report.actionPopupHistoryVerified = true;
      pass('The real Edge action popup opens and displays global history even on an internal browser page');
    } finally {
      if (actionTarget) await popupCdp.send('Target.closeTarget', { targetId: actionTarget.targetId }).catch(() => {});
      await popupCdp.detach().catch(() => {});
    }

    await restoreClipboard();
    browserClosing = true;
    await context.close();
    context = undefined;
    report.browserRestarts += 1;
    await launch();
    const reopenedHistory = await eventually(history, (items) => items.length === expectedUrls.size,
      'The same temporary profile must retain history after Edge closes and restarts');
    assert.deepEqual(new Set(reopenedHistory.map((item) => item.url)), expectedUrls);
    assert.ok(!reopenedHistory.some((item) => item.url === urlB), 'Deleted records must remain deleted after restart');
    const restartedInternal = await context.newPage();
    await restartedInternal.goto('edge://extensions/');
    const restartedPopup = await openPopup(await activeInternalTab(restartedInternal));
    await restartedPopup.locator('[data-testid="view-history"]').click();
    await eventually(() => restartedPopup.locator('[data-testid="resource-item"]').count(), (count) => count === 30,
      'The restarted browser popup must display persisted records');
    await restartedPopup.bringToFront();
    clipboardPage = restartedPopup;
    report.cleanup.clipboardRestored = false;
    await restartedPopup.locator('[data-testid="copy-all"]').click();
    await eventually(() => restartedPopup.evaluate(() => navigator.clipboard.readText()), (text) => {
      const urls = text.split(/\r?\n/).filter(Boolean);
      return urls.length === expectedUrls.size && urls.every((url) => expectedUrls.has(url));
    }, 'Copy all after browser restart must include every persisted address');
    await restoreClipboard();
    assert.deepEqual(runtimeErrors, [], 'Background and popup scripts must not raise errors');
    report.persistedRecordsAfterRestart = reopenedHistory.length;
    pass('Closing and restarting Edge with the same isolated profile preserves history, deletion, and working copy-all');
    console.log(`Verified ${checks.length} persistent-history checks in Microsoft Edge ${report.mode}.`);
  } catch (error) {
    failure = error;
    report.error = error.stack || error.message;
    throw error;
  } finally {
    releaseSlow();
    try { await restoreClipboard(); } catch (error) {
      report.cleanup.clipboardRestored = false;
      console.error(`Clipboard cleanup: ${error.message}`);
    }
    try {
      browserClosing = true;
      await context?.close();
      report.cleanup.browserClosed = true;
    } catch (error) { console.error(`Browser cleanup: ${error.message}`); }
    if (fixture.listening) {
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
    report.cleanup.fixtureClosed = !fixture.listening;
    if (report.fixture && report.cleanup.fixtureClosed) {
      const probe = createServer();
      try {
        await new Promise((resolve, reject) => {
          probe.once('error', reject);
          probe.listen(report.fixture.port, '127.0.0.1', resolve);
        });
        await new Promise((resolve) => probe.close(resolve));
        report.cleanup.fixturePortReleased = true;
      } catch (error) {
        probe.close();
        console.error(`Fixture port cleanup: ${error.message}`);
      }
    } else if (!report.fixture) report.cleanup.fixturePortReleased = true;
    for (const [directory, prefix, key] of [
      [profile, 'm3u8-history-verify-', 'temporaryProfileRemoved'],
      [downloads, 'm3u8-history-downloads-', 'temporaryDownloadsRemoved'],
    ]) {
      try {
        if (directory) await removeTemporary(directory, prefix);
        report.cleanup[key] = !directory || !existsSync(directory);
      } catch (error) { console.error(`Temporary directory cleanup: ${error.message}`); }
    }
    report.cleanup.complete = Object.entries(report.cleanup)
      .filter(([key]) => key !== 'complete').every(([, value]) => value === true);
    report.finishedAt = new Date().toISOString();
    report.status = failure || !report.cleanup.complete ? 'failed' : 'passed';
    await mkdir(artifactPath, { recursive: true });
    const reportFile = path.join(artifactPath, 'history-report.json');
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`History verification report: ${reportFile} (${report.status})`);
    if (report.cleanup.complete) console.log('Cleanup complete: clipboard restored; Edge, fixture, temporary profile and downloads closed or removed.');
    if (!failure && !report.cleanup.complete) process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
