import type { CaptureItem, TabCapture } from './types';

export const MAX_ITEMS_PER_TAB = 300;

const HLS_MIME_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'audio/vnd.apple.mpegurl',
]);

export interface ResponseHeader {
  name: string;
  value?: string;
}

export interface CaptureObservation {
  url: string;
  time: number;
  method: string;
  detectedBy: CaptureItem['detectedBy'];
  countRequest: boolean;
  statusCode?: number;
  error?: string;
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Only the path identifies a playlist; a query containing ".m3u8" is not enough. */
export function isPlaylistUrl(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  try {
    return /\.m3u8$/i.test(decodeURIComponent(new URL(url).pathname));
  } catch {
    // A malformed percent escape must not prevent a normal suffix from matching.
    return /\.m3u8$/i.test(new URL(url).pathname);
  }
}

export function detectPlaylist(
  url: string,
  responseHeaders: readonly ResponseHeader[] = [],
): CaptureItem['detectedBy'] {
  if (!isHttpUrl(url)) return [];
  const detectedBy: CaptureItem['detectedBy'] = [];
  if (isPlaylistUrl(url)) detectedBy.push('url');
  if (
    responseHeaders.some((header) => {
      if (header.name.toLowerCase() !== 'content-type' || !header.value) return false;
      return HLS_MIME_TYPES.has(header.value.split(';', 1)[0].trim().toLowerCase());
    })
  ) {
    detectedBy.push('content-type');
  }
  return detectedBy;
}

export function createCapture(tabId: number, pageUrl = '', time = Date.now()): TabCapture {
  return { tabId, pageUrl, items: [], updatedAt: time };
}

/** Pure aggregation: preserve every URL byte (especially signed query parameters). */
export function observeCapture(
  capture: TabCapture,
  observation: CaptureObservation,
  limit = MAX_ITEMS_PER_TAB,
): TabCapture {
  const index = capture.items.findIndex((item) => item.url === observation.url);
  if (index === -1) {
    if (observation.detectedBy.length === 0 || !isHttpUrl(observation.url)) return capture;
    if (capture.items.length >= limit) {
      return { ...capture, limitReached: true, updatedAt: observation.time };
    }
    const item: CaptureItem = {
      id: observation.url,
      url: observation.url,
      hostname: new URL(observation.url).hostname,
      firstSeen: observation.time,
      lastSeen: observation.time,
      requestCount: 1,
      method: observation.method,
      detectedBy: [...observation.detectedBy],
      ...(observation.statusCode !== undefined ? { statusCode: observation.statusCode } : {}),
      ...(observation.error !== undefined ? { error: observation.error } : {}),
    };
    return {
      ...capture,
      items: [...capture.items, item],
      updatedAt: Math.max(capture.updatedAt, observation.time),
    };
  }

  const previous = capture.items[index];
  const item: CaptureItem = {
    ...previous,
    lastSeen: Math.max(previous.lastSeen, observation.time),
    requestCount: previous.requestCount + (observation.countRequest ? 1 : 0),
    detectedBy: [...new Set([...previous.detectedBy, ...observation.detectedBy])],
  };
  if (observation.time >= previous.lastSeen) {
    item.method = observation.method;
    if (observation.countRequest) {
      delete item.error;
      delete item.statusCode;
    }
    if (observation.statusCode !== undefined) {
      item.statusCode = observation.statusCode;
      // Overlapping requests share a URL record. A later HTTP result replaces
      // another request's error; an error on this same observation still wins.
      if (observation.error === undefined) delete item.error;
    }
    if (observation.error !== undefined) item.error = observation.error;
  }
  const items = [...capture.items];
  items[index] = item;
  return { ...capture, items, updatedAt: Math.max(capture.updatedAt, observation.time) };
}
