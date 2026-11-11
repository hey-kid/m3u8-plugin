import type { CaptureItem } from './types';

export type ResourceStatus = 'normal' | 'abnormal' | 'pending';
export type StatusFilter = 'all' | ResourceStatus;

export interface StatusCounts {
  all: number;
  normal: number;
  abnormal: number;
  pending: number;
}

type CaptureResult = Pick<CaptureItem, 'statusCode' | 'error'>;

/** A received HTTP 2xx is normal unless a network error accompanies it. */
export function classifyCapture(item: CaptureResult): ResourceStatus {
  if (item.error?.trim()) return 'abnormal';
  const code = item.statusCode;
  if (code === undefined || !Number.isInteger(code) || code < 100 || code > 599) return 'pending';
  return code >= 200 && code < 300 ? 'normal' : 'abnormal';
}

export function countCaptureStatuses(items: readonly CaptureResult[]): StatusCounts {
  const counts: StatusCounts = { all: 0, normal: 0, abnormal: 0, pending: 0 };
  for (const item of items) {
    counts.all += 1;
    counts[classifyCapture(item)] += 1;
  }
  return counts;
}
