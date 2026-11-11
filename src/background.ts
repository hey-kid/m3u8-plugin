import { createCapture, detectPlaylist, isHttpUrl, isPlaylistUrl, observeCapture } from './capture';
import type { CaptureObservation } from './capture';
import { archiveHistory, reportHistoryError } from './history';
import type { HistorySource } from './history';
import type { TabCapture } from './types';

interface TabMetadata {
  generation: string;
  navigationRequestId?: string;
  navigationStartedAt: number;
  pendingNavigation: boolean;
  documentId?: string;
  documentIds: string[];
  retiredDocumentIds: string[];
  documentRoots: Record<string, string>;
}

interface PageState {
  capture: TabCapture;
  metadata: TabMetadata;
}

interface TabState extends PageState {
  previous?: PageState;
}

interface StoredMetadata extends TabMetadata {
  previous?: PageState;
  provisionalCapture?: TabCapture;
}

interface RequestDetails {
  tabId: number;
  requestId: string;
  url: string;
  method: string;
  timeStamp: number;
  type: string;
  frameId?: number;
  documentId?: string;
  parentDocumentId?: string;
  documentLifecycle?: string;
}

const filter: chrome.webRequest.RequestFilter = { urls: ['http://*/*', 'https://*/*'] };
const states = new Map<number, TabState>();
const queues = new Map<number, Promise<void>>();
const closedTabs = new Set<number>();
const requestGenerations = new Map<number, Map<string, string>>();
const historyQueues = new Map<number, Promise<void>>();
const historySources = new Map<string, Promise<HistorySource | undefined>>();
interface HistoryTabMetadata { incognito: boolean; pageUrl: string; pageTitle: string }
const knownTabs = new Map<number, HistoryTabMetadata>();
const tabMetadataReads = new Map<number, Promise<HistoryTabMetadata | undefined>>();
const historyPageUrls = new Map<number, string>();
interface PendingHistoryRequest { source: HistorySource; playlistUrl?: string }
const pendingHistoryRequests = new Map<number, Record<string, PendingHistoryRequest>>();

/** Lets lifecycle verification wait for the separate, durable archive queue. */
export async function waitForHistoryWrites(): Promise<void> {
  await Promise.all(historyQueues.values());
}

const captureKey = (tabId: number) => `tab:${tabId}`;
const metadataKey = (tabId: number) => `tab-meta:${tabId}`;
const historyInFlightKey = (tabId: number) => `history-inflight:${tabId}`;

function newMetadata(time: number): TabMetadata {
  return {
    generation: crypto.randomUUID(),
    navigationStartedAt: time,
    pendingNavigation: false,
    documentIds: [],
    retiredDocumentIds: [],
    documentRoots: {},
  };
}

/** All reads and writes for a tab share one queue, including navigation and removal. */
function enqueue<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(tabId) ?? Promise.resolve()).then(work);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(tabId, settled);
  void settled.then(() => {
    if (queues.get(tabId) === settled) queues.delete(tabId);
  });
  return next;
}

function reportError(error: unknown): void {
  console.error('Unable to update captured playlist records.', error);
}

function schedule(tabId: number, work: () => Promise<void>): void {
  if (tabId < 0 || closedTabs.has(tabId)) return;
  void enqueue(tabId, work).catch(reportError);
}

function historyRequestKey(details: RequestDetails): string {
  return `${details.tabId}:${details.requestId}`;
}

