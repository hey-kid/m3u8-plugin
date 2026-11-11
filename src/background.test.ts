import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CaptureResponse, TabCapture } from './types';

type Callback = (...args: any[]) => unknown;

function event() {
  const listeners: Callback[] = [];
  return {
    listeners,
    addListener: vi.fn((listener: Callback) => listeners.push(listener)),
    emit: (...args: any[]) => listeners.map((listener) => listener(...args)),
  };
}

function createChrome(data: Record<string, unknown> = {}) {
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(data, structuredClone(values))),
      },
      session: {
        get: vi.fn(async (keys: string[]) => {
          await Promise.resolve();
          return structuredClone(Object.fromEntries(keys.map((key) => [key, data[key]])));
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          await Promise.resolve();
          Object.assign(data, structuredClone(values));
        }),
        remove: vi.fn(async (keys: string[]) => {
          keys.forEach((key) => delete data[key]);
        }),
      },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({
        id: tabId, url: 'https://page.example/start', title: '测试网页', incognito: false,
      })),
      onUpdated: event(),
      onRemoved: event(),
      onCreated: event(),
    },
    webRequest: {
      onBeforeRequest: event(),
      onHeadersReceived: event(),
      onCompleted: event(),
      onErrorOccurred: event(),
    },
    webNavigation: {
      onCommitted: event(),
      onErrorOccurred: event(),
      getFrame: vi.fn(async (): Promise<{
        documentId: string; url: string; documentLifecycle?: string; errorOccurred?: boolean;
      }> => ({
        documentId: 'document-initial', url: 'https://page.example/start',
      })),
    },
    runtime: { onMessage: event() },
  };
  return chrome;
}

let chrome: ReturnType<typeof createChrome>;
let data: Record<string, unknown>;
let background: typeof import('./background');

const request = (overrides: Record<string, unknown> = {}) => ({
  tabId: 1,
  requestId: 'request-1',
  url: 'https://cdn.example/movie.m3u8?token=a%2Bb',
  method: 'GET',
  timeStamp: 100,
  type: 'xmlhttprequest',
  frameId: 0,
  documentId: 'document-a',
  documentLifecycle: 'active',
  ...overrides,
});

async function response(tabId = 1): Promise<CaptureResponse> {
  return new Promise((resolve) => {
    chrome.runtime.onMessage.emit({ type: 'GET_CAPTURE', tabId }, {}, resolve);
  });
}

async function capture(tabId = 1): Promise<TabCapture> {
  const result = await response(tabId);
  await background.waitForHistoryWrites();
  if (!result.ok) throw new Error(result.error);
  return result.capture;
}

function navigate(url: string, requestId: string, timeStamp: number, tabId = 1): void {
  chrome.webRequest.onBeforeRequest.emit(request({
    tabId, requestId, url, timeStamp, type: 'main_frame', documentId: undefined,
  }));
}

function commit(url: string, documentId: string, timeStamp: number, tabId = 1): void {
  chrome.webNavigation.getFrame.mockResolvedValue({ documentId, url });
  chrome.webNavigation.onCommitted.emit({ tabId, frameId: 0, url, documentId, timeStamp });
}

beforeEach(async () => {
  vi.resetModules();
  data = {};
  chrome = createChrome(data);
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal('indexedDB', new IDBFactory());
  background = await import('./background');
});

afterEach(async () => {
  await background.waitForHistoryWrites();
  await (await import('./history')).closeHistoryDatabase();
  vi.unstubAllGlobals();
});

