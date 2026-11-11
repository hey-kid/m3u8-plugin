import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CaptureObservation } from './capture';

let history: typeof import('./history');
const source = { pageUrl: 'https://page.example/watch', pageTitle: '示例视频 WATCH' };
const observation = (changes: Partial<CaptureObservation> = {}): CaptureObservation => ({
  url: 'https://cdn.example/video.m3u8?token=a%2Bb&x=1', time: 100,
  method: 'GET', detectedBy: ['url'], countRequest: true, ...changes,
});

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  history = await import('./history');
});

afterEach(async () => {
  await history.closeHistoryDatabase();
  vi.unstubAllGlobals();
});

describe('persistent history database', () => {
  it('preserves URL bytes and records metadata without requiring Chrome globals', async () => {
    await history.archiveHistory(observation(), source);
    expect((await history.getHistoryPage()).items[0]).toMatchObject({
      ...source, url: observation().url, hostname: 'cdn.example', firstSeen: 100,
      lastSeen: 100, requestCount: 1,
    });
    await history.archiveHistory(observation({ url: `${observation().url}&signature=new` }), source);
    expect((await history.getHistoryPage()).total).toBe(2);
  });

  it('keeps records through reconnects and independent extension context imports', async () => {
    await history.archiveHistory(observation(), source);
    await history.closeHistoryDatabase();
    vi.resetModules();
    history = await import('./history');
    expect((await history.getHistoryPage()).total).toBe(1);
  });

  it('merges concurrent writes from separate database connections atomically', async () => {
    const firstContext = history;
    vi.resetModules();
    const secondContext = await import('./history');
    await Promise.all(Array.from({ length: 60 }, (_, index) =>
      (index % 2 ? firstContext : secondContext).archiveHistory(observation({ time: index }), source)));
    expect((await history.getHistoryPage()).items[0]).toMatchObject({
      requestCount: 60, firstSeen: 0, lastSeen: 59,
    });
    await secondContext.closeHistoryDatabase();
  });

  it('updates late response metadata without incrementing the request count or overwriting newer source', async () => {
    await history.archiveHistory(observation({ time: 20 }), source);
    await history.archiveHistory(observation({
      time: 30, detectedBy: ['content-type'], countRequest: false, statusCode: 200,
    }), { pageUrl: 'https://page.example/second', pageTitle: 'Second' });
    await history.archiveHistory(observation({
      time: 10, detectedBy: [], countRequest: false, statusCode: 403,
    }), source, { createIfMissing: false });
    expect((await history.getHistoryPage()).items[0]).toMatchObject({
      requestCount: 1, firstSeen: 10, lastSeen: 30, detectedBy: ['url', 'content-type'],
      pageTitle: 'Second', statusCode: 200,
    });
  });

  it('never recreates a deleted record from its old headers or completion event', async () => {
    await history.archiveHistory(observation(), source);
    await history.deleteHistory(observation().url);
    await history.archiveHistory(observation({ countRequest: false, statusCode: 200 }), source, {
      createIfMissing: false,
    });
    await history.archiveHistory(observation({ detectedBy: [], countRequest: false, time: 101 }), source, {
      createIfMissing: false,
    });
    expect((await history.getHistoryPage()).total).toBe(0);
    await history.archiveHistory(observation({ time: 200 }), source);
    expect((await history.getHistoryPage()).items[0].requestCount).toBe(1);
  });

  it('archives beyond the current-page limit without evicting old addresses', async () => {
    await Promise.all(Array.from({ length: 325 }, (_, index) => history.archiveHistory(observation({
      url: `https://cdn.example/${index}.m3u8`, time: index,
    }), source)));
    const firstPage = await history.getHistoryPage({ limit: 30 });
    expect(firstPage).toMatchObject({ total: 325, matched: 325, offset: 0, limit: 30 });
    expect(firstPage.items).toHaveLength(30);
    expect(firstPage.items[0].url).toBe('https://cdn.example/324.m3u8');
    const lastPage = await history.getHistoryPage({ offset: 300, limit: 30 });
    expect(lastPage.items).toHaveLength(25);
    expect(lastPage.items[24].url).toBe('https://cdn.example/0.m3u8');
    expect(await history.getHistoryUrls()).toHaveLength(325);
  });

  it('searches URL, hostname, page title and source URL case-insensitively across all pages', async () => {
    for (let index = 0; index < 7; index += 1) {
      await history.archiveHistory(observation({ url: `https://cdn.example/${index}.m3u8`, time: index }), source);
    }
    await history.archiveHistory(observation({ url: 'https://other.example/extra.m3u8', time: 8 }), {
      pageUrl: 'https://example.com/another', pageTitle: 'Another',
    });
    const result = await history.getHistoryPage({ query: ' WATCH ', offset: 3, limit: 2 });
    expect(result).toMatchObject({ total: 8, matched: 7, offset: 3, limit: 2 });
    expect(result.items.map((item) => item.url)).toEqual([
      'https://cdn.example/3.m3u8', 'https://cdn.example/2.m3u8',
    ]);
    expect(await history.getHistoryUrls('WATCH')).toHaveLength(7);
    expect((await history.getHistoryPage({ query: 'CDN.EXAMPLE' })).matched).toBe(7);
    expect((await history.getHistoryPage({ query: '/ANOTHER' })).matched).toBe(1);
    expect((await history.getHistoryPage({ query: '0.m3u8' })).matched).toBe(1);
    expect((await history.getHistoryPage({ query: 'missing' })).matched).toBe(0);
  });

  it('combines status and search before paginating, with counts for every matching status', async () => {
    const results = [200, 404, undefined, 200, 206, undefined, 200, 304];
    for (const [index, statusCode] of results.entries()) {
      await history.archiveHistory(observation({
        url: `https://cdn.example/${index}.m3u8`, time: index, statusCode,
      }), source);
    }
    await history.archiveHistory(observation({
      url: 'https://other.example/outside.m3u8', time: 20, statusCode: 200,
    }), { pageUrl: 'https://example.com/another', pageTitle: 'Another' });

    const page = await history.getHistoryPage({ query: ' WATCH ', status: 'abnormal', offset: 1, limit: 1 });
    expect(page).toMatchObject({
      total: 9, matched: 2, offset: 1, limit: 1,
      counts: { all: 8, normal: 4, abnormal: 2, pending: 2 },
    });
    expect(page.items.map((item) => item.url)).toEqual(['https://cdn.example/1.m3u8']);
    expect(await history.getHistoryUrls('WATCH', 'abnormal')).toEqual([
      'https://cdn.example/7.m3u8', 'https://cdn.example/1.m3u8',
    ]);
    expect(await history.getHistoryUrls('WATCH', 'normal')).toEqual([
      'https://cdn.example/6.m3u8', 'https://cdn.example/4.m3u8', 'https://cdn.example/3.m3u8', 'https://cdn.example/0.m3u8',
    ]);
    const pending = await history.getHistoryPage({ status: 'pending' });
    expect(pending.matched).toBe(2);
    expect(pending.items.map((item) => item.url)).toEqual([
      'https://cdn.example/5.m3u8', 'https://cdn.example/2.m3u8',
    ]);
    expect((await history.getHistoryPage()).counts).toEqual({ all: 9, normal: 5, abnormal: 2, pending: 2 });
    expect((await history.getHistoryPage({ query: 'missing', status: 'normal' }))).toMatchObject({
      total: 9, matched: 0, items: [], counts: { all: 0, normal: 0, abnormal: 0, pending: 0 },
    });
  });

  it('classifies an already saved HTTP 206 as normal without recapturing or changing the record', async () => {
    await history.archiveHistory(observation({ statusCode: 206 }), source);
    const saved = (await history.getHistoryPage()).items[0];
    await history.closeHistoryDatabase();
    vi.resetModules();
    history = await import('./history');
    expect((await history.getHistoryPage({ status: 'normal' })).items).toEqual([saved]);
    expect((await history.getHistoryPage({ status: 'abnormal' })).matched).toBe(0);
    expect(await history.getHistoryUrls('', 'normal')).toEqual([observation().url]);
  });

  it('copies all filtered URLs beyond the visible page and preserves the default all-results API', async () => {
    await Promise.all(Array.from({ length: 105 }, (_, index) => history.archiveHistory(observation({
      url: `https://cdn.example/${index}.m3u8`, time: index,
      statusCode: index % 3 === 0 ? 200 : index % 3 === 1 ? 404 : undefined,
    }), source)));
    const page = await history.getHistoryPage({ query: 'watch', status: 'normal', limit: 30 });
    expect(page.items).toHaveLength(30);
    expect(page).toMatchObject({ matched: 35, counts: { all: 105, normal: 35, abnormal: 35, pending: 35 } });
    const copied = await history.getHistoryUrls('watch', 'normal');
    expect(copied).toHaveLength(35);
    expect(copied[0]).toBe('https://cdn.example/102.m3u8');
    expect(copied.at(-1)).toBe('https://cdn.example/0.m3u8');
    expect(copied.every((url) => Number(new URL(url).pathname.split('/')[1].split('.')[0]) % 3 === 0)).toBe(true);
    expect(await history.getHistoryUrls('watch')).toHaveLength(105);
    expect(await history.getHistoryUrls('', 'pending')).toHaveLength(35);
  });

  it('classifies existing records dynamically and moves repeated URLs when their latest result changes', async () => {
    await history.archiveHistory(observation(), source);
    await history.closeHistoryDatabase();
    vi.resetModules();
    history = await import('./history');
    expect((await history.getHistoryPage({ status: 'pending' })).matched).toBe(1);

    await history.archiveHistory(observation({
      time: 101, countRequest: false, statusCode: 200,
    }), source, { createIfMissing: false });
    expect((await history.getHistoryPage()).counts).toEqual({ all: 1, normal: 1, abnormal: 0, pending: 0 });
    await history.archiveHistory(observation({ time: 102 }), source);
    expect((await history.getHistoryPage()).counts).toEqual({ all: 1, normal: 0, abnormal: 0, pending: 1 });
    await history.archiveHistory(observation({
      time: 103, countRequest: false, statusCode: 404,
    }), source, { createIfMissing: false });
    expect((await history.getHistoryPage({ status: 'abnormal' })).matched).toBe(1);
    await history.archiveHistory(observation({ time: 104 }), source);
    await history.archiveHistory(observation({
      time: 105, countRequest: false, statusCode: 200, error: 'net::ERR_ABORTED',
    }), source, { createIfMissing: false });
    expect((await history.getHistoryPage()).counts).toEqual({ all: 1, normal: 0, abnormal: 1, pending: 0 });
    expect(await history.getHistoryUrls('', 'normal')).toEqual([]);
    expect(await history.getHistoryUrls('', 'abnormal')).toEqual([observation().url]);
  });

  it('moves an overlapping failed URL back to normal after a later successful result', async () => {
    await history.archiveHistory(observation(), source);
    await history.archiveHistory(observation({ time: 101 }), source);
    await history.archiveHistory(observation({
      time: 102, countRequest: false, error: 'net::ERR_ABORTED',
    }), source, { createIfMissing: false });
    expect((await history.getHistoryPage({ status: 'abnormal' })).matched).toBe(1);
    await history.archiveHistory(observation({
      time: 103, countRequest: false, statusCode: 200,
    }), source, { createIfMissing: false });
    expect((await history.getHistoryPage()).counts).toEqual({ all: 1, normal: 1, abnormal: 0, pending: 0 });
    expect(await history.getHistoryUrls('', 'normal')).toEqual([observation().url]);
    expect((await history.getHistoryPage()).items[0].error).toBeUndefined();
  });

  it('keeps backup exports unfiltered and deletes only the requested status record', async () => {
    await history.archiveHistory(observation({ statusCode: 200 }), source);
    await history.archiveHistory(observation({
      url: 'https://cdn.example/missing.m3u8', statusCode: 404,
    }), source);
    await history.archiveHistory(observation({ url: 'https://cdn.example/pending.m3u8' }), source);
    expect((await history.getHistoryPage({ query: 'missing', status: 'abnormal' })).matched).toBe(1);
    const before = JSON.parse(await (await history.exportHistory()).text());
    expect(before.count).toBe(3);
    expect(before.items).toHaveLength(3);
    await history.deleteHistory('https://cdn.example/missing.m3u8');
    expect((await history.getHistoryPage()).counts).toEqual({ all: 2, normal: 1, abnormal: 0, pending: 1 });
    const after = JSON.parse(await (await history.exportHistory()).text());
    expect(after.count).toBe(2);
    expect(after.items.map((item: { url: string }) => item.url)).toContain(observation().url);
  });

  it('exports all records in a versioned JSON backup rather than just one page', async () => {
    for (let index = 0; index < 4; index += 1) {
      await history.archiveHistory(observation({ url: `https://cdn.example/${index}.m3u8` }), source);
    }
    const blob = await history.exportHistory();
    const backup = JSON.parse(await blob.text());
    expect(blob.type).toBe('application/json;charset=utf-8');
    expect(backup).toMatchObject({ format: 'm3u8-catcher-history', version: 1, count: 4 });
    expect(Number.isFinite(Date.parse(backup.exportedAt))).toBe(true);
    expect(backup.items).toHaveLength(4);
    expect(backup.items[0]).toMatchObject(source);
    await history.deleteHistory('https://cdn.example/0.m3u8');
    expect((await history.getHistoryPage()).total).toBe(3);
  });

  it('exports an empty database as valid JSON and rejects arbitrary URLs', async () => {
    await history.archiveHistory(observation({ url: 'file:///secret.m3u8' }), source);
    await history.archiveHistory(observation({ detectedBy: [] }), source);
    expect(JSON.parse(await (await history.exportHistory()).text())).toMatchObject({ count: 0, items: [] });
  });

  it('sanitizes pagination arguments to safe bounded values', async () => {
    expect(await history.getHistoryPage({ offset: -20, limit: 9999 })).toMatchObject({ offset: 0, limit: 200 });
    expect(await history.getHistoryPage({ offset: Number.NaN, limit: Number.POSITIVE_INFINITY }))
      .toMatchObject({ offset: 0, limit: 50 });
  });

  it('publishes unique revisions and keeps a failed-write warning visible after a later success', async () => {
    const data: Record<string, unknown> = {};
    const readStorage = vi.fn(async (key: string) => ({ [key]: data[key] }));
    const writeStorage = vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, values); });
    vi.stubGlobal('chrome', { storage: { local: {
      get: readStorage,
      set: writeStorage,
    } } });
    await history.archiveHistory(observation(), source);
    const firstRevision = data['history-revision'];
    expect(data['history-status']).toBeUndefined();
    expect(writeStorage).toHaveBeenLastCalledWith({ 'history-revision': expect.any(String) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await history.reportHistoryError(new Error('Disk is full'));
    await history.archiveHistory(observation({ time: 200 }), source);
    expect(data['history-status']).toMatchObject({ error: 'Disk is full' });
    expect(data['history-revision']).not.toBe(firstRevision);
    expect(readStorage).not.toHaveBeenCalled();
    expect(writeStorage).toHaveBeenLastCalledWith({ 'history-revision': expect.any(String) });
    consoleError.mockRestore();
  });

  it('surfaces database access failures to the UI and capture caller', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Disk denied', 'UnknownError'); } });
    await expect(history.getHistoryPage()).rejects.toThrow('Disk denied');
    await expect(history.archiveHistory(observation(), source)).rejects.toThrow('Disk denied');
    await expect(history.exportHistory()).rejects.toThrow('Disk denied');
    await expect(history.closeHistoryDatabase()).resolves.toBeUndefined();
  });
});