function sourceForHistory(details: RequestDetails): Promise<HistorySource | undefined> {
  const key = historyRequestKey(details);
  const existing = historySources.get(key);
  if (existing) return existing;
  // Begin the tab lookup at the event, before a tab-close event can remove it.
  // The historical archive has its own queue and survives current-page resets.
  const state = states.get(details.tabId);
  const pageUrl = (state ? pageForRequest(state, details)?.capture.pageUrl : undefined)
    ?? historyPageUrls.get(details.tabId);
  const cached = knownTabs.get(details.tabId);
  let tabMetadata = cached ? Promise.resolve(cached) : tabMetadataReads.get(details.tabId);
  if (!tabMetadata) {
    tabMetadata = chrome.tabs.get(details.tabId).then((tab) => {
      const metadata = {
        incognito: tab.incognito === true,
        pageUrl: tab.url ?? tab.pendingUrl ?? '', pageTitle: tab.title ?? '',
      };
      if (!closedTabs.has(details.tabId)) knownTabs.set(details.tabId, metadata);
      return metadata;
    }).catch(() => knownTabs.get(details.tabId));
    tabMetadataReads.set(details.tabId, tabMetadata);
    void tabMetadata.then(() => tabMetadataReads.delete(details.tabId));
  }
  const source = tabMetadata.then((metadata) => {
    // Unknown/private tabs must never leak into the regular persistent archive.
    if (!metadata || metadata.incognito) return undefined;
    return {
      pageUrl: details.type === 'main_frame' ? details.url : pageUrl || metadata.pageUrl,
      pageTitle: metadata.pageTitle,
    };
  });
  historySources.set(key, source);
  if (historySources.size > 2_000) historySources.delete(historySources.keys().next().value!);
  return source;
}

function saveHistory(
  details: RequestDetails,
  observation: CaptureObservation,
  createIfMissing: boolean,
): void {
  if (details.tabId < 0) return;
  const earlierSource = historySources.get(historyRequestKey(details));
  enqueueHistory(details.tabId, async () => {
    const pending = await readPendingHistory(details.tabId);
    const origin = pending[details.requestId]?.source
      ?? await (earlierSource ?? sourceForHistory(details));
    if (!origin) return;
    pending[details.requestId] = { source: origin, playlistUrl: details.url };
    await persistPendingHistory(details.tabId, pending);
    await archiveHistory(observation, origin, { createIfMissing });
  });
}

function startHistory(details: RequestDetails): void {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  if (details.type === 'main_frame') historyPageUrls.set(details.tabId, details.url);
  const source = sourceForHistory(details);
  enqueueHistory(details.tabId, async () => {
    const origin = await source;
    if (!origin) return;
    const pending = await readPendingHistory(details.tabId);
    const detectedBy = detectPlaylist(details.url);
    pending[details.requestId] = {
      source: origin, ...(detectedBy.length ? { playlistUrl: details.url } : {}),
    };
    // Bound abandoned in-flight requests, independently of the unbounded archive.
    const abandoned = Object.keys(pending);
    if (abandoned.length > 2_000) delete pending[abandoned[0]];
    await persistPendingHistory(details.tabId, pending);
    if (detectedBy.length) await archiveHistory({
      url: details.url, time: details.timeStamp, method: details.method,
      detectedBy, countRequest: true,
    }, origin);
  });
}

function enqueueHistory(tabId: number, work: () => Promise<void>): void {
  const previous = historyQueues.get(tabId) ?? Promise.resolve();
  const next = previous.then(work).catch(reportHistoryError);
  historyQueues.set(tabId, next);
  void next.then(() => {
    if (historyQueues.get(tabId) === next) historyQueues.delete(tabId);
  });
}

async function readPendingHistory(tabId: number): Promise<Record<string, PendingHistoryRequest>> {
  const cached = pendingHistoryRequests.get(tabId);
  if (cached) return cached;
  const key = historyInFlightKey(tabId);
  const stored = await chrome.storage.session.get([key]).catch((error) => {
    reportError(error);
    return {} as Record<string, unknown>;
  });
  const pending = (stored[key] as Record<string, PendingHistoryRequest> | undefined) ?? {};
  pendingHistoryRequests.set(tabId, pending);
  return pending;
}

async function persistPendingHistory(tabId: number, pending: Record<string, PendingHistoryRequest>): Promise<void> {
  try {
    if (Object.keys(pending).length) {
      await chrome.storage.session.set({ [historyInFlightKey(tabId)]: pending });
    } else {
      await chrome.storage.session.remove([historyInFlightKey(tabId)]);
    }
  } catch (error) {
    // Losing session tracking must not prevent an identified URL being archived.
    reportError(error);
  }
}