describe('background event lifecycle', () => {
  it('keeps all distinct addresses in the archive after the 300-item current-page limit', async () => {
    for (let index = 0; index < 325; index += 1) {
      chrome.webRequest.onBeforeRequest.emit(request({
        requestId: `archive-${index}`, url: `https://cdn.example/${index}.m3u8`, timeStamp: index,
      }));
    }
    const current = await capture();
    expect(current.items).toHaveLength(300);
    expect(current.limitReached).toBe(true);
    expect((await (await import('./history')).getHistoryPage()).total).toBe(325);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 1, text: '300+' });
  });

  it('archives requests that arrived before tab closure even if session work is still queued', async () => {
    chrome.webRequest.onBeforeRequest.emit(request());
    chrome.tabs.onRemoved.emit(1);
    await background.waitForHistoryWrites();
    expect((await (await import('./history')).getHistoryPage()).total).toBe(1);
    await vi.waitFor(() => expect(chrome.storage.session.remove).toHaveBeenCalled());
  });

  it.each([false, true])('preserves old-page MIME origins across navigation with worker recycled=%s', async (recycled) => {
    const tabA = { id: 1, url: 'https://page.example/a', title: 'Page A', incognito: false };
    chrome.tabs.get.mockResolvedValue(tabA);
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.tabs.onUpdated.emit(1, { title: 'Page A' }, tabA);
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'mime-old', url: 'https://cdn.example/manifest', timeStamp: 20,
    }));
    await capture();
    if (recycled) {
      vi.resetModules();
      chrome = createChrome(data);
      vi.stubGlobal('chrome', chrome);
      background = await import('./background');
    }
    navigate('https://page.example/b', 'nav-b', 30);
    commit('https://page.example/b', 'document-b', 31);
    chrome.tabs.onUpdated.emit(1, { title: 'Page B', url: 'https://page.example/b' }, {
      id: 1, url: 'https://page.example/b', title: 'Page B', incognito: false,
    });
    chrome.webRequest.onHeadersReceived.emit(request({
      requestId: 'mime-old', url: 'https://cdn.example/manifest', timeStamp: 40,
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }], statusCode: 200,
    }));
    expect((await capture()).items).toHaveLength(0);
    expect((await (await import('./history')).getHistoryPage()).items[0]).toMatchObject({
      url: 'https://cdn.example/manifest', pageUrl: 'https://page.example/a', pageTitle: 'Page A',
    });
  });

  it('updates MIME-only history on a final error after worker recycling, beyond the current-page cap', async () => {
    for (let index = 0; index < 300; index += 1) {
      chrome.webRequest.onBeforeRequest.emit(request({
        requestId: `full-${index}`, url: `https://cdn.example/${index}.m3u8`, timeStamp: index,
      }));
    }
    const mime = request({ requestId: 'mime-pending', url: 'https://cdn.example/manifest', timeStamp: 400 });
    chrome.webRequest.onBeforeRequest.emit(mime);
    chrome.webRequest.onHeadersReceived.emit({
      ...mime, timeStamp: 401, statusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
    });
    expect((await capture()).items).toHaveLength(300);
    expect((data['history-inflight:1'] as Record<string, unknown>)['mime-pending']).toMatchObject({
      playlistUrl: mime.url,
    });
    vi.resetModules();
    chrome = createChrome(data);
    vi.stubGlobal('chrome', chrome);
    background = await import('./background');
    chrome.webRequest.onErrorOccurred.emit({ ...mime, timeStamp: 402, error: 'net::ERR_CONNECTION_RESET' });
    await background.waitForHistoryWrites();
    const result = await (await import('./history')).getHistoryPage({ query: '/manifest' });
    expect(result.items[0]).toMatchObject({
      url: mime.url, requestCount: 1, error: 'net::ERR_CONNECTION_RESET', lastSeen: 402,
    });
    expect((data['history-inflight:1'] as Record<string, unknown>)['mime-pending']).toBeUndefined();
  });

  it('does not update an old MIME history entry for an ordinary non-HLS request to the same URL', async () => {
    const mime = request({ url: 'https://cdn.example/manifest' });
    chrome.webRequest.onBeforeRequest.emit(mime);
    chrome.webRequest.onHeadersReceived.emit({
      ...mime, timeStamp: 101, statusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    });
    chrome.webRequest.onCompleted.emit({ ...mime, timeStamp: 102, statusCode: 200 });
    await background.waitForHistoryWrites();
    const normal = { ...mime, requestId: 'ordinary', timeStamp: 200 };
    chrome.webRequest.onBeforeRequest.emit(normal);
    chrome.webRequest.onHeadersReceived.emit({
      ...normal, timeStamp: 201, statusCode: 404,
      responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
    });
    chrome.webRequest.onCompleted.emit({ ...normal, timeStamp: 202, statusCode: 404 });
    await background.waitForHistoryWrites();
    expect((await (await import('./history')).getHistoryPage()).items[0]).toMatchObject({
      lastSeen: 102, requestCount: 1, statusCode: 200,
    });
  });

  it('keeps identified history writes working when session tracking writes fail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    chrome.storage.session.set.mockRejectedValue(new Error('Session quota exceeded'));
    chrome.webRequest.onBeforeRequest.emit(request());
    await background.waitForHistoryWrites();
    expect((await (await import('./history')).getHistoryPage()).total).toBe(1);
    expect(data['history-status']).toBeUndefined();
    consoleError.mockRestore();
  });

  it('merges the same signed URL from simultaneous tabs without losing counts', async () => {
    for (let index = 0; index < 30; index += 1) {
      chrome.webRequest.onBeforeRequest.emit(request({
        tabId: index % 3 + 1, requestId: `same-${index}`, timeStamp: index,
      }));
    }
    await background.waitForHistoryWrites();
    const history = await (await import('./history')).getHistoryPage();
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ requestCount: 30, firstSeen: 0, lastSeen: 29 });
  });

  it('does not revive a user-deleted URL on late headers or final events', async () => {
    chrome.webRequest.onBeforeRequest.emit(request());
    await capture();
    const history = await import('./history');
    await history.deleteHistory(request().url);
    chrome.webRequest.onHeadersReceived.emit(request({
      timeStamp: 101, statusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/x-mpegurl' }],
    }));
    chrome.webRequest.onCompleted.emit(request({ timeStamp: 102, statusCode: 200 }));
    await background.waitForHistoryWrites();
    expect((await history.getHistoryPage()).total).toBe(0);
    chrome.webRequest.onBeforeRequest.emit(request({ requestId: 'new-request', timeStamp: 200 }));
    await background.waitForHistoryWrites();
    expect((await history.getHistoryPage()).items[0].requestCount).toBe(1);
  });

  it('leaves private-tab captures session-only', async () => {
    chrome.tabs.get.mockResolvedValue({
      id: 1, url: 'https://private.example/', title: 'private', incognito: true,
    });
    chrome.webRequest.onBeforeRequest.emit(request());
    expect((await capture()).items).toHaveLength(1);
    expect((await (await import('./history')).getHistoryPage()).total).toBe(0);
  });

  it('reports failed archive writes while preserving the current-page capture', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Disk is full', 'QuotaExceededError'); } });
    chrome.webRequest.onBeforeRequest.emit(request());
    expect((await capture()).items).toHaveLength(1);
    expect(data['history-status']).toMatchObject({ error: 'Disk is full' });
    expect(data['history-revision']).toEqual(expect.any(String));
    consoleError.mockRestore();
  });

  it('does not block session results on a pending IndexedDB write', async () => {
    const open = vi.fn(() => ({
      onupgradeneeded: null, onerror: null, onblocked: null, onsuccess: null,
    }));
    vi.stubGlobal('indexedDB', { open });
    chrome.webRequest.onBeforeRequest.emit(request());
    const result = await response();
    expect(result).toMatchObject({ ok: true, capture: { items: [{ url: request().url }] } });
    // Resolve the stalled open as an explicit failure so test teardown can drain.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pending = open.mock.results[0].value as unknown as { error?: Error; onerror: () => void };
    pending.error = new Error('deliberate test close');
    pending.onerror();
    await background.waitForHistoryWrites();
    consoleError.mockRestore();
  });

  it('registers all event listeners synchronously without waiting for storage', () => {
    expect(chrome.webRequest.onBeforeRequest.listeners).toHaveLength(1);
    expect(chrome.webRequest.onHeadersReceived.listeners).toHaveLength(1);
    expect(chrome.webNavigation.onCommitted.listeners).toHaveLength(1);
    expect(chrome.runtime.onMessage.listeners).toHaveLength(1);
    expect(chrome.storage.session.get).not.toHaveBeenCalled();
  });

  it('merges repeated requests without counting their headers and completion twice', async () => {
    for (let i = 0; i < 2; i += 1) {
      const details = request({ requestId: `request-${i}`, timeStamp: 100 + i * 10 });
      chrome.webRequest.onBeforeRequest.emit(details);
      chrome.webRequest.onHeadersReceived.emit({
        ...details, timeStamp: details.timeStamp + 1, statusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
      });
      chrome.webRequest.onCompleted.emit({ ...details, timeStamp: details.timeStamp + 2, statusCode: 200 });
    }
    const result = await capture();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: 'https://cdn.example/movie.m3u8?token=a%2Bb',
      requestCount: 2,
      detectedBy: ['url', 'content-type'],
      statusCode: 200,
    });
    await background.waitForHistoryWrites();
    const history = await (await import('./history')).getHistoryPage();
    expect(history.items[0]).toMatchObject({
      requestCount: 2, pageTitle: '测试网页', pageUrl: 'https://page.example/start',
      detectedBy: ['url', 'content-type'], statusCode: 200,
    });
    expect(data['tab:1']).toEqual(result);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 1, text: '1' });
  });

  it('captures extensionless HLS responses and excludes arbitrary video responses', async () => {
    for (const [suffix, mime] of [['play', 'application/x-mpegurl'], ['movie', 'video/mp4']]) {
      const details = request({ url: `https://cdn.example/${suffix}`, requestId: suffix });
      chrome.webRequest.onBeforeRequest.emit(details);
      chrome.webRequest.onHeadersReceived.emit({
        ...details, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: mime }],
      });
      chrome.webRequest.onCompleted.emit({ ...details, statusCode: 200 });
    }
    const result = await capture();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: 'https://cdn.example/play', requestCount: 1, detectedBy: ['content-type'],
    });
    await background.waitForHistoryWrites();
    expect((await (await import('./history')).getHistoryPage()).items).toHaveLength(1);
  });

  it('serializes concurrent writes while keeping different tabs isolated', async () => {
    for (let i = 0; i < 40; i += 1) {
      chrome.webRequest.onBeforeRequest.emit(request({
        requestId: `request-${i}`, url: `https://cdn.example/${i}.m3u8`,
      }));
    }
    chrome.webRequest.onBeforeRequest.emit(request({ tabId: 2 }));
    const [first, second] = await Promise.all([capture(), capture(2)]);
    expect(first.items).toHaveLength(40);
    expect(new Set(first.items.map((item) => item.url)).size).toBe(40);
    expect(second.items).toHaveLength(1);
  });

  it('isolates navigations and ignores old-page requests without clearing new preloads on commit', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
    chrome.webRequest.onBeforeRequest.emit(request({
      url: 'https://cdn.example/old-play', requestId: 'old-play', timeStamp: 21,
    }));
    navigate('https://page.example/b', 'nav-b', 30);
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'new-play', url: 'https://cdn.example/new.m3u8', timeStamp: 31,
      documentId: 'document-b',
    }));
    commit('https://page.example/b', 'document-b', 32);
    chrome.tabs.onUpdated.emit(1, { status: 'loading', url: 'https://page.example/b' });
    chrome.webRequest.onHeadersReceived.emit(request({
      url: 'https://cdn.example/old-play', requestId: 'old-play', timeStamp: 40,
      statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'audio/mpegurl' }],
    }));
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'old-late', url: 'https://cdn.example/late.m3u8', timeStamp: 41,
    }));
    const result = await capture();
    expect(result.pageUrl).toBe('https://page.example/b');
    expect(result.items.map((item) => item.url)).toEqual(['https://cdn.example/new.m3u8']);
  });

  it('does not reset for a main-frame redirect sharing its requestId', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 11 }));
    navigate('https://page.example/redirected', 'nav-a', 12);
    commit('https://page.example/redirected', 'document-a', 13);
    expect((await capture()).items).toHaveLength(1);
  });

  it('restores records after worker recycling without incrementing for a late header event', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request());
    expect((await capture()).items).toHaveLength(1);
    vi.resetModules();
    chrome = createChrome(data);
    vi.stubGlobal('chrome', chrome);
    background = await import('./background');
    chrome.webRequest.onHeadersReceived.emit(request({
      timeStamp: 101, statusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }],
    }));
    chrome.webRequest.onCompleted.emit(request({ timeStamp: 102, statusCode: 200 }));
    expect((await capture()).items[0]).toMatchObject({ requestCount: 1, statusCode: 200 });
  });

  it('clears on BFCache document changes and privileged navigations without network events', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
    commit('https://page.example/b', 'document-b', 30);
    expect((await capture()).items).toEqual([]);
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'b-play', timeStamp: 40, documentId: 'document-b',
    }));
    expect((await capture()).items).toHaveLength(1);
    commit('edge://settings/', 'document-settings', 50);
    const result = await capture();
    expect(result.pageUrl).toBe('edge://settings/');
    expect(result.items).toEqual([]);
  });

  it('retains captures on a same-document URL change', async () => {
    chrome.webRequest.onBeforeRequest.emit(request());
    chrome.tabs.onUpdated.emit(1, { url: 'https://page.example/start#chapter-2' });
    const result = await capture();
    expect(result.items).toHaveLength(1);
    expect(result.pageUrl).toContain('#chapter-2');
  });

  it.each(['cancelled', 'download'] as const)(
    'keeps the visible page collecting and rolls back a %s navigation',
    async (kind) => {
      navigate('https://page.example/a', 'nav-a', 10);
      commit('https://page.example/a', 'document-a', 11);
      chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
      const before = await capture();
      navigate('https://page.example/attachment', 'nav-download', 30);
      chrome.webRequest.onBeforeRequest.emit(request({
        requestId: 'while-pending', url: 'https://cdn.example/while-pending.m3u8', timeStamp: 31,
      }));
      const visible = await capture();
      expect(visible.pageUrl).toBe('https://page.example/a');
      expect(visible.items).toHaveLength(2);
      expect(data['tab:1']).toEqual(visible);
      expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 1, text: '2' });
      const final = request({
        type: 'main_frame', documentId: undefined, url: 'https://page.example/attachment',
        requestId: 'nav-download', timeStamp: 40,
      });
      if (kind === 'cancelled') {
        chrome.webRequest.onErrorOccurred.emit({ ...final, error: 'net::ERR_ABORTED' });
      } else {
        chrome.webRequest.onCompleted.emit({ ...final, statusCode: 200 });
      }
      chrome.webRequest.onBeforeRequest.emit(request({
        requestId: 'after-download', url: 'https://cdn.example/after.m3u8', timeStamp: 41,
      }));
      const restored = await capture();
      expect(restored.items).toHaveLength(3);
      expect(restored.pageUrl).toBe(before.pageUrl);
      expect(restored.updatedAt).toBeGreaterThanOrEqual(visible.updatedAt);
      expect(data['tab:1']).toEqual(restored);
      expect((data['tab-meta:1'] as Record<string, unknown>).previous).toBeUndefined();
    },
  );

  it('recovers a cancelled provisional navigation after worker recycling', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
    navigate('https://page.example/attachment', 'nav-download', 30);
    const original = await capture();
    vi.resetModules();
    chrome = createChrome(data);
    chrome.webNavigation.getFrame.mockResolvedValue({
      documentId: 'document-a', url: 'https://page.example/a',
    });
    vi.stubGlobal('chrome', chrome);
    background = await import('./background');
    chrome.webNavigation.onErrorOccurred.emit({
      tabId: 1, frameId: 0, url: 'https://page.example/attachment',
      timeStamp: 40, error: 'net::ERR_ABORTED',
    });
    const restored = await capture();
    expect(restored.items).toEqual(original.items);
    expect(restored.pageUrl).toBe('https://page.example/a');
    expect((data['tab-meta:1'] as Record<string, unknown>).previous).toBeUndefined();
  });

  it('does not roll back when the browser has switched to a new document', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
    navigate('https://page.example/b', 'nav-b', 30);
    await capture();
    chrome.webNavigation.getFrame.mockResolvedValue({
      documentId: 'document-b', url: 'https://page.example/b',
    });
    chrome.webNavigation.onErrorOccurred.emit({
      tabId: 1, frameId: 0, url: 'https://page.example/b', timeStamp: 40,
    });
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'new-preload', url: 'https://cdn.example/new.m3u8',
      timeStamp: 41, documentId: 'document-b',
    }));
    commit('https://page.example/b', 'document-b', 42);
    const result = await capture();
    expect(result.pageUrl).toBe('https://page.example/b');
    expect(result.items.map((item) => item.url)).toEqual(['https://cdn.example/new.m3u8']);
  });

  it.each([false, true])('settles a different active document when errorOccurred=%s', async (errorOccurred) => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
    navigate('https://page.example/b', 'nav-b', 30);
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'b-preload', url: 'https://cdn.example/new.m3u8', documentId: 'document-b', timeStamp: 31,
    }));
    await capture();
    chrome.webNavigation.getFrame.mockResolvedValue({
      documentId: 'document-b', url: 'https://page.example/b', documentLifecycle: 'active', errorOccurred,
    });
    chrome.webRequest.onErrorOccurred.emit(request({
      type: 'main_frame', documentId: undefined, requestId: 'nav-b',
      url: 'https://page.example/b', timeStamp: 40, error: 'net::ERR_FAILED',
    }));
    const result = await capture();
    expect(result.pageUrl).toBe('https://page.example/b');
    expect(result.items.map((item) => item.url)).toEqual(
      errorOccurred ? [] : ['https://cdn.example/new.m3u8'],
    );
    expect((data['tab-meta:1'] as Record<string, unknown>).previous).toBeUndefined();
    commit('https://page.example/b', 'document-b', 41);
    expect((await capture()).items).toEqual(result.items);
  });

  it('publishes only the visible capture and advances its revision when a navigation commits', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webRequest.onBeforeRequest.emit(request({ timeStamp: 20 }));
    navigate('https://page.example/b', 'nav-b', 30);
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'preload', url: 'https://cdn.example/new.m3u8', documentId: 'document-b', timeStamp: 31,
    }));
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'old-page-live-update', url: 'https://cdn.example/old.m3u8', timeStamp: 32,
    }));
    const visible = await capture();
    expect(data['tab:1']).toEqual(visible);
    expect(visible.items.map((item) => item.url)).not.toContain('https://cdn.example/new.m3u8');
    commit('https://page.example/b', 'document-b', 40);
    const result = await capture();
    expect(result.items.map((item) => item.url)).toEqual(['https://cdn.example/new.m3u8']);
    expect(result.updatedAt).toBeGreaterThanOrEqual(visible.updatedAt);
    expect(result.updatedAt).toBeGreaterThanOrEqual(40);
    expect(data['tab:1']).toEqual(result);
  });

  it('restores BFCache iframe ancestry across worker recycling and excludes other old frame trees', async () => {
    navigate('https://page.example/a', 'nav-a', 10);
    commit('https://page.example/a', 'document-a', 11);
    chrome.webNavigation.onCommitted.emit({
      tabId: 1, frameId: 1, documentId: 'frame-a', parentDocumentId: 'document-a',
      url: 'https://player.example/a', timeStamp: 12,
    });
    chrome.webNavigation.onCommitted.emit({
      tabId: 1, frameId: 2, documentId: 'nested-a', parentDocumentId: 'frame-a',
      url: 'https://player.example/nested', timeStamp: 13,
    });
    navigate('https://page.example/b', 'nav-b', 20);
    commit('https://page.example/b', 'document-b', 21);
    chrome.webNavigation.onCommitted.emit({
      tabId: 1, frameId: 1, documentId: 'frame-b', parentDocumentId: 'document-b',
      url: 'https://player.example/b', timeStamp: 22,
    });
    await capture();
    vi.resetModules();
    chrome = createChrome(data);
    vi.stubGlobal('chrome', chrome);
    background = await import('./background');

    commit('https://page.example/a', 'document-a', 30);
    for (const [documentId, frameId] of [['frame-a', 1], ['nested-a', 2]] as const) {
      chrome.webRequest.onBeforeRequest.emit(request({
        requestId: `restored-${documentId}`, url: `https://cdn.example/${documentId}.m3u8`,
        documentId, frameId, timeStamp: 31,
      }));
    }
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'old-b', documentId: 'frame-b', frameId: 1, timeStamp: 32,
    }));
    expect((await capture()).items.map((item) => item.url)).toEqual([
      'https://cdn.example/frame-a.m3u8', 'https://cdn.example/nested-a.m3u8',
    ]);

    navigate('https://page.example/c', 'nav-c', 40);
    commit('https://page.example/c', 'document-c', 41);
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'old-a', documentId: 'nested-a', frameId: 2, timeStamp: 42,
    }));
    chrome.webRequest.onBeforeRequest.emit(request({
      requestId: 'new-c', documentId: 'document-c', timeStamp: 43,
    }));
    const result = await capture();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toContain('movie.m3u8');
  });

  it('records a failed playlist request while ignoring requests with no tab', async () => {
    chrome.webRequest.onBeforeRequest.emit(request());
    chrome.webRequest.onErrorOccurred.emit(request({ timeStamp: 101, error: 'net::ERR_FAILED' }));
    chrome.webRequest.onBeforeRequest.emit(request({ tabId: -1 }));
    expect((await capture()).items[0].error).toBe('net::ERR_FAILED');
    expect(data['tab:-1']).toBeUndefined();
  });

  it('removes both session keys when a tab closes, including queued writes', async () => {
    chrome.webRequest.onBeforeRequest.emit(request());
    await capture();
    chrome.webRequest.onBeforeRequest.emit(request({ requestId: 'racing-request', timeStamp: 200 }));
    chrome.tabs.onRemoved.emit(1);
    chrome.webRequest.onBeforeRequest.emit(request({ requestId: 'late-request', timeStamp: 201 }));
    await vi.waitFor(() => expect(chrome.storage.session.remove).toHaveBeenCalledWith([
      'tab:1', 'tab-meta:1',
    ]));
    expect(data['tab:1']).toBeUndefined();
    expect(data['tab-meta:1']).toBeUndefined();
    expect(await response()).toMatchObject({ ok: false });
  });

  it('rejects malformed requests and ignores unrelated messages', () => {
    const sendResponse = vi.fn();
    expect(chrome.runtime.onMessage.emit({ type: 'OTHER' }, {}, sendResponse)).toEqual([false]);
    expect(sendResponse).not.toHaveBeenCalled();
    chrome.runtime.onMessage.emit({ type: 'GET_CAPTURE', tabId: -1 }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: '无法读取当前标签页。' });
  });
});
