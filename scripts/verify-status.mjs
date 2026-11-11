import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Every request is local, and every captured record belongs to this script's
// disposable Edge profile. No normal browser profile or live video site is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.resolve(root, process.env.EXTENSION_DIST || 'dist');
const artifactPath = path.join(root, 'artifacts', 'verification');
const executablePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const headed = process.argv.includes('--headed');
const checks = [];
const report = {
  startedAt: new Date().toISOString(), finishedAt: null, browser: 'edge',
  mode: headed ? 'headed' : 'headless', userAgent: null, extensionVersion: null,
  fixture: null, browserRestarts: 0, exportedRecords: 0, persistedRecordsAfterRestart: 0,
  passedChecks: checks, screenshots: [], status: 'running',
  limitations: ['Controlled local HTTP fixtures; external video websites are not covered.'],
  cleanup: {
    clipboardRestored: true, browserClosed: false, fixtureClosed: false,
    fixturePortReleased: false, temporaryProfileRemoved: false,
    temporaryDownloadsRemoved: false, complete: false,
  },
};

function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(read, predicate, description, timeout = 20_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeout) {
    value = await read();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`${description}; last value: ${JSON.stringify(value)}`);
}
async function removeTemporary(directory, prefix) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()), 'Cleanup must stay inside the temporary directory');
  assert.ok(path.basename(resolved).startsWith(prefix), 'Cleanup must only remove this script temporary directory');
  await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
function classify(item) {
  if (typeof item.error === 'string' && item.error.trim()) return 'abnormal';
  if (!Number.isInteger(item.statusCode) || item.statusCode < 100 || item.statusCode > 599) return 'pending';
  return item.statusCode >= 200 && item.statusCode <= 299 ? 'normal' : 'abnormal';
}
const sameUrls = (actual, expected) => actual.length === expected.length
  && new Set(actual.map((url) => url.trim())).size === expected.length
  && expected.every((url) => actual.map((value) => value.trim()).includes(url));