function finishHistory(details: RequestDetails & { statusCode?: number; error?: string }): void {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  const suffixSource = isPlaylistUrl(details.url) ? sourceForHistory(details) : undefined;
  // MIME-only request IDs survive service worker recycling in session storage.
  // Ordinary HTTP completions only consult the per-tab cache, never IndexedDB.
  enqueueHistory(details.tabId, async () => {
    const pending = await readPendingHistory(details.tabId);
    const marked = pending[details.requestId];
    const recognized = suffixSource || marked?.playlistUrl === details.url;
    const origin = marked?.source ?? (suffixSource ? await suffixSource : undefined);
    if (recognized && origin) await archiveHistory({
      url: details.url, time: details.timeStamp, method: details.method,
      detectedBy: [], countRequest: false, statusCode: details.statusCode, error: details.error,
    }, origin, { createIfMissing: false });
    if (marked) {
      delete pending[details.requestId];
      await persistPendingHistory(details.tabId, pending);
    }
  });
  historySources.delete(historyRequestKey(details));
}

async function readState(tabId: number): Promise<TabState> {
  const cached = states.get(tabId);
  if (cached) return cached;
  const stored = await chrome.storage.session.get([captureKey(tabId), metadataKey(tabId)]);
  let pageUrl = '';
  if (!stored[captureKey(tabId)]) {
    try {
      const tab = await chrome.tabs.get(tabId);
      pageUrl = tab.url ?? tab.pendingUrl ?? '';
    } catch {
      // The tab can close between the event and this asynchronous read.
    }
  }
  const storedMetadata = stored[metadataKey(tabId)] as StoredMetadata | undefined;
  const savedMetadata: StoredMetadata = storedMetadata ?? newMetadata(0);
  const { previous, provisionalCapture, ...metadata } = savedMetadata;
  const capture = provisionalCapture ?? (stored[captureKey(tabId)] as TabCapture | undefined)
    ?? createCapture(tabId, pageUrl);
  const state: TabState = {
    capture,
    metadata,
    previous,
  };
  state.metadata.documentRoots ??= {};
  states.set(tabId, state);
  return state;
}

