import './popup.css';
import { deleteHistory, exportHistory, getHistoryPage, getHistoryUrls } from './history';
import type { HistoryItem, HistoryPage } from './history';
import type { CaptureItem, CaptureResponse, TabCapture } from './types';
import { classifyCapture, countCaptureStatuses } from './status';
import type { StatusCounts, StatusFilter } from './status';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing popup element: ${id}`);
  return found as T;
}

const ui = {
  title: element('page-title'), domain: element('page-domain'),
  monitor: element('monitor-state'), monitorLabel: element('monitor-label'),
  currentTab: element<HTMLButtonElement>('view-current'),
  historyTab: element<HTMLButtonElement>('view-history'), historyTotal: element('history-total'),
  pageContext: element('page-context'), historyContext: element('history-context'),
  historyTools: element('history-tools'), search: element<HTMLInputElement>('history-search'),
  export: element<HTMLButtonElement>('export-history'), exportLabel: element('export-label'),
  warning: element('history-warning'), panel: element('resource-panel'),
  heading: element('resources-title'), count: element('resource-count'), caption: element('list-caption'),
  statusNormal: element<HTMLButtonElement>('status-normal'), statusAbnormal: element<HTMLButtonElement>('status-abnormal'),
  statusPending: element<HTMLButtonElement>('status-pending'), statusAll: element<HTMLButtonElement>('status-all'),
  statusHint: element('status-hint'),
  loading: element('loading-state'), empty: element('empty-state'),
  emptyTitle: element('empty-title'), emptyDescription: element('empty-description'), emptyHint: element('empty-hint'),
  error: element('error-state'), errorMessage: element('error-message'), retry: element<HTMLButtonElement>('retry-button'),
  list: element<HTMLOListElement>('resource-list'), limit: element('limit-notice'),
  pagination: element('history-pagination'), pageInfo: element('history-page-info'),
  previous: element<HTMLButtonElement>('history-prev'), next: element<HTMLButtonElement>('history-next'),
  copyAll: element<HTMLButtonElement>('copy-all'), copyAllLabel: element('copy-all-label'),
  footer: element('footer-note'), toast: element('toast'),
  deleteDialog: element<HTMLDialogElement>('delete-dialog'), deleteName: element('delete-resource-name'),
  deleteError: element('delete-error'), cancelDelete: element<HTMLButtonElement>('cancel-delete'),
  confirmDelete: element<HTMLButtonElement>('confirm-delete'),
};

type View = 'current' | 'history';
type Phase = 'loading' | 'ready' | 'unsupported' | 'error';
const PAGE_SIZE = 30;
let view: View = 'current';
let statusFilter: StatusFilter = 'normal';
let activeTabId: number | undefined;
let currentCapture: TabCapture | undefined;
let currentItems: CaptureItem[] = [];
let currentPhase: Phase = 'loading';
let currentError = '';
let loadSequence = 0;
let historyPage: HistoryPage | undefined;
let historyPhase: Phase = 'loading';
let historyQuery = '';
let historyOffset = 0;
let historySequence = 0;
let historyTotal = 0;
let historyError = '';
let historyReads = 0;
let historyNeedsRefresh = false;
let searchPending = false;
let copying = false;
let exporting = false;
let deleting = false;
let deletion: HistoryItem | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const cards = new Map<string, { node: HTMLLIElement; update: (item: CaptureItem | HistoryItem) => void }>();
const STATUS_NAMES: Record<StatusFilter, string> = { normal: '正常', abnormal: '异常', pending: '待确认', all: '全部' };

function filteredCurrentItems(): CaptureItem[] {
  return statusFilter === 'all' ? currentItems : currentItems.filter((item) => classifyCapture(item) === statusFilter);
}

function renderStatusControls(counts?: StatusCounts): void {
  const buttons: Record<StatusFilter, HTMLButtonElement> = {
    normal: ui.statusNormal, abnormal: ui.statusAbnormal, pending: ui.statusPending, all: ui.statusAll,
  };
  for (const [category, button] of Object.entries(buttons)) {
    const active = category === statusFilter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    const count = counts?.[category as StatusFilter].toLocaleString('zh-CN');
    const badge = button.querySelector<HTMLElement>('[data-status-count]')!;
    badge.textContent = count ?? '—';
    badge.title = count ? `${count} 条地址` : '数量加载中';
    button.setAttribute('aria-label', `${STATUS_NAMES[category as StatusFilter]}，${count ? `${count} 条地址` : '数量加载中'}`);
  }
  ui.statusHint.textContent = {
    normal: '正常：HTTP 2xx 且无网络错误；右侧徽标表示地址数量。',
    abnormal: '显示非 2xx 状态和网络失败，记录仍然保留。',
    pending: '尚无响应状态，暂不计入正常或异常。',
    all: '显示所有地址，分类按最近捕获到的结果更新。',
  }[statusFilter];
}

function icon(paths: string[], size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(key, value);
  for (const data of paths) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message: string, isError = false): void {
  if (toastTimer) clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.toggle('is-error', isError);
  ui.toast.hidden = false;
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, isError ? 4500 : 2400);
}

async function copyText(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    showToast('复制失败，请展开完整地址后手动选择复制。', true);
  }
}

function resourceName(url: string): string {
  try {
    const lastPart = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    return lastPart ? decodeURIComponent(lastPart) : 'HLS 播放列表';
  } catch { return 'HLS 播放列表'; }
}

function shortPath(url: string): string {
  try { const parsed = new URL(url); return parsed.pathname + parsed.search; }
  catch { return url; }
}

function sourceName(item: HistoryItem): string {
  if (item.pageTitle) return item.pageTitle;
  try { return new URL(item.pageUrl).hostname; }
  catch { return '来源未记录'; }
}

function askToDelete(item: HistoryItem): void {
  if (deleting) return;
  deletion = item;
  ui.deleteName.textContent = resourceName(item.url);
  ui.deleteName.title = item.url;
  ui.deleteError.hidden = true;
  ui.deleteDialog.showModal();
  ui.cancelDelete.focus();
}

function makeCard(initial: CaptureItem | HistoryItem) {
  let item = initial;
  const isHistory = 'pageUrl' in initial;
  const node = create('li', `resource-card${isHistory ? ' history-card' : ''}`);
  node.dataset.testid = 'resource-item'; node.dataset.resourceId = item.id;
  const heading = create('div', 'resource-heading');
  const fileIcon = create('div', 'resource-icon');
  fileIcon.append(icon(['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z', 'M14 3v6h6', 'm9 12 5 3-5 3v-6Z'], 19));
  const identity = create('div', 'resource-identity');
  const name = create('h3', 'resource-name'); const host = create('p', 'resource-host');
  identity.append(name, host);
  const copyButton = create('button', 'copy-button');
  copyButton.type = 'button'; copyButton.dataset.testid = 'copy-one';
  copyButton.append(icon(['M9 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z', 'M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3']), create('span', '', '复制'));
  copyButton.addEventListener('click', () => { void copyText(item.url, '已复制完整地址'); });
  heading.append(fileIcon, identity, copyButton);
  if (isHistory) {
    const remove = create('button', 'delete-button');
    remove.type = 'button'; remove.dataset.testid = 'delete-one'; remove.title = '删除这条历史';
    remove.append(icon(['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'], 15));
    remove.addEventListener('click', () => { askToDelete(item as HistoryItem); });
    heading.append(remove); remove.setAttribute('aria-label', `删除 ${resourceName(item.url)} 的历史记录`);
  }
  const path = create('p', isHistory ? 'resource-source' : 'resource-path');
  const metadata = create('div', 'resource-metadata');
  const type = create('span', 'type-label', 'M3U8'); const requests = create('span', 'request-label');
  const date = create('time', 'history-date'); const status = create('span', 'request-status');
  metadata.append(type, requests); if (isHistory) metadata.append(date); metadata.append(status);
  const details = create('details', 'resource-details');
  const summary = create('summary', 'resource-summary', isHistory ? '完整地址与来源' : '查看完整地址');
  summary.append(icon(['m9 5 7 7-7 7'], 12));
  const fullUrl = create('code', 'resource-full-url');
  fullUrl.dataset.testid = 'resource-url'; fullUrl.tabIndex = 0;
  details.append(summary, fullUrl);
  const origin = create('p', 'source-detail'); const originUrl = create('code', 'source-url');
  if (isHistory) details.append(create('p', 'source-label', '来源网页'), origin, originUrl);
  node.append(heading, path, metadata, details);

  function update(next: CaptureItem | HistoryItem): void {
    item = next; name.textContent = resourceName(item.url); name.title = name.textContent;
    host.textContent = item.hostname;
    if ('pageUrl' in item) {
      path.textContent = `来源：${sourceName(item)}`; path.title = item.pageUrl;
      origin.textContent = item.pageTitle || '来源未记录'; originUrl.textContent = item.pageUrl;
    } else { path.textContent = shortPath(item.url); path.title = item.url; }
    fullUrl.textContent = item.url;
    copyButton.setAttribute('aria-label', `复制 ${name.textContent} 的完整地址`);
    requests.textContent = `捕获 ${item.requestCount} 次`;
    const last = new Date(item.lastSeen);
    requests.title = `最近捕获 ${last.toLocaleString('zh-CN', { hour12: false })}`;
    date.textContent = last.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    date.dateTime = last.toISOString();
    date.title = `首次捕获：${new Date(item.firstSeen).toLocaleString('zh-CN')}\n最近捕获：${last.toLocaleString('zh-CN')}`;
    type.title = item.detectedBy.includes('content-type') ? '包含 HLS 响应类型识别' : '根据地址后缀识别';
    const category = classifyCapture(item);
    node.dataset.status = category;
    status.dataset.status = category;
    status.classList.toggle('is-warning', category === 'abnormal');
    status.textContent = item.error?.trim() ? '网络失败' : category === 'pending' ? '待确认' : `HTTP ${item.statusCode}`;
    status.title = item.error || '请求状态仅供参考，不代表资源一定可播放';
  }
  update(item); return { node, update };
}

function renderItems(items: Array<CaptureItem | HistoryItem>): void {
  const present = new Set(items.map((item) => item.id));
  for (const [id, card] of cards) if (!present.has(id)) { card.node.remove(); cards.delete(id); }
  items.forEach((item, index) => {
    let card = cards.get(item.id);
    if (!card) { card = makeCard(item); cards.set(item.id, card); } else card.update(item);
    if (ui.list.children[index] !== card.node) ui.list.insertBefore(card.node, ui.list.children[index] ?? null);
  });
}

function setMonitor(state: 'loading' | 'listening' | 'unsupported' | 'error' | 'history'): void {
  ui.monitor.dataset.state = state;
  ui.monitorLabel.textContent = { loading: '正在连接', listening: '监听中', unsupported: '无法监听', error: '连接异常', history: '本地历史' }[state];
}

function setView(state: 'loading' | 'list' | 'empty' | 'error'): void {
  ui.loading.hidden = state !== 'loading'; ui.list.hidden = state !== 'list';
  ui.empty.hidden = state !== 'empty'; ui.error.hidden = state !== 'error';
  ui.panel.setAttribute('aria-busy', String(state === 'loading')); ui.limit.hidden = true;
}

function updateActions(): void {
  if (view === 'current') {
    const count = filteredCurrentItems().length;
    ui.copyAll.disabled = copying || currentPhase !== 'ready' || count === 0;
    ui.copyAllLabel.textContent = copying ? '正在复制…' : count ? `复制全部${statusFilter === 'all' ? '地址' : STATUS_NAMES[statusFilter]}（${count}）` : `复制${STATUS_NAMES[statusFilter]}地址`;
  } else {
    const count = historyPage?.matched ?? 0;
    ui.copyAll.disabled = copying || searchPending || historyPhase !== 'ready' || count === 0;
    const label = statusFilter === 'all' ? historyQuery ? '复制全部匹配' : '复制全部历史' : `复制全部${historyQuery ? '匹配的' : ''}${STATUS_NAMES[statusFilter]}`;
    ui.copyAllLabel.textContent = copying ? '正在读取并复制…' : count ? `${label}（${count}）` : label;
  }
  ui.export.disabled = exporting || historyTotal === 0 || historyPhase === 'error';
  ui.exportLabel.textContent = exporting ? '导出中…' : '导出备份';
  ui.previous.disabled = historyOffset === 0 || historyPhase !== 'ready' || searchPending;
  ui.next.disabled = historyOffset + PAGE_SIZE >= (historyPage?.matched ?? 0) || historyPhase !== 'ready' || searchPending;
}

function renderCurrent(): void {
  if (view !== 'current') return;
  const visibleItems = filteredCurrentItems();
  const counts = countCaptureStatuses(currentItems);
  renderStatusControls(counts);
  ui.heading.textContent = `${STATUS_NAMES[statusFilter]}地址`; ui.count.textContent = String(visibleItems.length); ui.pagination.hidden = true;
  ui.footer.textContent = '地址自动存入本机历史，不自动删除';
  if (currentPhase === 'loading') { setMonitor('loading'); setView('loading'); }
  else if (currentPhase === 'error') { setMonitor('error'); ui.errorMessage.textContent = currentError; setView('error'); }
  else if (currentPhase === 'unsupported') {
    setMonitor('unsupported'); ui.caption.textContent = '也可切换到全部历史';
    ui.emptyTitle.textContent = '这个页面无法捕获资源';
    ui.emptyDescription.textContent = '请在普通视频网页使用，并允许插件访问该网站。';
    ui.emptyHint.textContent = '已保存的记录，可在“全部历史”查看'; setView('empty');
  } else {
    setMonitor('listening'); ui.caption.textContent = `共 ${currentItems.length} 条 · 实时分类`;
    ui.emptyTitle.textContent = statusFilter === 'all' ? '等待发现 m3u8 资源' : `暂时没有${STATUS_NAMES[statusFilter]}地址`;
    ui.emptyDescription.textContent = counts.all ? '可以切换上方类别，查看已捕获地址的实际请求结果。' : '播放网页中的视频后会自动分类，尚无响应的地址在“待确认”中。';
    ui.emptyHint.textContent = '所有类别都会存入历史，不会自动删除';
    renderItems(visibleItems); setView(visibleItems.length ? 'list' : 'empty'); ui.limit.hidden = !currentCapture?.limitReached;
  }
  updateActions();
}

function renderCapture(capture: TabCapture): void {
  if (capture.tabId !== activeTabId || (currentCapture && capture.updatedAt < currentCapture.updatedAt)) return;
  currentCapture = capture;
  currentItems = [...capture.items].sort((a, b) => b.firstSeen - a.firstSeen || a.id.localeCompare(b.id));
  currentPhase = 'ready'; renderCurrent();
}

function updatePageContext(tab: chrome.tabs.Tab): void {
  ui.title.textContent = tab.title || '当前网页'; ui.title.title = tab.title || tab.url || '当前网页';
  try { ui.domain.textContent = new URL(tab.url || '').host || tab.url || '—'; }
  catch { ui.domain.textContent = tab.url || '—'; }
}

async function loadActiveTab(): Promise<void> {
  const sequence = ++loadSequence;
  currentCapture = undefined; currentItems = []; activeTabId = undefined; currentPhase = 'loading'; renderCurrent();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (sequence !== loadSequence) return;
    if (!tab || tab.id === undefined) throw new Error('没有找到当前标签页，请关闭弹窗后重新打开。');
    updatePageContext(tab);
    if (!/^https?:\/\//i.test(tab.url || '')) { currentPhase = 'unsupported'; renderCurrent(); return; }
    activeTabId = tab.id;
    const response: CaptureResponse = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE', tabId: tab.id });
    if (sequence !== loadSequence) return;
    if (!response || !response.ok) throw new Error(response?.error || '后台暂未响应，请重试。');
    renderCapture(response.capture);
  } catch (error) {
    if (sequence !== loadSequence) return;
    currentPhase = 'error'; currentError = error instanceof Error ? error.message : '请关闭弹窗后重新打开。'; renderCurrent();
  }
}

function renderHistory(): void {
  if (view !== 'history') return;
  renderStatusControls(historyPhase === 'loading' ? undefined : historyPage?.counts);
  setMonitor('history'); ui.heading.textContent = historyQuery ? `${STATUS_NAMES[statusFilter]}搜索结果` : `${STATUS_NAMES[statusFilter]}历史`;
  ui.count.textContent = String(historyPage?.matched ?? 0);
  ui.caption.textContent = historyQuery ? `共 ${historyTotal} 条历史` : '按最近捕获排序';
  ui.footer.textContent = '复制仅含所选类别；备份包含所有历史';
  ui.pagination.hidden = true;
  if (historyPhase === 'loading') setView('loading');
  else if (historyPhase === 'error') { ui.errorMessage.textContent = historyError; setView('error'); }
  else {
    const items = historyPage?.items ?? [];
    ui.emptyTitle.textContent = historyQuery ? `没有匹配的${statusFilter === 'all' ? '' : STATUS_NAMES[statusFilter]}地址` : historyTotal ? `暂时没有${STATUS_NAMES[statusFilter]}历史` : '这里会留住每次发现';
    ui.emptyDescription.textContent = historyTotal ? '可以尝试其它关键词，或切换上方的状态分类。' : '播放网页中的视频，抓到的地址会自动分类并保存到这里。';
    ui.emptyHint.textContent = historyTotal ? '筛选不会删除已保存的记录' : '刷新、关闭标签页或重启浏览器后仍可查看';
    renderItems(items); setView(items.length ? 'list' : 'empty');
    if ((historyPage?.matched ?? 0) > 0) {
      ui.pagination.hidden = false;
      ui.pageInfo.textContent = `${historyOffset + 1}–${historyOffset + items.length} / ${historyPage!.matched} 条`;
    }
  }
  updateActions();
}

async function loadHistory(silent = false): Promise<void> {
  const sequence = ++historySequence;
  historyReads += 1;
  if (!silent || !historyPage) historyPhase = 'loading';
  searchPending = true; renderHistory();
  try {
    const result = await getHistoryPage({ query: historyQuery, offset: historyOffset, limit: PAGE_SIZE, status: statusFilter });
    if (sequence !== historySequence) return;
    historyTotal = result.total; ui.historyTotal.textContent = result.total.toLocaleString('zh-CN');
    if (historyOffset >= result.matched && historyOffset > 0) {
      historyOffset = result.matched ? Math.floor((result.matched - 1) / PAGE_SIZE) * PAGE_SIZE : 0;
      await loadHistory(); return;
    }
    historyPage = result; historyPhase = 'ready'; searchPending = false; renderHistory(); updateActions();
  } catch (error) {
    if (sequence !== historySequence) return;
    historyPhase = 'error'; searchPending = false;
    historyError = error instanceof Error ? error.message : '本地历史暂时不可读取，请重试。'; renderHistory(); updateActions();
  } finally {
    historyReads -= 1;
    if (historyReads === 0 && historyNeedsRefresh) {
      historyNeedsRefresh = false;
      scheduleHistoryRefresh();
    }
  }
}

function scheduleHistoryRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    if (historyReads > 0 || searchTimer) { historyNeedsRefresh = true; return; }
    void loadHistory(true);
  }, 200);
}

function changeView(next: View): void {
  if (next === view) return;
  view = next; cards.clear(); ui.list.replaceChildren(); ui.list.scrollTop = 0;
  ui.currentTab.classList.toggle('is-active', next === 'current'); ui.historyTab.classList.toggle('is-active', next === 'history');
  ui.currentTab.setAttribute('aria-selected', String(next === 'current')); ui.historyTab.setAttribute('aria-selected', String(next === 'history'));
  ui.currentTab.tabIndex = next === 'current' ? 0 : -1; ui.historyTab.tabIndex = next === 'history' ? 0 : -1;
  ui.panel.setAttribute('aria-labelledby', next === 'current' ? 'view-current' : 'view-history');
  ui.pageContext.hidden = next !== 'current'; ui.historyContext.hidden = true; ui.historyTools.hidden = next !== 'history';
  ui.panel.classList.toggle('is-history', next === 'history');
  if (next === 'current') renderCurrent(); else { renderHistory(); void loadHistory(true); }
}

function changeStatus(next: StatusFilter): void {
  if (next === statusFilter) return;
  statusFilter = next; historyOffset = 0; historyPhase = 'loading';
  ++historySequence;
  ui.list.scrollTop = 0;
  if (view === 'current') renderCurrent(); else renderHistory();
  void loadHistory();
}

function renderWarning(status: unknown): void {
  const error = status && typeof status === 'object' && 'error' in status ? status.error : null;
  ui.warning.hidden = typeof error !== 'string' || !error;
  ui.warning.textContent = error ? '部分地址未能写入历史。请检查本机存储状态；当前页地址仍可复制。' : '';
  ui.warning.title = typeof error === 'string' ? error : '';
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes['history-revision']) scheduleHistoryRefresh();
    if (changes['history-status']) renderWarning(changes['history-status'].newValue);
  }
  if (areaName !== 'session' || activeTabId === undefined) return;
  const change = changes[`tab:${activeTabId}`];
  if (change) renderCapture((change.newValue as TabCapture | undefined) ?? { tabId: activeTabId, pageUrl: '', items: [], updatedAt: Date.now() });
});
chrome.tabs.onUpdated.addListener((tabId, _change, tab) => { if (tabId === activeTabId) updatePageContext(tab); });
ui.currentTab.addEventListener('click', () => changeView('current'));
ui.historyTab.addEventListener('click', () => changeView('history'));
ui.statusNormal.addEventListener('click', () => changeStatus('normal'));
ui.statusAbnormal.addEventListener('click', () => changeStatus('abnormal'));
ui.statusPending.addEventListener('click', () => changeStatus('pending'));
ui.statusAll.addEventListener('click', () => changeStatus('all'));
for (const tab of [ui.currentTab, ui.historyTab]) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'current' : event.key === 'End' ? 'history' : view === 'current' ? 'history' : 'current';
    changeView(next); (next === 'current' ? ui.currentTab : ui.historyTab).focus();
  });
}
ui.search.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  historyQuery = ui.search.value.trim(); historyOffset = 0; searchPending = true; historyPhase = 'loading';
  ++historySequence; renderHistory();
  searchTimer = setTimeout(() => { searchTimer = undefined; ui.list.scrollTop = 0; void loadHistory(); }, 300);
});
ui.previous.addEventListener('click', () => { historyOffset = Math.max(0, historyOffset - PAGE_SIZE); ui.list.scrollTop = 0; void loadHistory(); });
ui.next.addEventListener('click', () => { historyOffset += PAGE_SIZE; ui.list.scrollTop = 0; void loadHistory(); });
ui.retry.addEventListener('click', () => { if (view === 'history') void loadHistory(); else void loadActiveTab(); });
ui.copyAll.addEventListener('click', () => {
  if (copying) return;
  if (view === 'current') {
    const items = filteredCurrentItems();
    void copyText(items.map((item) => item.url).join('\n'), `已复制 ${items.length} 条${STATUS_NAMES[statusFilter]}地址`); return;
  }
  copying = true; updateActions(); const query = historyQuery; const selectedStatus = statusFilter;
  void getHistoryUrls(query, selectedStatus).then((urls) => {
    if (!urls.length) { showToast('没有可复制的历史地址'); return; }
    return copyText(urls.join('\n'), `已复制 ${urls.length} 条${STATUS_NAMES[selectedStatus]}地址（含全部分页）`);
  }).catch(() => showToast('历史地址读取失败，请重新读取后再复制。', true))
    .finally(() => { copying = false; updateActions(); });
});
ui.export.addEventListener('click', () => {
  if (exporting) return;
  exporting = true; updateActions();
  void exportHistory().then((blob) => {
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    const stamp = new Date().toLocaleString('sv-SE').replace(/[^0-9]/g, '');
    anchor.href = url; anchor.download = `m3u8-history-${stamp}.json`;
    anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000); showToast('已生成全部历史备份，请查看浏览器下载');
  }).catch(() => showToast('备份导出失败，已有历史记录未改变。', true))
    .finally(() => { exporting = false; updateActions(); });
});
ui.cancelDelete.addEventListener('click', () => { if (!deleting) ui.deleteDialog.close(); });
ui.deleteDialog.addEventListener('cancel', (event) => { if (deleting) event.preventDefault(); });
ui.deleteDialog.addEventListener('close', () => { deletion = undefined; });
ui.confirmDelete.addEventListener('click', () => {
  if (!deletion || deleting) return;
  deleting = true; ui.confirmDelete.disabled = true; ui.cancelDelete.disabled = true;
  void deleteHistory(deletion.url).then(async () => { ui.deleteDialog.close(); showToast('已删除这条历史'); await loadHistory(true); })
    .catch(() => { ui.deleteError.textContent = '删除失败，请重试。'; ui.deleteError.hidden = false; })
    .finally(() => { deleting = false; ui.confirmDelete.disabled = false; ui.cancelDelete.disabled = false; });
});

void chrome.storage.local.get('history-status').then((stored) => renderWarning(stored['history-status']))
  .catch(() => renderWarning({ error: '无法读取历史保存状态，请重新打开插件。' }));
void loadHistory();
void loadActiveTab();