function createFixture() {
  const pending = new Map();
  let transitionStatus = 200;
  let racingRequests = 0;
  let recoveryRequests = 0;
  let legacyRequests = 0;
  let rangeRequests = 0;
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
  const send = (response, status = 200, rangeHeader) => {
    if (response.destroyed) return;
    if (status === 206) {
      const bytes = Buffer.from(playlist);
      const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '');
      if (!range) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); response.end(); return; }
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
      if (start > end || start >= bytes.length) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); response.end(); return; }
      rangeRequests += 1;
      response.writeHead(206, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1,
      });
      response.end(bytes.subarray(start, end + 1)); return;
    }
    response.writeHead(status, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' });
    response.end(playlist);
  };
  const fixture = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/page-')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>清晰分类 · 本地状态验证</title><body><h1>仅本地扩展状态验收</h1><p>请求由验证脚本触发。</p></body></html>');
    } else if (url.pathname === '/redirect.m3u8') {
      response.writeHead(302, { Location: '/redirect-target.m3u8?token=redirect%2Btarget%3D' }); response.end();
    } else if (url.pathname === '/reset.m3u8') {
      request.socket.destroy();
    } else if (url.pathname === '/headers-reset.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': '10000' });
      response.flushHeaders(); response.write('#EXTM3U\n#EXT-X-VERSION:3\n');
      const timer = setTimeout(() => response.destroy(), 150);
      response.once('close', () => clearTimeout(timer));
    } else if (url.pathname === '/slow.m3u8') {
      pending.set('slow', () => send(response));
    } else if (url.pathname === '/transition.m3u8') {
      send(response, transitionStatus, request.headers.range);
    } else if (url.pathname === '/legacy-206.m3u8') {
      legacyRequests += 1; send(response);
    } else if (url.pathname === '/racing.m3u8') {
      racingRequests += 1;
      if (racingRequests === 1) pending.set('racing', () => send(response));
      else send(response, 404);
    } else if (url.pathname === '/error-recovery.m3u8') {
      recoveryRequests += 1;
      if (recoveryRequests === 1) {
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': '10000' });
        response.flushHeaders(); response.write('#EXTM3U\n');
      }
      pending.set(recoveryRequests === 1 ? 'recovery-error' : 'recovery-200',
        recoveryRequests === 1 ? () => response.destroy() : () => send(response));
    } else if (/^\/http\/\d+\.m3u8$/.test(url.pathname)) {
      send(response, Number(url.pathname.match(/\d+/)[0]), request.headers.range);
    } else if (/^\/batch\/(200|404)-\d+\.m3u8$/.test(url.pathname)) {
      send(response, Number(url.pathname.match(/\/batch\/(\d+)-/)[1]));
    } else if (url.pathname.endsWith('.m3u8')) {
      send(response);
    } else { response.writeHead(404); response.end('Local fixture route not found.'); }
  });
  return {
    fixture,
    setTransition(status) { transitionStatus = status; },
    legacyRequests() { return legacyRequests; },
    rangeRequests() { return rangeRequests; },
    hasPending(name) { return pending.has(name); },
    release(name) { pending.get(name)?.(); pending.delete(name); },
    releaseAll() { for (const release of pending.values()) release(); pending.clear(); },
  };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  report.extensionVersion = manifest.version;
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background?.service_worker && manifest.action?.default_popup);
  assert.ok(existsSync(executablePath), `Microsoft Edge unavailable: ${executablePath}`);
  const server = createFixture();
  const { fixture } = server;
  let context; let worker; let profile; let downloads; let popupUrl; let failure;
  let clipboardPage; let originalClipboard; let browserClosing = false;
  const runtimeErrors = [];
  const launch = async () => {
    browserClosing = false;
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: !headed, acceptDownloads: true, downloadsPath: downloads,
      viewport: { width: 1200, height: 900 }, args: [
        `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        '--no-first-run', '--no-default-browser-check',
      ],
    });
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    worker.on('console', (message) => {
      if (message.type() === 'error' && !(browserClosing && /browser is shutting down/i.test(message.text()))) runtimeErrors.push(message.text());
    });
    report.userAgent = await worker.evaluate(() => navigator.userAgent);
    assert.match(report.userAgent, /Edg\/\d+\./, 'This verification requires Microsoft Edge');
    popupUrl = `chrome-extension://${new URL(worker.url()).hostname}/${manifest.action.default_popup}`;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    console.log(`Browser: ${report.userAgent}; profile=${profile}`);
  };
  const history = async () => worker.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('m3u8-catcher-history');
    request.onerror = () => reject(new Error(request.error?.message || 'Unable to open history'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('playlists')) { db.close(); reject(new Error('History store not created')); return; }
      const transaction = db.transaction('playlists', 'readonly');
      const reading = transaction.objectStore('playlists').getAll();
      let rows;
      reading.onsuccess = () => { rows = reading.result; };
      transaction.oncomplete = () => { db.close(); resolve(rows); };
      transaction.onerror = () => { db.close(); reject(new Error(transaction.error?.message || 'Unable to read history')); };
    };
  }));
  const tabForPage = async (page) => worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, page.url());
  const capture = async (tabId) => worker.evaluate(async (id) => {
    const key = `tab:${id}`; return (await chrome.storage.session.get(key))[key] || { items: [] };
  }, tabId);
  const request = async (page, url, { range = false } = {}) => page.evaluate(async ({ target, range }) => {
    try {
      const response = await fetch(target, { cache: 'no-store', ...(range ? { headers: { Range: 'bytes=0-31' } } : {}) });
      const body = await response.arrayBuffer();
      return { status: response.status, contentRange: response.headers.get('Content-Range'), bodyLength: body.byteLength };
    }
    catch (error) { return { error: error.message }; }
  }, { target: url, range });
  const openPopup = async (tabId) => {
    if (tabId !== undefined) await worker.evaluate(async (id) => { await chrome.tabs.update(id, { active: true }); }, tabId);
    const waiting = context.waitForEvent('page');
    await worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, popupUrl);
    const popup = await waiting;
    popup.on('pageerror', (error) => runtimeErrors.push(error.message));
    await popup.setViewportSize({ width: 440, height: 590 });
    await popup.waitForLoadState('domcontentloaded');
    await popup.locator('[data-testid="status-normal"]').waitFor();
    return popup;
  };
  const shownUrls = (popup) => popup.locator('[data-testid="resource-url"]').allTextContents();
  const choose = async (popup, category, expected) => {
    await popup.locator(`[data-testid="status-${category}"]`).click();
    if (expected) await eventually(() => shownUrls(popup), (urls) => sameUrls(urls, expected), `The ${category} list must contain exactly the selected category`);
  };
  const restoreClipboard = async () => {
    if (originalClipboard === undefined || !clipboardPage || clipboardPage.isClosed()) return;
    await clipboardPage.bringToFront();
    await clipboardPage.evaluate((value) => navigator.clipboard.writeText(value), originalClipboard);
    report.cleanup.clipboardRestored = (await clipboardPage.evaluate(() => navigator.clipboard.readText())) === originalClipboard;
    assert.ok(report.cleanup.clipboardRestored, 'The original text clipboard must be restored');
    clipboardPage = undefined;
  };
  const verifyCopyAll = async (popup, expected) => {
    await popup.bringToFront();
    await eventually(() => popup.locator('[data-testid="copy-all"]').isEnabled(), Boolean, 'Copy all must be ready');
    await popup.locator('[data-testid="copy-all"]').click();
    await eventually(() => popup.evaluate(() => navigator.clipboard.readText()),
      (value) => sameUrls(value.split(/\r?\n/).filter(Boolean), expected), 'Real clipboard copy all must match the selected status and search across every page');
  };
  const screenshot = async (popup, category) => {
    await popup.locator('#toast').waitFor({ state: 'hidden' });
    if (await popup.locator('#resource-list').isVisible()) await popup.locator('#resource-list').evaluate((list) => { list.scrollTop = 0; });
    const file = path.join(artifactPath, `status-${category}.png`);
    await popup.locator('.app').screenshot({ path: file }); report.screenshots.push(file);
  };

  try {
    profile = await mkdtemp(path.join(tmpdir(), 'm3u8-status-verify-'));
    downloads = await mkdtemp(path.join(tmpdir(), 'm3u8-status-downloads-'));
    await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
    report.fixture = { host: '127.0.0.1', port: fixture.address().port, processId: process.pid };
    console.log(`Status fixture started: ${baseUrl}; PID ${process.pid}. This script owns and closes Edge, fixture, temporary profile and downloads in finally. Manual stop: Ctrl+C.`);
    await launch(); await mkdir(artifactPath, { recursive: true });
    const page = await context.newPage(); await page.goto(`${baseUrl}/page-status`);
    const tabId = await tabForPage(page); assert.equal(typeof tabId, 'number');
    const normalStatuses = [200, 201, 204, 206, 299];
    const normalUrls = normalStatuses.map((status) => `${baseUrl}/http/${status}.m3u8?signature=normal%2B${status}%2Ffull%3D`);
    const abnormalStatuses = [300, 403, 404, 500];
    const abnormalUrls = abnormalStatuses.map((status) => `${baseUrl}/http/${status}.m3u8?signature=status%2B${status}%3D`);
    const redirectUrl = `${baseUrl}/redirect.m3u8`;
    const redirectTarget = `${baseUrl}/redirect-target.m3u8?token=redirect%2Btarget%3D`;
    const resetUrl = `${baseUrl}/reset.m3u8`;
    const headersResetUrl = `${baseUrl}/headers-reset.m3u8`;
    const slowUrl = `${baseUrl}/slow.m3u8?token=pending%2Bfull%2Furl%3D`;
    for (let index = 0; index < normalUrls.length; index += 1) {
      const result = await request(page, normalUrls[index], { range: normalStatuses[index] === 206 });
      assert.equal(result.status, normalStatuses[index]);
      if (result.status === 206) {
        assert.match(result.contentRange, /^bytes 0-31\/\d+$/);
        assert.equal(result.bodyLength, 32, 'HTTP 206 must use an actual Range request and partial response');
      }
    }
    for (let index = 0; index < abnormalUrls.length; index += 1) assert.equal((await request(page, abnormalUrls[index])).status, abnormalStatuses[index]);
    assert.equal((await request(page, redirectUrl)).status, 200);
    assert.ok((await request(page, resetUrl)).error);
    assert.ok((await request(page, headersResetUrl)).error);
    const slowRequest = request(page, slowUrl); slowRequest.catch(() => {});
    const capturedInitial = new Set([...normalUrls, ...abnormalUrls, redirectUrl, redirectTarget, resetUrl, headersResetUrl, slowUrl]);
    const initial = await eventually(history, (items) => items.length === capturedInitial.size
      && items.find((item) => item.url === headersResetUrl)?.error
      && items.find((item) => item.url === resetUrl)?.error,
    'Real network statuses, redirects, errors and pending records must persist');
    for (const items of [initial, (await capture(tabId)).items]) {
      for (const [index, url] of normalUrls.entries()) {
        const item = items.find((entry) => entry.url === url);
        assert.equal(item.statusCode, normalStatuses[index]); assert.equal(classify(item), 'normal');
      }
      for (const [index, url] of abnormalUrls.entries()) {
        const item = items.find((entry) => entry.url === url);
        assert.equal(item.statusCode, abnormalStatuses[index]); assert.equal(classify(item), 'abnormal');
      }
      assert.equal(items.find((item) => item.url === redirectUrl).statusCode, 302);
      assert.equal(classify(items.find((item) => item.url === redirectUrl)), 'abnormal');
      assert.equal(classify(items.find((item) => item.url === redirectTarget)), 'normal');
      assert.equal(items.find((item) => item.url === headersResetUrl).statusCode, 200);
      assert.equal(classify(items.find((item) => item.url === headersResetUrl)), 'abnormal');
      assert.equal(classify(items.find((item) => item.url === resetUrl)), 'abnormal');
      assert.equal(classify(items.find((item) => item.url === slowUrl)), 'pending');
    }
    pass('Real HTTP 200, 201, 204, 206 and 299 requests are normal in current and IndexedDB history; HTTP 300, 403, 404 and 500 remain abnormal');
    assert.equal(server.rangeRequests(), 1);
    pass('HTTP 206 uses a real bytes=0-31 Range request, a valid Content-Range header and an exact 32-byte partial response');
    pass('Redirect source HTTP 302 remains abnormal while its separate HTTP 200 target is normal');
    pass('Connection failures with no headers and failures after HTTP 200 headers are abnormal; errors take precedence over 200');
    pass('Requests without a response remain pending and are still archived');

    // A v0.3.1 record already contains the raw HTTP status, without a stored
    // category. Seed that unchanged schema to prove reading it applies the new
    // 2xx rule without a migration or any request to the original address.
    const legacyUrl = `${baseUrl}/legacy-206.m3u8?token=preexisting%2B206%3D`;
    const legacyRecord = {
      id: 'legacy-206-unchanged-schema', url: legacyUrl, hostname: '127.0.0.1',
      firstSeen: Date.now() - 86_400_000, lastSeen: Date.now() - 86_400_000,
      requestCount: 1, method: 'GET', statusCode: 206, detectedBy: ['url'],
      pageUrl: `${baseUrl}/page-previous-version`, pageTitle: '升级前已保存的 HTTP 206 记录',
    };
    await worker.evaluate((item) => new Promise((resolve, reject) => {
      const opening = indexedDB.open('m3u8-catcher-history', 1);
      opening.onerror = () => reject(new Error(opening.error?.message || 'Unable to open legacy history'));
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction('playlists', 'readwrite');
        transaction.objectStore('playlists').put(item);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(new Error(transaction.error?.message || 'Unable to seed old HTTP 206 record')); };
      };
    }), legacyRecord);
    assert.deepEqual((await history()).find((item) => item.url === legacyUrl), legacyRecord);
    assert.equal(server.legacyRequests(), 0);
    const expectedInitial = new Set([...capturedInitial, legacyUrl]);

    const popup = await openPopup(tabId);
    await eventually(() => shownUrls(popup), (urls) => sameUrls(urls, [...normalUrls, redirectTarget]), 'All successful HTTP 2xx responses must be the initial visible list');
    await popup.bringToFront(); clipboardPage = popup;
    originalClipboard = await popup.evaluate(() => navigator.clipboard.readText()); report.cleanup.clipboardRestored = false;
    await verifyCopyAll(popup, [...normalUrls, redirectTarget]);
    await screenshot(popup, 'normal');
    pass('The popup defaults to every successful HTTP 2xx response, and current-page copy all excludes abnormal and pending addresses');
    const abnormalInitial = [...abnormalUrls, redirectUrl, resetUrl, headersResetUrl];
    await choose(popup, 'abnormal', abnormalInitial);
    await verifyCopyAll(popup, abnormalInitial);
    await screenshot(popup, 'abnormal');
    await choose(popup, 'pending', [slowUrl]);
    await screenshot(popup, 'pending');
    await choose(popup, 'all', [...capturedInitial]);
    pass('Current-page normal, abnormal, pending and all filters show exact non-overlapping groups without deleting any record');
    await popup.locator('[data-testid="view-history"]').click();
    await choose(popup, 'normal', [...normalUrls, redirectTarget, legacyUrl]);
    assert.equal(server.legacyRequests(), 0);
    pass('A preexisting HTTP 206 history record appears as normal without refetching, changing the stored record or migrating the database');
    await choose(popup, 'abnormal', abnormalInitial);
    await choose(popup, 'pending', [slowUrl]);
    await verifyCopyAll(popup, [slowUrl]);
    const pendingDownloadWaiting = popup.waitForEvent('download');
    await popup.locator('[data-testid="export-history"]').click();
    const pendingDownload = await pendingDownloadWaiting;
    const pendingBackup = JSON.parse(await readFile(await pendingDownload.path(), 'utf8'));
    assert.deepEqual(new Set(pendingBackup.items.map((item) => item.url)), expectedInitial);
    assert.ok(pendingBackup.items.some((item) => item.url === slowUrl && classify(item) === 'pending'));
    await pendingDownload.delete();
    pass('History shows the same three categories as the current page; pending addresses can be copied and are included in full backups');
    await popup.locator('[data-testid="view-current"]').click();
    await choose(popup, 'pending', [slowUrl]); server.release('slow');
    assert.equal((await slowRequest).status, 200);
    await eventually(() => shownUrls(popup), (urls) => urls.length === 0, 'A pending request must leave the pending list after HTTP 200 arrives');
    assert.ok(await popup.locator('[data-testid="copy-all"]').isDisabled());
    await choose(popup, 'normal', [...normalUrls, redirectTarget, slowUrl]);
    pass('An open popup moves a pending request to normal automatically and disables copying an empty category');

    const transitionUrl = `${baseUrl}/transition.m3u8?signature=keep%2Bthe%2Fsame%3D`;
    for (const status of [200, 404, 206]) {
      server.setTransition(status); assert.equal((await request(page, transitionUrl, { range: status === 206 })).status, status);
      await eventually(history, (items) => items.find((item) => item.url === transitionUrl)?.statusCode === status,
        `History must follow the latest same-URL response HTTP ${status}`);
      const current = await eventually(() => capture(tabId), (state) => state.items.find((item) => item.url === transitionUrl)?.statusCode === status,
        `Current capture must follow the latest same-URL response HTTP ${status}`);
      const successful = status >= 200 && status <= 299;
      assert.equal(classify(current.items.find((item) => item.url === transitionUrl)), successful ? 'normal' : 'abnormal');
      await choose(popup, successful ? 'normal' : 'abnormal');
      await eventually(() => shownUrls(popup), (urls) => urls.includes(transitionUrl), 'The live selected list must include the latest state');
      await choose(popup, successful ? 'abnormal' : 'normal');
      await eventually(() => shownUrls(popup), (urls) => !urls.includes(transitionUrl), 'The prior list must no longer include the changed URL');
    }
    const transitioned = (await history()).find((item) => item.url === transitionUrl);
    assert.equal(transitioned.requestCount, 3);
    assert.equal(server.rangeRequests(), 2);
    pass('Repeated requests for the same full URL move 200 → 404 → 206 in both scopes, restoring normal classification while preserving one record and all three captures');

    const racingUrl = `${baseUrl}/racing.m3u8?token=old%2Brequest%3D`;
    const olderRequest = request(page, racingUrl); olderRequest.catch(() => {});
    await eventually(history, (items) => items.some((item) => item.url === racingUrl), 'The old pending request must be captured before a newer same-URL request');
    await eventually(() => server.hasPending('racing'), Boolean, 'The server must receive the old request before starting the competing request');
    assert.equal((await request(page, racingUrl)).status, 404);
    await eventually(history, (items) => items.find((item) => item.url === racingUrl)?.statusCode === 404, 'Newer request must become abnormal');
    server.release('racing'); assert.equal((await olderRequest).status, 200);
    await eventually(history, (items) => items.find((item) => item.url === racingUrl)?.statusCode === 200,
      'The latest observed HTTP 200 response must determine the aggregate URL status');
    await eventually(() => capture(tabId), (state) => state.items.find((item) => item.url === racingUrl)?.statusCode === 200,
      'Current capture must use the same latest observed result as history');
    pass('Concurrent requests for one URL consistently use the latest observed response result in current capture and history');

    const recoveryUrl = `${baseUrl}/error-recovery.m3u8?token=overlapping%2Brecovery%3D`;
    const failingRequest = request(page, recoveryUrl); failingRequest.catch(() => {});
    await eventually(history, (items) => items.some((item) => item.url === recoveryUrl), 'The first overlapping recovery request must be captured');
    await eventually(() => server.hasPending('recovery-error'), Boolean, 'The server must receive the first recovery request');
    const succeedingRequest = request(page, recoveryUrl); succeedingRequest.catch(() => {});
    await eventually(history, (items) => items.find((item) => item.url === recoveryUrl)?.requestCount === 2,
      'The newer recovery request must start before the older request fails');
    await eventually(() => server.hasPending('recovery-200'), Boolean, 'The server must receive the newer recovery request before failing the older request');
    server.release('recovery-error'); assert.ok((await failingRequest).error);
    await eventually(history, (items) => items.find((item) => item.url === recoveryUrl)?.error,
      'The first error must temporarily classify the shared address as abnormal');
    server.release('recovery-200'); assert.equal((await succeedingRequest).status, 200);
    await eventually(history, (items) => {
      const item = items.find((entry) => entry.url === recoveryUrl); return item?.statusCode === 200 && !item.error;
    }, 'The later successful response must clear the prior concurrent network error');
    await eventually(() => capture(tabId), (state) => {
      const item = state.items.find((entry) => entry.url === recoveryUrl); return item?.statusCode === 200 && !item.error;
    }, 'Current capture must also clear the prior concurrent error after success');
    pass('A later HTTP 200 result clears the earlier error of an overlapping request and restores normal classification in both scopes');

    const normalBatch = Array.from({ length: 35 }, (_, index) => `${baseUrl}/batch/200-${String(index).padStart(3, '0')}.m3u8?signature=batch%2B${index}%2Ffull%3D`);
    const abnormalBatch = Array.from({ length: 35 }, (_, index) => `${baseUrl}/batch/404-${String(index).padStart(3, '0')}.m3u8?signature=batch%2B${index}%2Ffull%3D`);
    await page.evaluate(async (urls) => {
      for (let start = 0; start < urls.length; start += 8) await Promise.all(urls.slice(start, start + 8).map(async (url) => {
        const response = await fetch(url, { cache: 'no-store' }); await response.text();
      }));
    }, [...normalBatch, ...abnormalBatch]);
    const expectedUrls = new Set([...expectedInitial, transitionUrl, racingUrl, recoveryUrl, ...normalBatch, ...abnormalBatch]);
    await eventually(history, (items) => items.length === expectedUrls.size
      && normalBatch.every((url) => items.some((item) => item.url === url && classify(item) === 'normal'))
      && abnormalBatch.every((url) => items.some((item) => item.url === url && classify(item) === 'abnormal')),
    'All matching pages must persist before pagination and copying');
    await popup.locator('[data-testid="view-history"]').click();
    await popup.locator('[data-testid="history-search"]').fill('/batch/');
    for (const [category, expected] of [['normal', normalBatch], ['abnormal', abnormalBatch]]) {
      await choose(popup, category);
      await eventually(() => shownUrls(popup), (urls) => urls.length === 30 && urls.every((url) => expected.includes(url)), 'A status plus search must paginate the matching category');
      const firstPage = await shownUrls(popup);
      await popup.locator('[data-testid="history-next"]').click();
      await eventually(() => shownUrls(popup), (urls) => urls.length === 5 && urls.every((url) => expected.includes(url))
        && !urls.some((url) => firstPage.includes(url)), 'Next page must contain only the remaining five matching status results');
      const oneUrl = (await shownUrls(popup))[0];
      await popup.locator('[data-testid="copy-one"]').first().click();
      await eventually(() => popup.evaluate(() => navigator.clipboard.readText()), (value) => value === oneUrl, 'Single history copy must retain its exact signed URL');
      await verifyCopyAll(popup, expected);
      await popup.locator('[data-testid="history-prev"]').click();
      await eventually(() => shownUrls(popup), (urls) => sameUrls(urls, firstPage), 'Previous page must restore the selected category search page');
    }
    pass('History search and status filters combine before pagination for both normal and abnormal records');
    pass('Single copy preserves signed addresses; filtered copy all writes all 35 matches across pages and excludes every other category');
    await choose(popup, 'all'); await verifyCopyAll(popup, [...normalBatch, ...abnormalBatch]);
    await choose(popup, 'pending', []);
    await eventually(() => shownUrls(popup), (urls) => urls.length === 0, 'A pending search with no matches must be empty');
    assert.ok(await popup.locator('[data-testid="copy-all"]').isDisabled());
    pass('All status copy includes both groups while an empty pending search disables copy all');

    await choose(popup, 'abnormal');
    const downloading = popup.waitForEvent('download'); await popup.locator('[data-testid="export-history"]').click();
    const download = await downloading;
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.format, 'm3u8-catcher-history');
    assert.equal(exported.count, expectedUrls.size); assert.equal(exported.items.length, expectedUrls.size);
    assert.deepEqual(new Set(exported.items.map((item) => item.url)), expectedUrls);
    assert.ok(exported.items.some((item) => classify(item) === 'normal'));
    assert.ok(exported.items.some((item) => classify(item) === 'abnormal'));
    assert.ok(exported.items.some((item) => item.url === headersResetUrl && item.statusCode === 200 && item.error));
    report.exportedRecords = exported.count; await download.delete();
    pass('The real JSON backup exports every normal and abnormal address including errors, independent of the active category and search');

    await popup.locator('[data-testid="history-search"]').fill('headers-reset');
    await choose(popup, 'abnormal', [headersResetUrl]);
    await popup.locator('[data-testid="delete-one"]').click();
    await popup.locator('[data-testid="cancel-delete"]').click();
    assert.ok((await history()).some((item) => item.url === headersResetUrl));
    await popup.locator('[data-testid="delete-one"]').click();
    await popup.locator('[data-testid="confirm-delete"]').click();
    expectedUrls.delete(headersResetUrl);
    await eventually(history, (items) => items.length === expectedUrls.size && !items.some((item) => item.url === headersResetUrl), 'Deleting an abnormal result must remove only that selected history record');
    assert.ok((await capture(tabId)).items.some((item) => item.url === headersResetUrl));
    pass('An abnormal history record can be cancelled or deleted with confirmation without changing the current-page capture');

    const beforeRestart = await history();
    assert.deepEqual(beforeRestart.find((item) => item.url === legacyUrl), legacyRecord);
    assert.equal(server.legacyRequests(), 0);
    const expectedByCategory = Object.fromEntries(['normal', 'abnormal', 'pending'].map((category) => [category, beforeRestart.filter((item) => classify(item) === category).map((item) => item.url)]));
    report.classificationCountsBeforeRestart = Object.fromEntries(Object.entries(expectedByCategory).map(([category, urls]) => [category, urls.length]));
    await page.reload(); await eventually(() => capture(tabId), (state) => state.items.length === 0, 'Refresh must still reset current page');
    assert.deepEqual(new Set((await history()).map((item) => item.url)), expectedUrls);
    await page.close(); await restoreClipboard(); browserClosing = true; await context.close(); context = undefined;
    report.browserRestarts += 1; await launch();
    const reopened = await eventually(history, (items) => items.length === expectedUrls.size, 'History must persist across a real Edge shutdown and restart');
    assert.deepEqual(new Set(reopened.map((item) => item.url)), expectedUrls);
    assert.deepEqual(reopened.find((item) => item.url === legacyUrl), legacyRecord);
    assert.equal(server.legacyRequests(), 0, 'The existing HTTP 206 history record must remain usable without any refetch after restart');
    for (const category of ['normal', 'abnormal', 'pending']) assert.deepEqual(new Set(reopened.filter((item) => classify(item) === category).map((item) => item.url)), new Set(expectedByCategory[category]));
    const internal = await context.newPage(); await internal.goto('edge://extensions/'); await internal.bringToFront();
    const internalTabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
    const restartedPopup = await openPopup(internalTabId); await restartedPopup.locator('[data-testid="view-history"]').click();
    await restartedPopup.bringToFront(); clipboardPage = restartedPopup; report.cleanup.clipboardRestored = false;
    for (const category of ['normal', 'abnormal']) {
      await choose(restartedPopup, category); await verifyCopyAll(restartedPopup, expectedByCategory[category]);
    }
    await restoreClipboard(); assert.deepEqual(runtimeErrors, [], 'Background and popup must not raise errors');
    report.persistedRecordsAfterRestart = reopened.length;
    pass('Refresh, source-tab closure and a real Edge restart preserve all records, their latest classifications and confirmed deletion');
    pass('After restart, global history remains usable on an Edge internal page and copies each persisted category exactly');
    console.log(`Verified ${checks.length} status-classification checks in Microsoft Edge ${report.mode}.`);
  } catch (error) {
    failure = error; report.error = error.stack || error.message; throw error;
  } finally {
    server.releaseAll();
    try { await restoreClipboard(); } catch (error) { report.cleanup.clipboardRestored = false; console.error(`Clipboard cleanup: ${error.message}`); }
    try { browserClosing = true; await context?.close(); report.cleanup.browserClosed = true; }
    catch (error) { console.error(`Browser cleanup: ${error.message}`); }
    if (fixture.listening) { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); }
    report.cleanup.fixtureClosed = !fixture.listening;
    if (report.fixture && report.cleanup.fixtureClosed) {
      const probe = createServer();
      try {
        await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(report.fixture.port, '127.0.0.1', resolve); });
        await new Promise((resolve) => probe.close(resolve)); report.cleanup.fixturePortReleased = true;
      } catch (error) { probe.close(); console.error(`Fixture port cleanup: ${error.message}`); }
    } else if (!report.fixture) report.cleanup.fixturePortReleased = true;
    for (const [directory, prefix, key] of [
      [profile, 'm3u8-status-verify-', 'temporaryProfileRemoved'],
      [downloads, 'm3u8-status-downloads-', 'temporaryDownloadsRemoved'],
    ]) {
      try { if (directory) await removeTemporary(directory, prefix); report.cleanup[key] = !directory || !existsSync(directory); }
      catch (error) { console.error(`Temporary directory cleanup: ${error.message}`); }
    }
    report.cleanup.complete = Object.entries(report.cleanup).filter(([key]) => key !== 'complete').every(([, value]) => value === true);
    report.finishedAt = new Date().toISOString(); report.status = failure || !report.cleanup.complete ? 'failed' : 'passed';
    await mkdir(artifactPath, { recursive: true });
    const file = path.join(artifactPath, 'status-report.json'); await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Status verification report: ${file} (${report.status})`);
    if (report.cleanup.complete) console.log('Cleanup complete: clipboard restored; Edge, fixture, temporary profile and downloads closed or removed.');
    if (!failure && !report.cleanup.complete) process.exitCode = 2;
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