async function persist(tabId: number, state: TabState): Promise<void> {
  if (closedTabs.has(tabId)) return;
  const visibleCapture = state.previous?.capture ?? state.capture;
  await chrome.storage.session.set({
    [captureKey(tabId)]: visibleCapture,
    [metadataKey(tabId)]: {
      ...state.metadata,
      ...(state.previous ? { previous: state.previous, provisionalCapture: state.capture } : {}),
    },
  });
  // Badge failures (e.g. a tab closing) must not discard the captured URLs.
  await Promise.all([
    chrome.action.setBadgeText({
      tabId,
      text: visibleCapture.items.length
        ? `${visibleCapture.items.length}${visibleCapture.limitReached ? '+' : ''}`
        : '',
    }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#237b64' }),
  ]).catch(() => undefined);
}

function rememberRequest(tabId: number, requestId: string, generation: string): void {
  let requests = requestGenerations.get(tabId);
  if (!requests) {
    requests = new Map();
    requestGenerations.set(tabId, requests);
  }
  requests.set(requestId, generation);
  // Normally final events remove entries; cap abandoned requests as well.
  if (requests.size > 2_000) requests.delete(requests.keys().next().value!);
}

function forgetRequest(tabId: number, requestId: string): void {
  const requests = requestGenerations.get(tabId);
  requests?.delete(requestId);
  if (requests?.size === 0) requestGenerations.delete(tabId);
}

function belongsToCurrentPage(state: PageState, details: RequestDetails): boolean {
  const generation = requestGenerations.get(details.tabId)?.get(details.requestId);
  if (generation && generation !== state.metadata.generation) return false;
  if (details.timeStamp < state.metadata.navigationStartedAt) return false;
  if (details.documentLifecycle && details.documentLifecycle !== 'active') return false;
  const root = rootForDocument(state, details);
  if (root && state.metadata.retiredDocumentIds.includes(root)
    && root !== state.metadata.documentId) return false;
  if (root && state.metadata.documentId && root !== state.metadata.documentId) return false;
  if (!details.documentId || !state.metadata.retiredDocumentIds.includes(details.documentId)) {
    return true;
  }
  // BFCache restores a whole frame tree. Its child documents keep their IDs,
  // while requests from a different, retired top-level document remain excluded.
  return state.metadata.documentId !== undefined
    && root === state.metadata.documentId;
}

function rootForDocument(
  state: PageState,
  details: { documentId?: string; parentDocumentId?: string; frameId?: number },
): string | undefined {
  if (!details.documentId) return undefined;
  if (details.frameId === 0) return details.documentId;
  return state.metadata.documentRoots[details.documentId]
    ?? (details.parentDocumentId
      ? state.metadata.documentRoots[details.parentDocumentId]
        ?? (details.parentDocumentId === state.metadata.documentId ? details.parentDocumentId : undefined)
      : undefined);
}

function rememberDocument(
  state: PageState,
  details: { documentId?: string; parentDocumentId?: string; frameId?: number },
): boolean {
  if (!details.documentId) return false;
  let changed = false;
  if (details.frameId === 0 && !state.metadata.documentId && !state.metadata.pendingNavigation) {
    state.metadata.documentId = details.documentId;
    changed = true;
  }
  const root = rootForDocument(state, details);
  if (root && state.metadata.documentRoots[details.documentId] !== root) {
    state.metadata.documentRoots = Object.fromEntries([
      ...Object.entries(state.metadata.documentRoots),
      [details.documentId, root],
    ].slice(-1_024));
    changed = true;
  }
  if (!state.metadata.documentIds.includes(details.documentId)) {
    state.metadata.documentIds = [...state.metadata.documentIds, details.documentId].slice(-256);
    changed = true;
  }
  return changed;
}

function pageForRequest(state: TabState, details: RequestDetails): PageState | undefined {
  if (belongsToCurrentPage(state, details)) return state;
  if (state.previous && belongsToCurrentPage(state.previous, details)) return state.previous;
  return undefined;
}

async function settleFinishedNavigation(tabId: number, state: TabState, time: number): Promise<boolean> {
  if (!state.previous || !state.metadata.pendingNavigation) return false;
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    // A cancelled/download navigation leaves the old document in place. A new
    // error document or a successful commit must keep its own capture generation.
    if (!frame) return false;
    if (!state.previous.metadata.documentId && frame.url === state.previous.capture.pageUrl) {
      rememberDocument(state.previous, { documentId: frame.documentId, frameId: 0 });
    }
    const updatedAt = Math.max(state.capture.updatedAt, state.previous.capture.updatedAt, time);
    if (frame.documentId === state.previous.metadata.documentId) {
      state.capture = state.previous.capture;
      state.capture.updatedAt = updatedAt;
      state.metadata = state.previous.metadata;
    } else {
      // A failed navigation can display a new browser error document without a
      // normal onCommitted event. Only finalize a positively identified active
      // document; absence of frame information is not evidence of a new page.
      if (frame.documentLifecycle !== 'active') return false;
      state.capture = frame.errorOccurred
        ? createCapture(tabId, frame.url, updatedAt)
        : { ...state.capture, pageUrl: frame.url, updatedAt };
      state.metadata.pendingNavigation = false;
      state.metadata.documentId = frame.documentId;
      state.metadata.retiredDocumentIds = state.metadata.retiredDocumentIds
        .filter((documentId) => documentId !== frame.documentId);
      if (frame.errorOccurred) state.metadata.documentIds = [];
      rememberDocument(state, { documentId: frame.documentId, frameId: 0 });
    }
    delete state.previous;
    await persist(tabId, state);
    return true;
  } catch {
    return false;
  }
}

function resetForNavigation(
  state: TabState,
  tabId: number,
  pageUrl: string,
  time: number,
  requestId?: string,
  documentId?: string,
): void {
  const retired = new Set([
    ...state.metadata.retiredDocumentIds,
    ...state.metadata.documentIds,
    ...(state.metadata.documentId ? [state.metadata.documentId] : []),
  ]);
  const documentRoots = state.metadata.documentRoots;
  if (state.metadata.documentId) {
    for (const [childId, rootId] of Object.entries(documentRoots)) {
      if (rootId === state.metadata.documentId) retired.add(childId);
    }
  }
  if (documentId) {
    retired.delete(documentId);
    for (const retiredId of retired) {
      if (documentRoots[retiredId] === documentId) retired.delete(retiredId);
    }
  }
  state.capture = createCapture(tabId, pageUrl, time);
  state.metadata = {
    ...newMetadata(time),
    navigationRequestId: requestId,
    pendingNavigation: requestId !== undefined,
    documentId,
    documentIds: documentId ? [documentId] : [],
    retiredDocumentIds: [...retired].slice(-512),
    documentRoots: { ...documentRoots, ...(documentId ? { [documentId]: documentId } : {}) },
  };
}

