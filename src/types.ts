export interface CaptureItem {
  id: string;
  url: string;
  hostname: string;
  firstSeen: number;
  lastSeen: number;
  requestCount: number;
  method: string;
  statusCode?: number;
  error?: string;
  detectedBy: Array<'url' | 'content-type'>;
}

export interface TabCapture {
  tabId: number;
  pageUrl: string;
  items: CaptureItem[];
  updatedAt: number;
  limitReached?: boolean;
}

export type CaptureResponse =
  | { ok: true; capture: TabCapture }
  | { ok: false; error: string };
