import { isHttpUrl, observeCapture } from './capture';
import type { CaptureObservation } from './capture';
import { classifyCapture } from './status';
import type { StatusCounts, StatusFilter } from './status';
import type { CaptureItem } from './types';

export interface HistoryItem extends CaptureItem {
  pageUrl: string;
  pageTitle: string;
}

export interface HistoryPage {
  items: HistoryItem[];
  total: number;
  matched: number;
  /** Counts after applying the search query, before applying the status filter. */
  counts: StatusCounts;
  offset: number;
  limit: number;
}

export interface HistoryStatus {
  error: string | null;
  updatedAt: number;
}

export interface HistorySource {
  pageUrl: string;
  pageTitle: string;
}

export const HISTORY_STATUS_KEY = 'history-status';
export const HISTORY_REVISION_KEY = 'history-revision';
const DATABASE_NAME = 'm3u8-catcher-history';
const STORE_NAME = 'playlists';
let databasePromise: Promise<IDBDatabase> | undefined;
let notifications = Promise.resolve();

function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'url' });
      store.createIndex('lastSeen', 'lastSeen');
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开历史数据库。'));
    request.onblocked = () => reject(new Error('历史数据库正等待其他扩展窗口关闭，请关闭窗口后重试。'));
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = () => {
        connection.close();
        if (databasePromise === opening) databasePromise = undefined;
      };
      connection.onclose = () => {
        if (databasePromise === opening) databasePromise = undefined;
      };
      resolve(connection);
    };
  });
  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = undefined;
  });
  return opening;
}

/** Releases this context's connection, without deleting any saved records. */
export async function closeHistoryDatabase(): Promise<void> {
  const previous = databasePromise;
  databasePromise = undefined;
  if (previous) (await previous).close();
}

function transactionError(transaction: IDBTransaction): Error | DOMException {
  return transaction.error ?? new Error('历史数据库操作失败，可能是磁盘空间不足。');
}

function publishChange(error?: unknown): Promise<void> {
  // This module also runs in tests without Chrome. All database operations are
  // independent of extension storage; storage is only the popup's change signal.
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return Promise.resolve();
  const next = notifications.then(async () => {
    // A success must never overwrite a failure recorded concurrently by another
    // extension context. Only failures write the sticky status key.
    await chrome.storage.local.set({
      [HISTORY_REVISION_KEY]: crypto.randomUUID(),
      ...(error === undefined ? {} : {
        [HISTORY_STATUS_KEY]: {
          error: error instanceof Error ? error.message : String(error), updatedAt: Date.now(),
        } satisfies HistoryStatus,
      }),
    });
  });
  notifications = next.catch((notificationError) => {
    console.error('Unable to publish history storage status.', notificationError);
  });
  return notifications;
}

/** A failed capture remains visible as a warning even if a later write succeeds. */
export async function reportHistoryError(error: unknown): Promise<void> {
  console.error('Unable to save playlist history.', error);
  await publishChange(error);
}

/**
 * The read and merge stay inside one readwrite transaction, serializing updates
 * even when multiple tabs, workers, or popup connections write the same URL.
 * Final response events use createIfMissing=false so deleting a record cannot
 * be undone by an already in-flight request finishing.
 */