// Register listeners synchronously at worker startup so event-based wakeups work.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  startHistory(details);
  schedule(details.tabId, async () => {
    if (closedTabs.has(details.tabId)) return;
    const state = await readState(details.tabId);
    let changed = false;
    if (details.type === 'main_frame') {
      if (state.metadata.navigationRequestId !== details.requestId) {
        // Start the new page before any of its resources can be enqueued. Redirects
        // retain the same requestId and therefore never clear captured preloads.
        if (!state.previous) {
          state.previous = structuredClone({ capture: state.capture, metadata: state.metadata });
          if (!state.previous.metadata.documentId) {
            try {
              const frame = await chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: 0 });
              if (frame?.documentId && frame.url === state.previous.capture.pageUrl
                && frame.url !== details.url) {
                rememberDocument(state.previous, { documentId: frame.documentId, frameId: 0 });
                // Also retire the old frame in the provisional capture below.
                rememberDocument(state, { documentId: frame.documentId, frameId: 0 });
              }
            } catch {
              // A fresh tab may not have a committed document yet.
            }
          }
        }
        resetForNavigation(state, details.tabId, details.url, details.timeStamp, details.requestId);
      } else {
        state.capture.pageUrl = details.url;
      }
      changed = true;
    }
    const page = pageForRequest(state, details);
    if (!page) return;
    rememberRequest(details.tabId, details.requestId, page.metadata.generation);
    changed = rememberDocument(page, details) || changed;
    const detectedBy = detectPlaylist(details.url);
    if (detectedBy.length) {
      page.capture = observeCapture(page.capture, {
        url: details.url,
        time: details.timeStamp,
        method: details.method,
        detectedBy,
        countRequest: true,
      });
      changed = true;
    }
    if (changed) await persist(details.tabId, state);
  });
}, filter);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const detectedHistory = detectPlaylist(details.url, details.responseHeaders);
  if (detectedHistory.length) {
    saveHistory(details, {
      url: details.url, time: details.timeStamp, method: details.method,
      detectedBy: detectedHistory, countRequest: !isPlaylistUrl(details.url),
      statusCode: details.statusCode,
    }, !isPlaylistUrl(details.url));
  }
  schedule(details.tabId, async () => {
    const state = await readState(details.tabId);
    const page = pageForRequest(state, details);
    if (!page) return;
    const detectedBy = detectPlaylist(details.url, details.responseHeaders);
    const documentChanged = rememberDocument(page, details);
    if (detectedBy.length) {
      page.capture = observeCapture(page.capture, {
        url: details.url,
        time: details.timeStamp,
        method: details.method,
        detectedBy,
        // Suffix URLs were counted in onBeforeRequest; MIME-only URLs are first
        // identified here. This remains correct when the worker was recycled.
        countRequest: !isPlaylistUrl(details.url),
        statusCode: details.statusCode,
      });
      await persist(details.tabId, state);
    } else if (documentChanged) {
      await persist(details.tabId, state);
    }
  });
}, filter, ['responseHeaders']);

function finishRequest(details: RequestDetails & { statusCode?: number; error?: string }): void {
  finishHistory(details);
  schedule(details.tabId, async () => {
    const state = await readState(details.tabId);
    if (details.type === 'main_frame'
      && state.metadata.navigationRequestId === details.requestId
      && await settleFinishedNavigation(details.tabId, state, details.timeStamp)) {
      forgetRequest(details.tabId, details.requestId);
      return;
    }
    const page = pageForRequest(state, details);
    if (page) {
      const capture = observeCapture(page.capture, {
        url: details.url,
        time: details.timeStamp,
        method: details.method,
        detectedBy: [],
        countRequest: false,
        statusCode: details.statusCode,
        error: details.error,
      });
      if (capture !== page.capture) {
        page.capture = capture;
        await persist(details.tabId, state);
      }
    }
    forgetRequest(details.tabId, details.requestId);
  });
}