export async function archiveHistory(
  observation: CaptureObservation,
  source: HistorySource,
  { createIfMissing = true }: { createIfMissing?: boolean } = {},
): Promise<void> {
  if (!isHttpUrl(observation.url)) return;
  const connection = await database();
  const changed = await new Promise<boolean>((resolve, reject) => {
    const transaction = connection.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    let didChange = false;
    transaction.oncomplete = () => resolve(didChange);
    transaction.onerror = () => reject(transactionError(transaction));
    transaction.onabort = () => reject(transactionError(transaction));
    const request = store.get(observation.url);
    request.onsuccess = () => {
      const previous = request.result as HistoryItem | undefined;
      if (!previous && (!createIfMissing || observation.detectedBy.length === 0)) return;
      const result = observeCapture({
        tabId: -1, pageUrl: source.pageUrl, updatedAt: 0, items: previous ? [previous] : [],
      }, observation, Number.POSITIVE_INFINITY);
      const captured = result.items[0];
      if (!captured) return;
      const item: HistoryItem = {
        ...captured,
        firstSeen: Math.min(previous?.firstSeen ?? observation.time, observation.time),
        pageUrl: previous?.pageUrl ?? source.pageUrl,
        pageTitle: previous?.pageTitle ?? source.pageTitle,
      };
      if (!previous || observation.time >= previous.lastSeen) {
        if (source.pageUrl) item.pageUrl = source.pageUrl;
        if (source.pageTitle) item.pageTitle = source.pageTitle;
      }
      store.put(item);
      didChange = true;
    };
  });
  if (changed) await publishChange();
}

function matches(item: HistoryItem, query: string): boolean {
  if (!query) return true;
  return [item.url, item.hostname, item.pageUrl, item.pageTitle]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** Reads only the requested result page into memory, in most-recent order. */
export async function getHistoryPage({
  query = '', offset = 0, limit = 50, status = 'all',
}: { query?: string; offset?: number; limit?: number; status?: StatusFilter } = {}): Promise<HistoryPage> {
  const connection = await database();
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const normalizedLimit = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 50;
  const search = normalizedQuery(query);
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const result: HistoryPage = {
      items: [], total: 0, matched: 0, offset: normalizedOffset, limit: normalizedLimit,
      counts: { all: 0, normal: 0, abnormal: 0, pending: 0 },
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transactionError(transaction));
    transaction.onabort = () => reject(transactionError(transaction));
    const count = store.count();
    count.onsuccess = () => { result.total = count.result; };
    const request = store.index('lastSeen').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value as HistoryItem;
      if (matches(item, search)) {
        const classification = classifyCapture(item);
        result.counts.all += 1;
        result.counts[classification] += 1;
        if (status === 'all' || status === classification) {
          if (result.matched >= normalizedOffset && result.items.length < normalizedLimit) {
            result.items.push(item);
          }
          result.matched += 1;
        }
      }
      cursor.continue();
    };
  });
}

/** Includes every matching record, including results beyond the visible page. */
export async function getHistoryUrls(query = '', status: StatusFilter = 'all'): Promise<string[]> {
  const connection = await database();
  const search = normalizedQuery(query);
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE_NAME, 'readonly');
    const urls: string[] = [];
    transaction.oncomplete = () => resolve(urls);
    transaction.onerror = () => reject(transactionError(transaction));
    transaction.onabort = () => reject(transactionError(transaction));
    const request = transaction.objectStore(STORE_NAME).index('lastSeen').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value as HistoryItem;
      if (matches(item, search) && (status === 'all' || status === classifyCapture(item))) urls.push(item.url);
      cursor.continue();
    };
  });
}

export async function deleteHistory(url: string): Promise<void> {
  const connection = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = connection.transaction(STORE_NAME, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transactionError(transaction));
    transaction.onabort = () => reject(transactionError(transaction));
    transaction.objectStore(STORE_NAME).delete(url);
  });
  await publishChange();
}

/** A single consistent database snapshot, streamed to Blob parts via a cursor. */
export async function exportHistory(): Promise<Blob> {
  const connection = await database();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const parts: string[] = [];
    let first = true;
    transaction.oncomplete = () => {
      parts.push(']}');
      resolve(new Blob(parts, { type: 'application/json;charset=utf-8' }));
    };
    transaction.onerror = () => reject(transactionError(transaction));
    transaction.onabort = () => reject(transactionError(transaction));
    const count = store.count();
    count.onsuccess = () => {
      parts.push(`{"format":"m3u8-catcher-history","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"count":${count.result},"items":[`);
    };
    const request = store.index('lastSeen').openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      parts.push(`${first ? '' : ','}${JSON.stringify(cursor.value)}`);
      first = false;
      cursor.continue();
    };
  });
}