chrome.webRequest.onCompleted.addListener(finishRequest, filter);
chrome.webRequest.onErrorOccurred.addListener(finishRequest, filter);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) historyPageUrls.set(details.tabId, details.url);
  schedule(details.tabId, async () => {
    const state = await readState(details.tabId);
    if (details.timeStamp < state.metadata.navigationStartedAt) return;
    if (details.frameId !== 0) {
      // Keep ancestry for BFCache restores, including nested embedded players.
      if (rememberDocument(state, details)) await persist(details.tabId, state);
      return;
    }
    const pendingNetworkNavigation = state.metadata.pendingNavigation
      && state.capture.pageUrl === details.url;
    if (!pendingNetworkNavigation && state.metadata.documentId !== details.documentId) {
      // BFCache restores and non-HTTP navigations may have no webRequest event.
      resetForNavigation(state, details.tabId, details.url, details.timeStamp, undefined, details.documentId);
    } else {
      // Do not clear again on commit: the new page may already have requested HLS.
      state.capture.pageUrl = details.url;
      state.metadata.pendingNavigation = false;
      state.metadata.documentId = details.documentId;
      state.metadata.retiredDocumentIds = state.metadata.retiredDocumentIds
        .filter((documentId) => documentId !== details.documentId);
      rememberDocument(state, details);
    }
    state.capture.updatedAt = Math.max(
      state.capture.updatedAt, details.timeStamp, state.previous?.capture.updatedAt ?? 0,
    );
    delete state.previous;
    await persist(details.tabId, state);
  });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  schedule(details.tabId, async () => {
    const state = await readState(details.tabId);
    if (state.capture.pageUrl === details.url && details.timeStamp >= state.metadata.navigationStartedAt) {
      await settleFinishedNavigation(details.tabId, state, details.timeStamp);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab) knownTabs.set(tabId, {
    incognito: tab.incognito === true,
    pageUrl: tab.url ?? tab.pendingUrl ?? '', pageTitle: tab.title ?? '',
  });
  if (changeInfo.url) historyPageUrls.set(tabId, changeInfo.url);
  if (!changeInfo.url) return;
  schedule(tabId, async () => {
    const state = await readState(tabId);
    // History/fragment changes retain the document and its captured resources.
    // Full navigation is handled by webRequest + onCommitted, never a late clear.
    if (!state.metadata.pendingNavigation && state.capture.pageUrl !== changeInfo.url) {
      state.capture.pageUrl = changeInfo.url!;
      await persist(tabId, state);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  closedTabs.add(tabId);
  void enqueue(tabId, async () => {
    states.delete(tabId);
    requestGenerations.delete(tabId);
    await chrome.storage.session.remove([captureKey(tabId), metadataKey(tabId)]);
    // Existing archival work already holds its origin promise. Delayed network
    // events can still use metadata while the remaining writes settle.
    const historyWork = historyQueues.get(tabId);
    void (historyWork ?? Promise.resolve()).then(async () => {
      knownTabs.delete(tabId);
      pendingHistoryRequests.delete(tabId);
      historyPageUrls.delete(tabId);
      await chrome.storage.session.remove([historyInFlightKey(tabId)]);
    }).catch(reportError);
  }).catch(reportError);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) {
    closedTabs.delete(tab.id);
    knownTabs.set(tab.id, {
      incognito: tab.incognito === true,
      pageUrl: tab.url ?? tab.pendingUrl ?? '', pageTitle: tab.title ?? '',
    });
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    !message || typeof message !== 'object' || !('type' in message)
    || message.type !== 'GET_CAPTURE'
  ) return false;
  const tabId = 'tabId' in message ? message.tabId : undefined;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ ok: false, error: '无法读取当前标签页。' });
    return false;
  }
  void enqueue(tabId, async () => {
    if (closedTabs.has(tabId)) throw new Error('该标签页已关闭。');
    const state = await readState(tabId);
    // Restrict the popup to the HTTP(S) capture scope even after a privileged URL
    // navigation that did not generate a normal network request.
    const visibleCapture = state.previous?.capture ?? state.capture;
    sendResponse({
      ok: true,
      capture: isHttpUrl(visibleCapture.pageUrl)
        ? visibleCapture
        : { ...visibleCapture, items: [], limitReached: false },
    });
  }).catch(() => sendResponse({ ok: false, error: '读取抓取记录失败，请重试。' }));
  return true;
});
