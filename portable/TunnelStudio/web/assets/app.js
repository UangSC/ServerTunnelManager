/* ============================================================
   Tunnel Studio · front-end
   No framework, no build step. Talks to the local Shell API.
   ============================================================ */
(() => {
  'use strict';

  /* ------------------------------------------------------------
     Helpers
     ------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const STATUS = {
    offline: { label: '已停止', tone: 'offline' },
    connecting: { label: '连接中', tone: 'connecting' },
    online: { label: '运行中', tone: 'online' },
    closing: { label: '关闭中', tone: 'closing' },
    error: { label: '异常', tone: 'error' },
    occupied: { label: '端口占用', tone: 'occupied' }
  };
  const statusText = (s) => (STATUS[s] || STATUS.offline).label;
  const LEVEL_TEXT = { debug: 'DEBUG', info: 'INFO', success: 'OK', warn: 'WARN', error: 'ERROR' };
  const PROBE_TEXT = { auto: '自动', http: 'HTTP', socks5: 'SOCKS5', tcp: 'TCP', none: '不探测' };

  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
  }
  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }
  function fmtRate(bytesPerSecond) {
    const n = Math.max(0, Number(bytesPerSecond) || 0);
    if (n < 1024) return { value: Math.round(n).toString(), unit: 'B/s' };
    if (n < 1048576) return { value: (n / 1024).toFixed(n < 10240 ? 1 : 0), unit: 'KB/s' };
    return { value: (n / 1048576).toFixed(1), unit: 'MB/s' };
  }
  function timeOf(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function clockOf(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso).getTime();
    if (Number.isNaN(d)) return '';
    const diff = Math.max(0, Date.now() - d) / 1000;
    if (diff < 8) return '刚刚';
    if (diff < 60) return `${Math.floor(diff)} 秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  }
  function latencyClass(ms) {
    if (ms == null) return 'empty';
    if (ms < 80) return 'low';
    if (ms < 180) return 'mid';
    return 'high';
  }

  function sparkPoints(values, w, h, pad = 3) {
    let data = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number);
    if (data.length === 0) data = [0, 0];
    if (data.length === 1) data = [data[0], data[0]];
    const slice = data.slice(-40);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const span = max - min || Math.max(1, max * 0.12);
    return slice.map((v, i) => {
      const x = pad + (i * (w - pad * 2)) / (slice.length - 1);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return [Number(x.toFixed(2)), Number(y.toFixed(2))];
    });
  }
  function linePath(points) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ');
  }
  function areaPath(points, h) {
    if (!points.length) return '';
    return `${linePath(points)} L${points[points.length - 1][0]} ${h} L${points[0][0]} ${h} Z`;
  }

  function highlightShell(source) {
    const keywords = new Set(['if', 'else', 'elseif', 'foreach', 'for', 'while', 'switch', 'function', 'param', 'return', 'try', 'catch', 'finally', 'throw', 'in', 'not', 'and', 'or', 'break', 'continue']);
    const commands = new Set(['ssh', 'ssh-keygen', 'type', 'shell', 'shell.exe', 'wscript.exe', 'Get-Content', 'Add-Content', 'Set-Content', 'Test-Path', 'New-Item', 'Select-String', 'Start-Service', 'Set-Service', 'ssh-add', 'echo', 'mkdir', 'chmod', 'cat', 'sort']);
    let out = '';
    let i = 0;
    let atLineStart = true;
    const push = (cls, text) => { out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text); };
    while (i < source.length) {
      const ch = source[i];
      if (ch === '#') {
        let j = source.indexOf('\n', i);
        if (j === -1) j = source.length;
        push('tok-comment', source.slice(i, j));
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '`' && quote === '"') { j += 2; continue; }
          if (source[j] === quote) {
            if (source[j + 1] === quote) { j += 2; continue; }
            j++;
            break;
          }
          j++;
        }
        push('tok-string', source.slice(i, j));
        i = j;
        atLineStart = false;
        continue;
      }
      if (ch === '$') {
        const match = /^\$[A-Za-z_{][A-Za-z0-9_:.\u4e00-\u9fa5{}]*/.exec(source.slice(i));
        if (match) {
          push('tok-var', match[0]);
          i += match[0].length;
          atLineStart = false;
          continue;
        }
      }
      if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(source[i - 1] || '')) {
        const match = /^\d+(\.\d+)?/.exec(source.slice(i));
        if (match) {
          push('tok-num', match[0]);
          i += match[0].length;
          atLineStart = false;
          continue;
        }
      }
      if (/[A-Za-z_]/.test(ch)) {
        const match = /^[A-Za-z_][A-Za-z0-9_.\-]*/.exec(source.slice(i));
        const word = match ? match[0] : ch;
        const base = word.replace(/\.exe$/i, '');
        if (keywords.has(word)) push('tok-keyword', word);
        else if (commands.has(word) || commands.has(base)) push('tok-cmd', word);
        else if (atLineStart && /^[A-Z][A-Za-z0-9]*(-[A-Z][A-Za-z0-9]*)+$/.test(word)) push('tok-cmd', word);
        else push('', word);
        i += word.length;
        atLineStart = false;
        continue;
      }
      if (ch === '\n') { out += '\n'; i++; atLineStart = true; continue; }
      out += esc(ch);
      if (!/\s/.test(ch)) atLineStart = false;
      i++;
    }
    return out;
  }

  // 复制“纯命令”时只移除 Shell 注释，不触碰字符串里的 #（例如 URL、密码或公钥注释）。
  function stripShellComments(source) {
    const lines = String(source || '').split(/\r?\n/);
    return lines.map((line) => {
      let quote = '';
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '`' && quote === '"') { escaped = true; continue; }
        if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
          if (quote === ch && line[i + 1] === ch) { i++; continue; }
          quote = quote ? '' : ch;
          continue;
        }
        if (ch === '#' && !quote) return line.slice(0, i).trimEnd();
      }
      return line.trimEnd();
    }).filter((line) => line.trim()).join('\n').trim();
  }

  /* ------------------------------------------------------------
     State
     ------------------------------------------------------------ */
  const S = {
    token: '',
    ready: false,
    settings: {},
    servers: [],
    tunnels: [],
    runtime: {},
    metrics: {},
    activity: [],
    env: {},
    autostart: {},
    commands: null,
    simulation: true,
    sshAvailable: false,
    themeTouched: false,
    view: 'overview',
    configSig: '',
    tunnelSig: '',
    serverSig: '',
    online: false,
    pollTimer: null,
    pollBusy: false,
    failCount: 0,
    overviewFilter: 'all',
    tunnelFilter: 'all',
    groupFilter: 'all',
    tunnelSearch: '',
    selection: new Set(),
    expanded: {},
    drawer: { id: null, tab: 'overview', editing: false },
    palette: { open: false, items: [], selected: 0, query: '' },
    logs: { source: 'all', level: 'all', query: '', follow: true, lines: [], lastId: 0, timer: null, loaded: false },
    access: { jobId: null, timer: null, command: null, tab: 'single', lastStatus: '', commandTimer: null, commandRequestSeq: 0, lastJob: null },
    settingsDirty: false,
    testResults: {},
    activityMax: 0,
    version: '',
    numbers: {}
  };

  /* ------------------------------------------------------------
     API
     ------------------------------------------------------------ */
  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  async function api(path, options = {}) {
    const headers = Object.assign({ 'X-Panel-Token': S.token }, options.headers || {});
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body,
      cache: 'no-store'
    });
    let data = null;
    try { data = await response.json(); } catch { /* no json */ }
    if (!response.ok) {
      throw new ApiError((data && data.error) || `请求失败（HTTP ${response.status}）`, response.status);
    }
    return data;
  }

  function setConnection(ok) {
    if (S.online === ok) return;
    S.online = ok;
    const pill = $('#connPill');
    if (pill) pill.classList.toggle('is-offline', !ok);
    const text = $('#connText');
    if (text) text.textContent = ok ? '已连接' : '连接中断';
    if (!ok) {
      const railDot = $('#railLiveDot');
      if (railDot) railDot.style.background = 'var(--red)';
    } else {
      const railDot = $('#railLiveDot');
      if (railDot) railDot.style.background = '';
    }
  }

  /* ------------------------------------------------------------
     Theme
     ------------------------------------------------------------ */
  const THEMES = ['dark', 'light'];
  const ACCENTS = ['violet', 'ocean', 'emerald', 'amber', 'rose'];

  function applyTheme(theme, persist = true) {
    const next = THEMES.includes(theme) ? theme : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    if (persist) localStorage.setItem('ts-theme', next);
    $$('#themeSegment button').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.themeValue === next));
  }
  function applyAccent(accent, persist = true) {
    const next = ACCENTS.includes(accent) ? accent : 'violet';
    document.documentElement.dataset.accent = next;
    if (persist) localStorage.setItem('ts-accent', next);
    $$('#accentRow .accent-dot').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.accentValue === next));
  }
  function initTheme() {
    const params = new URLSearchParams(location.search);
    const themeParam = params.get('theme');
    const accentParam = params.get('accent');
    S.forcedTheme = themeParam && THEMES.includes(themeParam) ? themeParam : '';
    const theme = S.forcedTheme || localStorage.getItem('ts-theme') || 'dark';
    const accent = accentParam && ACCENTS.includes(accentParam) ? accentParam : (localStorage.getItem('ts-accent') || 'violet');
    applyTheme(theme, false);
    applyAccent(accent, false);
  }
  function syncThemeToServer() {
    if (!S.ready) return;
    api('/api/settings', {
      method: 'POST',
      body: { theme: document.documentElement.dataset.theme, accent: document.documentElement.dataset.accent }
    }).then((res) => {
      if (res && res.settings) {
        S.settings.theme = res.settings.theme;
        S.settings.accent = res.settings.accent;
      }
    }).catch(() => {});
  }

  /* ------------------------------------------------------------
     Boot
     ------------------------------------------------------------ */
  async function boot() {
    initTheme();
    bindEvents();
    startClock();
    const meta = $('meta[name="panel-token"]');
    S.token = meta ? meta.content : '';
    const version = $('meta[name="app-version"]')?.content || '';
    if (version && version !== '__APP_VERSION__') {
      $('#versionLabel').textContent = `v${version}`;
      $('#aboutVersion').textContent = `v${version}`;
    }
    if (!S.token || S.token === '__PANEL_TOKEN__') {
      showBootError('页面令牌缺失，请刷新控制面板。');
      return;
    }
    try {
      const data = await api('/api/bootstrap');
      hydrateBoot(data, true);
      S.ready = true;
      setConnection(true);
      renderAll();
      handleRoute(true);
      startPolling();
      startLogsPolling();
    } catch (error) {
      showBootError(error.message);
      setTimeout(boot, 3500);
    }
  }

  function showBootError(message) {
    setConnection(false);
    const hero = $('#heroSub');
    if (hero) hero.textContent = '无法连接到本地面板服务，请确认后台正在运行。';
    const grid = $('#tunnelGrid');
    if (grid && grid.querySelector('.skeleton-card')) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="empty-orb">${icon('alert')}</div>
        <h3>面板服务未就绪</h3>
        <p>${esc(message)}<br>请重新运行 bin/start.sh，然后刷新此页面。</p>
        <button class="btn btn-soft" data-action="reload">${icon('refresh')}重新加载</button>
      </div>`;
    }
    const text = $('#connText');
    if (text) text.textContent = '连接中断';
  }

  function hydrateBoot(data, initial = false) {
    S.token = data.token || S.token;
    S.version = data.version || S.version;
    S.settings = data.settings || {};
    S.servers = data.servers || [];
    S.tunnels = data.tunnels || [];
    S.runtime = data.runtime || {};
    S.metrics = data.metrics || {};
    S.activity = data.activity || [];
    S.env = data.env || {};
    S.autostart = data.autostart || {};
    S.commands = data.commands || null;
    S.simulation = !!(data.env && data.env.demo);
    S.sshAvailable = !!(data.env && data.env.sshAvailable);
    if (!S.themeTouched) {
      if (!S.forcedTheme && !localStorage.getItem('ts-theme') && S.settings.theme) applyTheme(S.settings.theme, false);
      if (!localStorage.getItem('ts-accent') && S.settings.accent) applyAccent(S.settings.accent, false);
      S.themeTouched = true;
    }
    if (initial && S.activity.length) {
      S.activityMax = Math.max(0, ...S.activity.map((a) => Number(a.id) || 0));
    }
  }

  async function reloadBootstrap(preserve = true) {
    const data = await api('/api/bootstrap');
    const view = S.view;
    hydrateBoot(data, false);
    for (const id of Array.from(S.selection)) {
      if (!S.tunnels.some((t) => t.id === id)) S.selection.delete(id);
    }
    renderAll();
    if (preserve) setView(view, { silent: true });
    return data;
  }

  /* ------------------------------------------------------------
     Render — shell
     ------------------------------------------------------------ */
  const VIEW_META = {
    overview: { title: '总览', crumb: '总览' },
    tunnels: { title: '隧道', crumb: '隧道' },
    dedicated: { title: '专用隧道', crumb: '专用隧道' },
    servers: { title: '服务器', crumb: '服务器' },
    logs: { title: '运行日志', crumb: '运行日志' },
    access: { title: '免密登录', crumb: '免密登录' },
    settings: { title: '设置', crumb: '设置' }
  };

  function renderAll() {
    renderShell();
    renderOverview();
    renderTunnelGrid();
    renderTunnelsTable();
    renderServerGrid();
    renderServerMini();
    renderNav();
    renderSettings();
    renderAccessDefaults();
    renderAccessSteps(S.access.lastJob || null);
    renderLogSources();
    renderModeBadge();
    updateLive(true);
    updateClock();
  }

  function renderShell() {
    const version = S.version || (S.env && S.env.version) || '';
    if (version) {
      $('#aboutVersion').textContent = `v${version}`;
      $('#versionLabel').textContent = `v${version}`;
    }
    const connector = S.env ? `${S.env.runtime || 'Node.js'} · ${S.env.platform || ''}` : '—';
    $('#aboutEnv').textContent = connector;
    const configPath = $('#configPathLabel');
    if (configPath) configPath.textContent = (S.env && S.env.dataPath) || '—';
  }

  function renderNav() {
    const online = (S.tunnels || []).filter((t) => (S.runtime[t.id] || {}).status === 'online').length;
    $('#navOnlineBadge').textContent = online;
    $('#navTunnelCount').textContent = S.tunnels.filter(t => t.kind !== 'dedicated').length;
    $('#navDedicatedCount').textContent = S.tunnels.filter(t => t.kind === 'dedicated').length;
    $('#navServerCount').textContent = S.servers.length;
    const first = S.servers[0];
    if (first) {
      $('#railServerName').textContent = first.name;
      $('#railServerHost').textContent = `${first.user}@${first.host}:${first.port}`;
      const count = S.tunnels.filter((t) => t.serverId === first.id).length;
      $('#railServerMeta').textContent = `${count} 条隧道 · ${first.status === 'online' ? '运行中' : '待命'}`;
    } else {
      $('#railServerName').textContent = '尚未添加服务器';
      $('#railServerHost').textContent = '去「服务器」页添加';
      $('#railServerMeta').textContent = '—';
    }
  }

  function renderModeBadge() {
    const isDemo = !!S.simulation;
    const badge = $('#modeBadge');
    if (badge) {
      badge.dataset.mode = isDemo ? 'demo' : 'live';
      const text = $('#modeBadgeText');
      if (text) text.textContent = isDemo ? '演示模式' : '真实模式';
      badge.title = isDemo ? '当前不会启动真实 SSH 进程' : '隧道操作会调用本机 ssh';
    }
    const accessBadge = $('#accessModeBadge');
    if (accessBadge) {
      accessBadge.dataset.mode = isDemo ? 'demo' : 'live';
      const span = accessBadge.querySelector('span:last-child');
      if (span) span.textContent = isDemo ? '演示模式' : '真实模式';
    }
    const hint = $('#accessPasswordHint');
    if (hint) hint.textContent = isDemo ? '演示模式可留空' : '真实模式必填';
    const footer = $('#modeNote');
    if (footer) {
      const span = footer.querySelector('span');
      if (span) span.textContent = isDemo
        ? '演示模式只模拟状态流转和延迟，不采集真实流量，不会启动任何 SSH 进程。'
        : '真实模式会调用本机 ssh。请确认密钥与服务器指纹已配置，避免误杀其他 SSH 会话。';
    }
  }

  /* ------------------------------------------------------------
     Render — overview
     ------------------------------------------------------------ */
  function renderOverview() {
    const total = S.tunnels.length;
    const online = (S.tunnels || []).filter((t) => (S.runtime[t.id] || {}).status === 'online').length;
    const connecting = (S.tunnels || []).filter((t) => (S.runtime[t.id] || {}).status === 'connecting').length;
    const servers = S.servers.length;
    $('#heroSub').innerHTML = total
      ? `${total} 条端口映射 · ${servers} 台服务器 · <strong style="color:var(--text-2);font-weight:600">${online}</strong> 条在线${connecting ? ` · ${connecting} 条正在连接` : ''}`
      : '还没有隧道映射。先添加服务器，再创建第一条端口转发。';
    const badges = [];
    if (S.settings.autoReconnect) badges.push(`<span class="pill pill-green">自动重连</span>`);
    if (S.settings.simulation) badges.push(`<span class="pill pill-amber">模拟运行</span>`);
    else badges.push(`<span class="pill pill-accent">真实 SSH</span>`);
    if (S.sshAvailable) badges.push(`<span class="pill pill-muted">OpenSSH 就绪</span>`);
    else badges.push(`<span class="pill pill-red">未找到 ssh</span>`);
    $('#heroBadges').innerHTML = badges.join('');
    $('#overviewCount').textContent = S.tunnels.filter(t => t.kind !== 'dedicated').length;
    $('#dedicatedOverviewCount').textContent = S.tunnels.filter(t => t.kind === 'dedicated').length;
    renderActivity();
  }

  function renderActivity(force = false) {
    const list = $('#activityList');
    if (!list) return;
    const items = S.activity || [];
    const maxId = items.length ? Math.max(...items.map((a) => Number(a.id) || 0)) : 0;
    if (!force && maxId === S.activityMax) return;
    S.activityMax = maxId;
    const empty = $('#activityEmpty');
    if (!items.length) {
      list.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = items.slice(0, 30).map((item) => {
      const kind = ['success', 'warning', 'error', 'info'].includes(item.kind) ? item.kind : 'info';
      const iconName = kind === 'success' ? 'check' : kind === 'warning' ? 'alert' : kind === 'error' ? 'x' : 'info';
      return `<div class="activity-item">
        <span class="activity-mark ${kind}">${icon(iconName)}</span>
        <div class="activity-body">
          <div class="activity-title"><span>${esc(item.title)}</span><time datetime="${esc(item.ts)}">${relTime(item.ts)}</time></div>
          <div class="activity-detail">${esc(item.detail)}</div>
        </div>
      </div>`;
    }).join('');
  }

  function renderTunnelGrid() {
    const grid = $('#tunnelGrid');
    if (!grid) return;
    for (const id of ['tunnelGrid', 'dedicatedOverviewGrid', 'dedicatedGrid']) {
      const target = $('#' + id);
      const dedicated = id !== 'tunnelGrid';
      const list = target.dataset.layout === 'list';
      const items = S.tunnels.filter(t => (t.kind === 'dedicated') === dedicated);
      const rows = items.map(t => tunnelCard(t, list)).join('');
      const add = `<button class="tunnel-add" data-action="${dedicated ? 'new-dedicated' : 'new-tunnel'}" aria-label="${dedicated ? '新建专用隧道' : '新建隧道'}"><span class="add-circle">${icon('plus')}</span><span>${dedicated ? '新建专用隧道' : '新建端口映射'}</span><small>${dedicated ? '账号 → 固定代理入口' : '本机端口 → 服务器端口'}</small></button>`;
      target.innerHTML = list ? `<div class="wb-scroll-hint">左右滑动查看完整列表</div><div class="wb-list-table">${TunnelWorkbench.listHeader(dedicated)}${rows}${add}</div>` : rows + add;
    }
    applyOverviewFilter();
  }

  function tunnelCard(t, list = false) {
    const state = S.runtime[t.id] || {};
    const status = state.status || 'offline';
    const server = t.server || S.servers.find((x) => x.id === t.serverId) || {};
    if (list) return TunnelWorkbench.row(t, {state, server, statusLabel: statusText(status), icon});
    const online = status === 'online';
    const active = online || status === 'connecting' || (status === 'error' && state.pid != null);
    const latency = state.latency != null ? `${state.latency} ms` : (online ? '探测中' : '—');
    const uptime = online ? fmtDuration(state.uptimeSec) : '—';
    const pid = state.pid != null ? String(state.pid) : '—';
    const spark = state.latencyHistory && state.latencyHistory.length ? state.latencyHistory : [0, 0];
    const points = sparkPoints(spark, 92, 26, 2);
    const error = esc(state.error || (state.probeError ? '远端探测：' + state.probeError : ''));
    const url = t.url || '';
    return `<article class="tunnel-card" data-kind="${t.kind === 'dedicated' ? 'dedicated' : 'standard'}" data-id="${esc(t.id)}" data-status="${status}" tabindex="0" aria-label="${esc(t.name)}">
      <div class="tc-head">
        <div class="tc-titlewrap">
          <div class="tc-title"><span class="status-dot"></span><h3>${esc(t.name)}</h3></div>
          <div class="tc-sub">
            ${t.group ? `<span class="tc-group">${esc(t.group)}</span>` : ''}
            <span class="status-label" data-status="${status}" data-live="status">${statusText(status)}</span>
            <span>·</span>
            <span class="truncate">${esc(server.user || 'root')}@${esc(server.host || '—')}</span>
          </div>
        </div>
        <div class="tc-actions">
          <button class="icon-btn" data-act="logs" title="查看日志" aria-label="查看日志">${icon('terminal')}</button>
          <label class="switch" data-act="toggle" title="${active ? '关闭隧道' : '开启隧道'}">
            <input type="checkbox" data-role="toggle" ${active ? 'checked' : ''}>
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
      </div>
      ${TunnelWorkbench.summary(t)}
      <div class="tc-route">
        <div class="endpoint">
          <span class="endpoint-label">LOCAL</span>
          <span class="endpoint-value" title="${esc(t.localHost)}:${t.localPort}"><b>${esc(t.localHost)}</b>:${t.localPort}</span>
        </div>
        <div class="flow" aria-hidden="true" title="链路方向：本机 → 远端；流动表示连接在线" data-online="${online}">
          <span class="flow-track"><span class="flow-rail"></span>
          <span class="packet"></span><span class="packet p2"></span><span class="packet p3"></span></span>
          <span class="flow-arrow"><svg class="icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M0 6h9M5 2l4 4-4 4"/></svg></span>
        </div>
        <div class="endpoint remote">
          <span class="endpoint-label">REMOTE</span>
          <span class="endpoint-value" title="经 ${esc(server.host || '')} → ${esc(t.remoteHost || '127.0.0.1')}:${t.remotePort}">${esc(t.remoteHost || '127.0.0.1')}:${t.remotePort}</span>
        </div>
      </div>
      <div class="tc-meta">
        <span>PID <b data-live="pid">${pid}</b></span><span>·</span>
        <span>延迟 <b data-live="latency">${latency}</b></span><span>·</span>
        <span>在线 <span data-live="uptime">${uptime}</span></span>
        <span>·</span>
        <span>${PROBE_TEXT[t.effectiveProbe] || '自动'}</span>
      </div>
      <div class="tc-error" data-live="error" ${error ? '' : 'hidden'}>${error}</div>
      <div class="tc-foot">
        <svg class="tc-spark" viewBox="0 0 92 26" preserveAspectRatio="none" aria-hidden="true">
          <path class="spark-area" d="${areaPath(points, 26)}" fill="currentColor" opacity=".1"/>
          <path class="spark-line" data-live="spark" d="${linePath(points)}"/>
        </svg>
        <div class="tc-quick">
          ${url ? `<button class="quick-btn accent" data-act="open-url">${icon('external')}打开</button>` : ''}
          ${url ? `<button class="quick-btn" data-act="connection" title="查看连接信息与后端地址" aria-label="连接信息">${icon('info')}</button>` : ''}
          <button class="quick-btn" data-act="port" title="端口诊断：查看占用进程" aria-label="端口诊断" ${status === 'occupied' ? '' : 'hidden'}>${icon('search')}</button>
          <button class="quick-btn" data-act="copy">${icon('copy')}${t.kind === 'dedicated' ? '代理地址' : '复制'}</button>
          <button class="quick-btn" data-act="menu">${icon('more')}更多</button>
        </div>
      </div>
    </article>`;
  }

  function applyOverviewFilter() {
    const filter = S.overviewFilter;
    $$('#tunnelGrid .tunnel-card').forEach((card) => {
      const status = card.dataset.status;
      const match = filter === 'all'
        || (filter === 'online' && (status === 'online' || status === 'connecting'))
        || (filter === 'offline' && (status === 'offline' || status === 'closing'))
        || (filter === 'error' && (status === 'error' || status === 'occupied'));
      card.hidden = !match;
    });
    $$('#overviewFilterChips .chip').forEach((chip) => chip.classList.toggle('is-active', chip.dataset.filterStatus === filter));
  }

  function renderServerMini() {
    const list = $('#serverMiniList');
    if (!list) return;
    if (!S.servers.length) {
      list.innerHTML = `<div class="empty-inline">${icon('server')}<span>还没有服务器，去添加一台。</span></div>`;
      return;
    }
    list.innerHTML = S.servers.map((s) => {
      const status = s.status || 'idle';
      const label = status === 'online' ? '运行中' : status === 'connecting' ? '连接中' : '待命';
      return `<button class="server-mini" data-action="open-server" data-server-id="${esc(s.id)}">
        <span class="server-orb" data-color="${esc(s.color)}">${icon('server')}</span>
        <span class="server-mini-body"><strong>${esc(s.name)}</strong><span>${esc(s.user)}@${esc(s.host)}:${s.port}</span></span>
        <span class="server-mini-meta"><b>${s.onlineCount || 0}/${s.tunnelCount || 0}</b><span>${label}</span></span>
      </button>`;
    }).join('');
  }

  /* ------------------------------------------------------------
     Render — tunnels page
     ------------------------------------------------------------ */
  function renderTunnelsTable() {
    const body = $('#tunnelTableBody');
    if (!body) return;
    if (!S.tunnels.length) {
      body.innerHTML = '';
      $('#tunnelTableEmpty').hidden = false;
      renderTunnelMobileList();
      renderGroupFilter();
      return;
    }
    $('#tunnelTableEmpty').hidden = true;
    body.innerHTML = S.tunnels.map((t) => {
      const state = S.runtime[t.id] || {};
      const status = state.status || 'offline';
      const server = t.server || S.servers.find((x) => x.id === t.serverId) || {};
      const latency = state.latency;
      return `<div class="tunnel-table t-row" data-row-id="${esc(t.id)}" data-status="${status}" data-group="${esc(t.group || '')}" tabindex="0">
        <label class="checkline" data-no-open>
          <input type="checkbox" data-select="${esc(t.id)}" ${S.selection.has(t.id) ? 'checked' : ''} aria-label="选择 ${esc(t.name)}">
        </label>
        <div class="t-name">
          <span class="status-dot"></span>
          <div class="t-name-body">
            <strong>${esc(t.name)}</strong>
            <small>${t.group ? esc(t.group) : '默认分组'}${t.note ? ` · ${esc(t.note)}` : ''}</small>
          </div>
        </div>
        <div class="t-route">
          <div>${esc(t.localHost)}:${t.localPort} <span class="arrow">→</span> ${esc(t.remoteHost)}:${t.remotePort}</div>
          <small>${PROBE_TEXT[t.effectiveProbe] || '自动'} 探测 · ${t.autoOpen ? '随面板启动' : '手动启动'}</small>
        </div>
        <div class="t-server"><span>${esc(server.name || '—')}</span><small>${esc(server.user || '')}@${esc(server.host || '')}</small></div>
        <div class="t-latency ${latencyClass(latency)}" data-live="latency">${latency != null ? latency + ' ms' : '—'}</div>
        <div><span class="status-label" data-status="${status}" data-live="status">${statusText(status)}</span></div>
        <div class="t-actions">
          <label class="switch" data-act="toggle" title="${status === 'online' || status === 'connecting' || (status === 'error' && state.pid != null) ? '关闭隧道' : '开启隧道'}">
            <input type="checkbox" data-role="toggle" ${status === 'online' || status === 'connecting' || (status === 'error' && state.pid != null) ? 'checked' : ''}>
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
          <button class="icon-btn" data-act="logs" title="日志">${icon('terminal')}</button>
          <button class="icon-btn" data-act="edit" title="编辑">${icon('edit')}</button>
        </div>
      </div>`;
    }).join('');
    renderTunnelMobileList();
    renderGroupFilter();
    applyTunnelFilter();
    renderBatchBar();
    syncSelectAll();
  }

  function renderTunnelMobileList() {
    let holder = $('#tunnelMobileList');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'tunnelMobileList';
      holder.className = 'tunnel-grid mobile-tunnel-list';
      const tableCard = $('.table-card');
      if (tableCard && tableCard.parentNode) tableCard.parentNode.insertBefore(holder, tableCard.nextSibling);
    }
    holder.innerHTML = S.tunnels.map((t) => tunnelCard(t)).join('');
    if (!holder._bound) {
      holder.addEventListener('click', handleTunnelCardClick);
      holder.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('tunnel-card')) {
          event.preventDefault();
          openDrawer(event.target.dataset.id);
        }
      });
      holder._bound = true;
    }
    applyTunnelFilter();
  }

  function renderGroupFilter() {
    const select = $('#groupFilter');
    if (!select) return;
    const groups = Array.from(new Set(S.tunnels.map((t) => t.group || '').filter(Boolean))).sort();
    const current = S.groupFilter;
    select.innerHTML = `<option value="all">全部分组</option>` + groups.map((g) => `<option value="${esc(g)}" ${current === g ? 'selected' : ''}>${esc(g)}</option>`).join('');
    if (current !== 'all' && !groups.includes(current)) {
      S.groupFilter = 'all';
      select.value = 'all';
    }
  }

  function tunnelMatches(t) {
    if (t.kind === 'dedicated') return false;
    const state = S.runtime[t.id] || {};
    const status = state.status || 'offline';
    const filter = S.tunnelFilter;
    const statusMatch = filter === 'all'
      || (filter === 'online' && (status === 'online' || status === 'connecting'))
      || (filter === 'offline' && (status === 'offline' || status === 'closing'))
      || (filter === 'error' && (status === 'error' || status === 'occupied'));
    if (!statusMatch) return false;
    if (S.groupFilter !== 'all' && (t.group || '') !== S.groupFilter) return false;
    const q = S.tunnelSearch.trim().toLowerCase();
    if (!q) return true;
    const server = t.server || {};
    const haystack = [t.name, t.group, t.note, t.localPort, t.remotePort, t.localHost, t.remoteHost, server.name, server.host]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function applyTunnelFilter() {
    $$('#tunnelTableBody .t-row').forEach((row) => {
      const t = S.tunnels.find((x) => x.id === row.dataset.rowId);
      row.hidden = !t || !tunnelMatches(t);
    });
    $$('#tunnelMobileList .tunnel-card').forEach((card) => {
      const t = S.tunnels.find((x) => x.id === card.dataset.id);
      card.hidden = !t || !tunnelMatches(t);
    });
    $$('#statusFilter .chip').forEach((chip) => chip.classList.toggle('is-active', chip.dataset.filterStatus === S.tunnelFilter));
    const visible = S.tunnels.filter(tunnelMatches).length;
    const empty = $('#tunnelTableEmpty');
    if (empty) empty.hidden = !(S.tunnels.length > 0 && visible === 0);
    const mobileEmpty = $('#tunnelMobileEmpty');
    if (mobileEmpty) mobileEmpty.hidden = !(S.tunnels.length > 0 && visible === 0);
    syncSelectAll();
  }

  function renderBatchBar() {
    const bar = $('#batchBar');
    if (!bar) return;
    bar.hidden = S.selection.size === 0;
    $('#batchCount').textContent = S.selection.size;
    $$('#tunnelTableBody [data-select]').forEach((cb) => { cb.checked = S.selection.has(cb.dataset.select); });
    $$('#tunnelTableBody .t-row').forEach((row) => row.classList.toggle('is-selected', S.selection.has(row.dataset.rowId)));
    syncSelectAll();
  }

  function syncSelectAll() {
    const all = $('#selectAllTunnels');
    if (!all) return;
    const visible = S.tunnels.filter(tunnelMatches);
    const selected = visible.filter((t) => S.selection.has(t.id)).length;
    all.checked = visible.length > 0 && selected === visible.length;
    all.indeterminate = selected > 0 && selected < visible.length;
  }

  /* ------------------------------------------------------------
     Render — servers
     ------------------------------------------------------------ */
  function renderServerGrid() {
    const grid = $('#serverGrid');
    if (!grid) return;
    if (!S.servers.length) {
      grid.innerHTML = '';
      $('#serverEmpty').hidden = false;
      return;
    }
    $('#serverEmpty').hidden = true;
    grid.innerHTML = S.servers.map((s) => {
      const status = s.status || 'idle';
      const statusLabel = status === 'online' ? '运行中' : status === 'connecting' ? '连接中' : '待命';
      const test = S.testResults[s.id];
      const testHtml = test ? `<span class="test-result ${test.ok ? 'ok' : 'bad'}" data-live="test">${test.ok ? `${test.ms} ms` : '不可达'}</span>` : `<span class="test-result" data-live="test"></span>`;
      return `<article class="server-card" data-server-id="${esc(s.id)}">
        <div class="server-card-head">
          <span class="server-orb" data-color="${esc(s.color)}">${icon('server')}</span>
          <div class="server-card-title">
            <h3>${esc(s.name)}</h3>
            <span>${esc(s.user)}@${esc(s.host)}:${s.port}</span>
          </div>
          <span class="server-status ${status}" data-live="server-status"><span class="status-dot"></span>${statusLabel}</span>
        </div>
        <div class="server-meta">
          <div class="meta-box"><span>隧道</span><strong>${s.tunnelCount || 0}</strong></div>
          <div class="meta-box"><span>在线</span><strong>${s.onlineCount || 0}</strong></div>
        </div>
        <div class="server-keys">
          <span class="key-dot ${s.hasKey ? '' : 'missing'}"></span>
          <span>${s.hasKey ? '密钥就绪' : '密钥缺失'}</span>
          <code title="${esc(s.resolvedKeyPath || s.keyPath)}">${esc(s.keyPath || '默认')}</code>
        </div>
        ${s.note ? `<div class="field-hint" style="margin:-4px 0 12px">${esc(s.note)}</div>` : ''}
        <div class="server-card-foot">
          <button class="btn btn-ghost" data-act="test">${icon('zap')}测试连接</button>
          <button class="btn btn-ghost" data-act="command">${icon('terminal')}命令</button>
          ${testHtml}
          <button class="icon-btn" data-act="edit" title="编辑服务器">${icon('edit')}</button>
          <button class="icon-btn" data-act="delete" title="删除服务器">${icon('trash')}</button>
        </div>
      </article>`;
    }).join('');
  }

  function serverStatusLabel(s) {
    return s === 'online' ? '运行中' : s === 'connecting' ? '连接中' : '待命';
  }

  /* ------------------------------------------------------------
     Render — settings
     ------------------------------------------------------------ */
  function renderSettings() {
    const settings = S.settings || {};
    $$('[data-setting]').forEach((input) => {
      const key = input.dataset.setting;
      if (key in settings) input.checked = toBool(settings[key]);
    });
    $$('[data-setting-input]').forEach((input) => {
      const key = input.dataset.settingInput;
      if (key in settings && document.activeElement !== input) input.value = settings[key];
    });
    applyTheme(document.documentElement.dataset.theme, false);
    applyAccent(document.documentElement.dataset.accent, false);
    const auto = S.autostart || {};
    const toggle = $('#autostartToggle');
    if (toggle) {
      toggle.checked = !!auto.enabled;
      toggle.disabled = auto.supported === false;
    }
    const status = $('#startupStatus');
    if (status) {
      status.classList.toggle('on', !!auto.enabled);
      const text = $('#startupText');
      if (text) text.textContent = auto.supported === false ? '请先从 Tunnel Studio.app 启动一次' : auto.requiresApproval ? '请在系统设置 → 通用 → 登录项中允许 Tunnel Studio' : auto.enabled ? '已加入当前用户启动项' : '未启用开机自启';
    }
    $('#autostartCommand').textContent = auto.expected || '—';
    applyMacCapabilities();
    S.settingsDirty = false;
    $('#saveSettingsBar').hidden = true;
    $('#settingsSaved').hidden = true;
  }

  function applyMacCapabilities() {
    for (const key of ['strictHostKeyChecking', 'openBrowserOnStart']) {
      const input = document.querySelector(`[data-setting="${key}"]`);
      if (input) { input.disabled = true; input.title = key === 'autoOpenOnLaunch' ? '当前需手动开启隧道' : key === 'strictHostKeyChecking' ? '固定启用主机指纹校验' : '双击 Tunnel Studio.app 自动打开浏览器'; }
    }
    const password = $('#accessPassword');
    if (password) { password.disabled = true; password.value = ''; password.placeholder = '当前使用终端手动配置，不接收密码'; }
    for (const id of ['accessGenerateKey', 'accessSaveServer', 'accessAlias']) {
      const input = $('#' + id); if (input) { input.disabled = true; if ('checked' in input) input.checked = false; }
    }
    const hint = $('#accessPasswordHint'); if (hint) hint.textContent = '请在终端输入';
    const note = $('#accessSecurityNote'); if (note) note.textContent = '当前仅生成命令和步骤，不自动生成密钥或修改服务器。请在 Mac 终端确认后执行。';
    const button = $('#btnStartAccess'); if (button) button.innerHTML = `${icon('terminal')}查看配置步骤`;
  }

  function renderAccessDefaults() {
    const first = S.servers[0];
    const hostEl = $('#accessHost');
    if (hostEl && !hostEl.value) {
      if (first) {
        hostEl.value = first.host;
        $('#accessUser').value = first.user || 'root';
        $('#accessPort').value = first.port || 22;
        $('#accessKeyPath').value = first.keyPath || 'data/ssh/id_ed25519';
        $('#accessAlias').value = '';
      } else if (S.settings) {
        hostEl.value = '';
        $('#accessUser').value = S.settings.defaultUser || 'root';
        $('#accessPort').value = S.settings.defaultPort || 22;
        $('#accessKeyPath').value = S.settings.defaultKeyPath || 'data/ssh/id_ed25519';
      }
    }
    if (!S.access.command) S.access.command = S.commands || null;
    renderCommand();
  }

  /* ------------------------------------------------------------
     Live updates
     ------------------------------------------------------------ */
  function updateLive(force = false) {
    renderModeBadge();
    applyMacCapabilities();
    renderOverview();
    const metrics = S.metrics || {};
    const tunnels = S.tunnels || [];
    const online = metrics.online != null ? metrics.online : tunnels.filter((t) => (S.runtime[t.id] || {}).status === 'online').length;
    const total = metrics.total != null ? metrics.total : tunnels.length;
    $('#kpi-online').textContent = online;
    $('#kpi-total').textContent = total;
    $('#kpi-online-hint').textContent = total ? `${Math.round((online / total) * 100)}% 可用` : '暂无隧道';
    const bar = $('#kpi-online-bar');
    if (bar) bar.style.width = `${total ? Math.round((online / total) * 100) : 0}%`;

    const latency = metrics.avgLatency || 0;
    $('#kpi-latency').textContent = latency ? latency : '—';
    const rate = S.env?.trafficAvailable === false ? { value: '—', unit: '未采集' } : fmtRate(metrics.rate || 0);
    $('#kpi-rate').textContent = rate.value;
    $('#kpi-rate-unit').textContent = rate.unit;
    $('#kpi-uptime').textContent = fmtDuration(metrics.uptimeSec || 0);
    $('#kpi-started').textContent = metrics.startedAt ? `自 ${clockOf(metrics.startedAt)} 起` : '—';
    $('#kpi-reconnect').textContent = S.settings.autoReconnect ? '自动重连已开启' : '自动重连已关闭';

    const history = (metrics.history || []);
    const latValues = history.map((h) => Number(h.latency) || 0).filter((v) => v > 0);
    const rateValues = history.map((h) => Number(h.rate) || 0);
    renderSpark($('#kpi-latency-spark'), latValues, 160, 36);
    renderSpark($('#kpi-rate-spark'), rateValues, 160, 36);

    renderNav();
    updateCards();
    updateTableRows();
    updateServerLive();
    renderServerMini();
    if (S.drawer.id) renderDrawerLive();
    $('#heroTime').textContent = `最后同步 ${timeOf(new Date().toISOString())}`;
    renderActivity(force);
  }

  function renderSpark(svg, values, w, h) {
    if (!svg) return;
    let data = values && values.length ? values : [0, 0];
    if (data.length === 1) data = [data[0], data[0]];
    const points = sparkPoints(data, w, h, 4);
    svg.innerHTML = `<path d="${areaPath(points, h)}" fill="currentColor" opacity=".1"/>
      <path d="${linePath(points)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  function updateCards() {
    $$('.tunnel-card').forEach((card) => {
      const id = card.dataset.id;
      const t = S.tunnels.find((x) => x.id === id);
      if (!t) return;
      const state = S.runtime[id] || {};
      const status = state.status || 'offline';
      card.dataset.status = status;
      const isOnline = status === 'online';
      const isActive = isOnline || status === 'connecting' || (status === 'error' && state.pid != null);
      const dot = card.querySelector('.status-dot');
      const statusEl = card.querySelector('[data-live="status"]');
      if (statusEl) { statusEl.dataset.status = status; statusEl.textContent = statusText(status); }
      const flow = card.querySelector('.flow');
      if (flow) flow.dataset.online = String(isOnline);
      const pid = card.querySelector('[data-live="pid"]');
      if (pid) pid.textContent = state.pid != null ? String(state.pid) : '—';
      const latency = card.querySelector('[data-live="latency"]');
      if (latency) latency.textContent = state.latency != null ? `${state.latency} ms` : (isOnline ? (state.probeError ? '探测失败' : (t.effectiveProbe === 'none' ? '未启用' : '探测中')) : '—');
      const uptime = card.querySelector('[data-live="uptime"]');
      if (uptime) uptime.textContent = isOnline ? fmtDuration(state.uptimeSec) : '—';
      const err = card.querySelector('[data-live="error"]');
      const portButton = card.querySelector('[data-act="port"]');
      if (portButton) portButton.hidden = status !== 'occupied';
      if (err) {
        if (state.error || state.probeError) { err.hidden = false; err.textContent = state.error || '远端探测：' + state.probeError; }
        else { err.hidden = true; err.textContent = ''; }
      }
      const toggle = card.querySelector('[data-role="toggle"]');
      if (toggle && !toggle.closest('.switch').classList.contains('is-busy')) {
        toggle.checked = isActive;
      }
      const spark = card.querySelector('[data-live="spark"]');
      if (spark) {
        const hist = state.latencyHistory && state.latencyHistory.length ? state.latencyHistory : [0, 0];
        const points = sparkPoints(hist, 92, 26, 2);
        spark.setAttribute('d', linePath(points));
        const area = card.querySelector('.spark-area');
        if (area) area.setAttribute('d', areaPath(points, 26));
      }
      const header = card.querySelector('.tc-actions .switch');
      if (header) header.title = isActive ? '关闭隧道' : '开启隧道';
      const logsBtn = card.querySelector('[data-act="logs"]');
      if (logsBtn) logsBtn.setAttribute('title', isOnline ? '查看运行日志' : '查看历史日志');
    });
    applyOverviewFilter();
  }

  function updateTableRows() {
    $$('#tunnelTableBody .t-row').forEach((row) => {
      const id = row.dataset.rowId;
      const state = S.runtime[id] || {};
      const status = state.status || 'offline';
      if (row.dataset.status !== status) {
        row.dataset.status = status;
        const statusEl = row.querySelector('[data-live="status"]');
        if (statusEl) { statusEl.dataset.status = status; statusEl.textContent = statusText(status); }
      }
      const latency = row.querySelector('[data-live="latency"]');
      if (latency) {
        latency.textContent = state.latency != null ? `${state.latency} ms` : '—';
        latency.className = `t-latency ${latencyClass(state.latency)}`;
      }
      const toggle = row.querySelector('[data-role="toggle"]');
      if (toggle && !toggle.closest('.switch').classList.contains('is-busy')) {
        toggle.checked = status === 'online' || status === 'connecting' || (status === 'error' && state.pid != null);
      }
    });
    syncSelectAll();
    applyOverviewFilter();
    applyTunnelFilter();
  }

  function updateServerLive() {
    const map = {};
    (S.servers || []).forEach((s) => { map[s.id] = s; });
    $$('.server-card').forEach((card) => {
      const s = map[card.dataset.serverId];
      if (!s) return;
      const chip = card.querySelector('[data-live="server-status"]');
      if (chip) {
        chip.className = `server-status ${s.status || 'idle'}`;
        chip.innerHTML = `<span class="status-dot"></span>${serverStatusLabel(s.status)}`;
      }
      const metas = card.querySelectorAll('.server-meta strong');
      if (metas.length >= 2) {
        metas[0].textContent = s.tunnelCount || 0;
        metas[1].textContent = s.onlineCount || 0;
      }
    });
  }

  /* ------------------------------------------------------------
     Drawer
     ------------------------------------------------------------ */
  let drawerCloseTimer = null;
  let drawerFocusTimer = null;
  let drawerFrame = null;
  let drawerPreviousFocus = null;
  function openDrawer(id, tab = 'overview') {
    const t = S.tunnels.find((x) => x.id === id);
    if (!t) return;
    clearTimeout(drawerCloseTimer);
    clearTimeout(drawerFocusTimer);
    if (drawerFrame) cancelAnimationFrame(drawerFrame);
    if (!S.drawer.id) drawerPreviousFocus = document.activeElement;
    S.drawer.id = id;
    S.drawer.tab = tab;
    const root = $('#drawerRoot');
    root.inert = false;
    root.setAttribute('aria-hidden', 'false');
    renderDrawer();
    root.classList.add('is-open');
    const scrim = $('#scrim');
    scrim.hidden = false;
    drawerFrame = requestAnimationFrame(() => { if (S.drawer.id) scrim.classList.add('is-open'); });
    document.body.classList.add('no-scroll', 'drawer-open');
    drawerFocusTimer = setTimeout(() => {
      if (S.drawer.id === id) root.querySelector('.drawer-tab.is-active')?.focus({ preventScroll: true });
    }, prefersReduced ? 0 : 340);
  }
  function closeDrawer() {
    const root = $('#drawerRoot');
    if (!root) return;
    clearTimeout(drawerCloseTimer);
    clearTimeout(drawerFocusTimer);
    if (drawerFrame) cancelAnimationFrame(drawerFrame);
    if (root.contains(document.activeElement)) drawerPreviousFocus?.focus({ preventScroll: true });
    root.inert = true;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    const scrim = $('#scrim');
    if (scrim) {
      scrim.classList.remove('is-open');
    }
    drawerCloseTimer = setTimeout(() => {
      if (S.drawer.id) return;
      if (scrim) scrim.hidden = true;
      document.body.classList.remove('drawer-open');
      if (!$('#modalRoot')?.hasChildNodes() && !S.palette.open) document.body.classList.remove('no-scroll');
    }, prefersReduced ? 0 : 340);
    S.drawer.id = null;
    S.drawer.tab = 'overview';
  }
  function renderDrawer() {
    const t = S.tunnels.find((x) => x.id === S.drawer.id);
    if (!t) { closeDrawer(); return; }
    const state = S.runtime[t.id] || {};
    const status = state.status || 'offline';
    const active = status === 'online' || status === 'connecting' || (status === 'error' && state.pid != null);
    const server = t.server || S.servers.find((x) => x.id === t.serverId) || {};
    const root = $('#drawerRoot');
    const tabs = [
      ['overview', '概览'], ['logs', '日志'], ['settings', '配置']
    ];
    root.innerHTML = `
      <div class="drawer-head">
        <div class="drawer-top">
          <div class="drawer-title">
            <h2><span class="status-dot" data-status="${status}"></span>${esc(t.name)}</h2>
            <p>${esc(server.user || 'root')}@${esc(server.host || '—')} · ${esc(t.group || '默认分组')}</p>
          </div>
          <button class="icon-btn" id="drawerClose" aria-label="关闭">${icon('x')}</button>
        </div>
        <div class="drawer-tabs">
          ${tabs.map(([key, label]) => `<button class="drawer-tab ${S.drawer.tab === key ? 'is-active' : ''}" data-drawer-tab="${key}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="drawer-body" id="drawerBody"></div>
      <div class="drawer-foot">
        <button class="btn btn-ghost" id="drawerDelete">${icon('trash')}删除</button>
        <div style="flex:1"></div>
        ${S.drawer.tab === 'settings' ? '' : `<button class="btn btn-ghost" id="drawerEdit">${icon('edit')}编辑</button>`}
        <button class="btn btn-primary" id="drawerToggle">${icon(active ? 'stop' : 'play')}${active ? '关闭隧道' : '开启隧道'}</button>
      </div>`;
    renderDrawerBody();
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerDelete').addEventListener('click', () => deleteTunnel(t.id));
    $('#drawerEdit')?.addEventListener('click', () => openTunnelModal(t));
    $('#drawerToggle').addEventListener('click', () => {
      const current = S.runtime[t.id] || {};
      const currentActive = current.status === 'online' || current.status === 'connecting' || (current.status === 'error' && current.pid != null);
      toggleTunnel(t.id, !currentActive).then(() => { if (S.drawer.id === t.id) renderDrawerLive(); });
    });
    $$('[data-drawer-tab]', root).forEach((btn) => {
      btn.addEventListener('click', () => { S.drawer.tab = btn.dataset.drawerTab; renderDrawer(); });
    });
  }
  function renderDrawerBody() {
    const t = S.tunnels.find((x) => x.id === S.drawer.id);
    if (!t) return;
    const body = $('#drawerBody');
    if (!body) return;
    const state = S.runtime[t.id] || {};
    const status = state.status || 'offline';
    const server = t.server || S.servers.find((x) => x.id === t.serverId) || {};
    if (S.drawer.tab === 'overview') {
      const history = state.latencyHistory && state.latencyHistory.length ? state.latencyHistory : [0, 0];
      const points = sparkPoints(history, 320, 70, 6);
      body.innerHTML = `
        <div class="drawer-status-row">
          <span class="status-dot" data-status="${status}"></span>
          <strong data-live="drawer-status">${statusText(status)}</strong>
          <span data-live="drawer-uptime">${state.status === 'online' ? `已运行 ${fmtDuration(state.uptimeSec)}` : '当前未运行'}</span>
        </div>
        <div class="drawer-route">
          <div class="drawer-endpoint"><span>LOCAL</span><code>${esc(t.localHost)}:${t.localPort}</code></div>
          <div class="flow" aria-hidden="true" title="链路方向：本机 → 远端；流动表示连接在线" data-online="${status === 'online'}">
            <span class="flow-track"><span class="flow-rail"></span><span class="packet"></span><span class="packet p2"></span></span>
            <span class="flow-arrow"><svg class="icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M0 6h9M5 2l4 4-4 4"/></svg></span>
          </div>
          <div class="drawer-endpoint"><span>REMOTE</span><code>${esc(t.remoteHost || '127.0.0.1')}:${t.remotePort}</code></div>
        </div>
        <div class="drawer-metrics">
          <div class="drawer-metric"><span>延迟</span><strong data-live="drawer-latency">${state.latency != null ? state.latency : '—'}<small>ms</small></strong></div>
          <div class="drawer-metric"><span>入站</span><strong data-live="drawer-bytes-in">${S.env?.trafficAvailable === false ? '未采集' : fmtBytes(state.bytesIn)}</strong></div>
          <div class="drawer-metric"><span>出站</span><strong data-live="drawer-bytes-out">${S.env?.trafficAvailable === false ? '未采集' : fmtBytes(state.bytesOut)}</strong></div>
        </div>
        <div class="drawer-chart">
          <div class="drawer-chart-head"><span>最近延迟</span><b>${state.latency != null ? state.latency + ' ms' : '—'}</b></div>
          <svg viewBox="0 0 320 70" preserveAspectRatio="none">
            <path d="${areaPath(points, 70)}" fill="currentColor" opacity=".1"/>
            <path d="${linePath(points)}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="drawer-actions">
          ${t.url ? `<button class="btn btn-primary" data-drawer-act="open-url">${icon('external')}打开面板</button>` : ''}
          ${t.url ? `<button class="btn btn-ghost" data-drawer-act="connection">${icon('info')}连接信息</button>` : ''}
          <button class="btn btn-ghost" data-drawer-act="copy">${icon('copy')}复制地址</button>
          <button class="btn btn-ghost" data-drawer-act="restart">${icon('refresh')}重启隧道</button>
          <button class="btn btn-ghost" data-drawer-act="port">${icon('search')}端口诊断</button>
        </div>
        <div class="drawer-section-title">连接信息</div>
        <div class="drawer-note" style="display:grid;gap:5px">
          <span>服务器：${esc(server.name || '—')} · ${esc(server.user || '')}@${esc(server.host || '')}:${server.port || 22}</span>
          ${t.url ? `<span>本机后端：<code>${esc(localBackendUrl(t))}</code>（在服务面板的后端地址中填写）</span>` : ''}
          <span>远端服务：${esc(t.remoteHost)}:${t.remotePort}（通过 SSH 隧道访问）</span>
          <span>探测方式：${PROBE_TEXT[t.effectiveProbe] || '自动'} · ${t.autoOpen ? '随面板启动' : '手动启动'}</span>
          <span data-live="drawer-pid">SSH 进程：${state.pid != null ? `PID ${state.pid}` : '未运行'}${state.reconnectCount ? ` · 已重连 ${state.reconnectCount} 次` : ''}</span>
          <span class="danger-text" data-live="drawer-error" ${state.error ? '' : 'hidden'}>${esc(state.error || '')}</span>
        </div>`;
      $$('[data-drawer-act]', body).forEach((btn) => btn.addEventListener('click', () => {
        const act = btn.dataset.drawerAct;
        if (act === 'open-url') openTunnelPanel(t);
        if (act === 'connection') showTunnelConnection(t);
        if (act === 'port') showPortDiagnosis(t);
        if (act === 'copy') copyText(`${t.localHost}:${t.localPort}`, '已复制本机地址');
        if (act === 'restart') restartTunnel(t.id);
      }));
      return;
    }
    if (S.drawer.tab === 'logs') {
      body.innerHTML = `<div class="drawer-log" id="drawerLog"><div class="drawer-empty">加载日志…</div></div>
        <div class="drawer-actions"><button class="btn btn-ghost" data-drawer-act="refresh-logs">${icon('refresh')}刷新</button></div>`;
      loadDrawerLogs(t.id);
      $('[data-drawer-act="refresh-logs"]', body)?.addEventListener('click', () => loadDrawerLogs(t.id));
      return;
    }
    body.innerHTML = `
      <form class="drawer-form" id="drawerForm">
        ${TunnelWorkbench.fields(t)}
        <div class="field"><span>名称</span><input name="name" value="${esc(t.name)}" maxlength="60" required></div>
        <div class="form-grid two">
          <div class="field"><span>本机端口</span><input name="localPort" type="number" min="1" max="65535" value="${t.localPort}" required></div>
          <div class="field"><span>服务器端口</span><input name="remotePort" type="number" min="1" max="65535" value="${t.remotePort}" required></div>
        </div>
        <div class="form-grid two">
          <div class="field"><span>服务器</span>
            <select name="serverId">${S.servers.map((s) => `<option value="${esc(s.id)}" ${s.id === t.serverId ? 'selected' : ''}>${esc(s.name)} · ${esc(s.host)}</option>`).join('')}</select>
          </div>
          <div class="field"><span>分组</span><input name="group" value="${esc(t.group || '')}" maxlength="24" placeholder="例如 代理"></div>
        </div>
        <div class="form-grid two">
          <div class="field"><span>远端目标</span><input name="remoteHost" value="${esc(t.remoteHost)}" spellcheck="false"></div>
          <div class="field"><span>延迟探测</span>
            <select name="probe">${Object.entries(PROBE_TEXT).map(([k, v]) => `<option value="${k}" ${k === t.probe ? 'selected' : ''}>${v}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field"><span>跳转地址 <em>可选</em></span><input name="openUrl" value="${esc(t.openUrl || '')}" placeholder="http://127.0.0.1:9090/"></div>
        <div class="field"><span>备注</span><input name="note" value="${esc(t.note || '')}" maxlength="200" placeholder="这条映射是做什么的"></div>
        <label class="checkline"><input type="checkbox" name="autoOpen" ${t.autoOpen ? 'checked' : ''}><span>面板启动时自动开启</span></label>
        <div class="form-error" id="drawerFormError" hidden></div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">${icon('check')}保存配置</button>
          <span class="field-hint">保存后如隧道正在运行，需要重启才会生效。</span>
        </div>
      </form>`;
    bindTunnelUrlPort($('#drawerForm'));
    $('#drawerForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = tunnelFormPayload(form, t.id);
      try {
        await api(`/api/tunnels/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: payload });
        toast('success', '隧道已更新', payload.name);
        await reloadBootstrap();
        if (S.drawer.id) { renderDrawer(); }
      } catch (error) {
        showFormError('drawerFormError', error.message);
      }
    });
  }
  function renderDrawerLive() {
    const t = S.tunnels.find((x) => x.id === S.drawer.id);
    if (!t || S.drawer.tab !== 'overview') return;
    const state = S.runtime[t.id] || {};
    const status = state.status || 'offline';
    const statusEl = $('[data-live="drawer-status"]');
    if (statusEl) statusEl.textContent = statusText(status);
    const statusRowDot = $('.drawer-status-row .status-dot');
    if (statusRowDot) statusRowDot.dataset.status = status;
    const lat = $('[data-live="drawer-latency"]');
    if (lat) lat.innerHTML = `${state.latency != null ? state.latency : '—'}<small>ms</small>`;
    const root = $('#drawerRoot');
    const flow = root.querySelector('.flow');
    if (flow) flow.dataset.online = String(status === 'online');
    const chart = root.querySelector('.drawer-chart svg');
    if (chart) {
      const points = sparkPoints(state.latencyHistory?.length ? state.latencyHistory : [0, 0], 320, 70, 6);
      chart.querySelector('path:first-child')?.setAttribute('d', areaPath(points, 70));
      chart.querySelector('path:last-child')?.setAttribute('d', linePath(points));
    }
    const chartValue = root.querySelector('.drawer-chart-head b');
    if (chartValue) chartValue.textContent = state.latency != null ? `${state.latency} ms` : '—';
    const headerDot = root.querySelector('.drawer-title .status-dot');
    if (headerDot) headerDot.dataset.status = status;
    const uptime = root.querySelector('[data-live="drawer-uptime"]');
    if (uptime) uptime.textContent = status === 'online' ? `已运行 ${fmtDuration(state.uptimeSec)}` : '当前未运行';
    const pid = root.querySelector('[data-live="drawer-pid"]');
    if (pid) pid.textContent = `SSH 进程：${state.pid != null ? `PID ${state.pid}` : '未运行'}${state.reconnectCount ? ` · 已重连 ${state.reconnectCount} 次` : ''}`;
    const error = root.querySelector('[data-live="drawer-error"]');
    if (error) { error.textContent = state.error || (state.probeError ? '远端探测：' + state.probeError : ''); error.hidden = !error.textContent; }
    const toggle = $('#drawerToggle');
    const active = ['online', 'connecting'].includes(status) || (status === 'error' && state.pid != null);
    if (toggle && toggle.dataset.active !== String(active)) {
      toggle.dataset.active = String(active);
      toggle.innerHTML = `${icon(active ? 'stop' : 'play')}${active ? '关闭隧道' : '开启隧道'}`;
    }
  }
  async function loadDrawerLogs(id) {
    const box = $('#drawerLog');
    if (!box) return;
    try {
      const data = await api(`/api/logs?source=${encodeURIComponent(id)}&limit=120`);
      const lines = data.lines || [];
      if (!lines.length) { box.innerHTML = `<div class="drawer-empty">暂无日志</div>`; return; }
      box.innerHTML = lines.map((line) => {
        const cls = line.level === 'error' ? 'dl-error' : line.level === 'success' ? 'dl-success' : line.level === 'warn' ? 'dl-warn' : '';
        return `<div class="${cls}"><span class="dl-time">${timeOf(line.ts)}</span>${esc(line.text)}</div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    } catch (error) {
      box.innerHTML = `<div class="drawer-empty">${esc(error.message)}</div>`;
    }
  }

  /* ------------------------------------------------------------
     Modal helpers
     ------------------------------------------------------------ */
  function openModal({ title, subtitle = '', body, footer = '', wide = false, onMount, onClose }) {
    closeModal();
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-overlay" id="modalOverlay">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <div><h3>${esc(title)}</h3>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
          <button class="icon-btn" id="modalClose" aria-label="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
    document.body.classList.add('no-scroll');
    root._onClose = onClose || null;
    const overlay = $('#modalOverlay');
    const close = () => closeModal();
    $('#modalClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    root._previousFocus = document.activeElement;
    setTimeout(() => {
      const target = root.querySelector('input:not([type=hidden]), select, textarea')
        || root.querySelector('.modal-foot .btn-primary')
        || root.querySelector('button');
      if (target) target.focus();
    }, 60);
    onMount?.(root, close);
  }
  function closeModal() {
    const root = $('#modalRoot');
    if (!root) return;
    if (!root.innerHTML) return;
    const previous = root._previousFocus;
    const onClose = root._onClose;
    root._onClose = null;
    root.innerHTML = '';
    if (!document.querySelector('.drawer.is-open') && !$('#paletteRoot')?.hasChildNodes()) {
      document.body.classList.remove('no-scroll');
    }
    if (onClose) { try { onClose(); } catch { /* ignore */ } }
    if (previous && previous.focus) { try { previous.focus(); } catch { /* ignore */ } }
  }
  function showFormError(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
  }

  /* ------------------------------------------------------------
     Tunnel form
     ------------------------------------------------------------ */
  function openTunnelModal(tunnel = null, kind = (S.view === 'dedicated' ? 'dedicated' : 'standard')) {
    if (!S.servers.length) {
      toast('warning', '还没有服务器', '请先在「服务器」页添加一台 SSH 服务器。');
      setView('servers');
      return;
    }
    const isEdit = !!tunnel;
    const defaults = {
      name: '', kind, serverId: S.servers[0].id, localPort: '', remotePort: '',
      remoteHost: '127.0.0.1', localHost: '127.0.0.1', probe: kind === 'dedicated' ? 'tcp' : 'auto', group: '', note: '', openUrl: '', autoOpen: false
    };
    const t = isEdit ? tunnel : defaults;
    const groups = Array.from(new Set(S.tunnels.map((x) => x.group).filter(Boolean)));
    const body = `<form class="modal-form" id="tunnelForm">
      ${TunnelWorkbench.fields(t)}
      <div class="preset-row" id="tunnelPresets">
        <span>常用模板</span>
        <button type="button" class="preset-chip" data-preset="9090">Mihomo 面板</button>
        <button type="button" class="preset-chip" data-preset="7890">SOCKS 代理</button>
        <button type="button" class="preset-chip" data-preset="8317">CPAMC</button>
      </div>
      <label class="field"><span>名称</span><input name="name" value="${esc(t.name)}" placeholder="例如：Mihomo 控制面板" maxlength="60" required></label>
      <div class="form-grid two">
        <label class="field"><span>本机端口</span><input name="localPort" type="number" min="1" max="65535" value="${esc(t.localPort)}" placeholder="18080" required></label>
        <label class="field"><span>服务器端口</span><input name="remotePort" type="number" min="1" max="65535" value="${esc(t.remotePort)}" placeholder="8080" required></label>
      </div>
      <div class="form-grid two">
        <label class="field"><span>服务器</span>
          <select name="serverId">${S.servers.map((s) => `<option value="${esc(s.id)}" ${s.id === t.serverId ? 'selected' : ''}>${esc(s.name)} · ${esc(s.host)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>分组</span><input name="group" list="groupList" value="${esc(t.group)}" placeholder="例如 代理" maxlength="24">
          <datalist id="groupList">${groups.map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist>
        </label>
      </div>
      <div class="form-grid two">
        <label class="field"><span>远端目标地址</span><input name="remoteHost" value="${esc(t.remoteHost)}" spellcheck="false"></label>
        <label class="field"><span>延迟探测</span>
          <select name="probe">${Object.entries(PROBE_TEXT).map(([k, v]) => `<option value="${k}" ${k === t.probe ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
      </div>
      <label class="field"><span>跳转地址 <em>可选</em></span><input name="openUrl" value="${esc(t.openUrl || '')}" placeholder="http://127.0.0.1:18080/" spellcheck="false">
        <small>开启隧道后，「打开」按钮会访问这个地址。</small>
      </label>
      <label class="field"><span>备注 <em>可选</em></span><input name="note" value="${esc(t.note || '')}" maxlength="200" placeholder="补充说明，例如：只在内网使用"></label>
      <label class="checkline"><input type="checkbox" name="autoOpen" ${t.autoOpen ? 'checked' : ''}><span>面板启动时自动开启这条隧道</span></label>
      <div class="form-error" id="tunnelFormError" hidden></div>
    </form>`;
    openModal({
      title: isEdit ? '编辑隧道' : (kind === 'dedicated' ? '新建专用隧道' : '新建隧道'),
      subtitle: isEdit ? '修改端口或服务器后，请重启隧道让配置生效。' : '所有映射都从本机 127.0.0.1 转发到服务器，无需开放公网端口。',
      body,
      wide: true,
      footer: `<button class="btn btn-ghost" data-modal-cancel>取消</button>
        <button class="btn btn-primary" id="tunnelSubmit">${icon(isEdit ? 'check' : 'plus')}${isEdit ? '保存修改' : '创建隧道'}</button>`,
      onMount(root, close) {
        $('[data-modal-cancel]', root).addEventListener('click', close);
        const form = $('#tunnelForm', root);
        bindTunnelUrlPort(form);
        $('#tunnelSubmit', root).addEventListener('click', () => form.requestSubmit());
        $$('#tunnelPresets .preset-chip', root).forEach((chip) => chip.addEventListener('click', () => {
          const remote = chip.dataset.preset;
          if (!form.name.value) form.name.value = chip.textContent.trim();
          form.remotePort.value = remote;
          if (!form.localPort.value) form.localPort.value = remote === '7890' ? '17891' : remote;
          form.group.value = remote === '9090' || remote === '7890' ? '代理' : '服务面板';
          form.probe.value = remote === '7890' ? 'socks5' : 'http';
          if (remote !== '7890') form.openUrl.value = `http://127.0.0.1:${form.localPort.value}/${remote === '9090' ? 'ui/' : remote === '8317' ? 'management.html' : ''}`;
        }));
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const payload = tunnelFormPayload(form, isEdit ? t.id : '');
          if (!payload) return;
          try {
            if (isEdit) await api(`/api/tunnels/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: payload });
            else await api('/api/tunnels', { method: 'POST', body: payload });
            close();
            toast('success', isEdit ? '隧道已更新' : '隧道已创建', `${payload.name} · 127.0.0.1:${payload.localPort}`);
            await reloadBootstrap();
          } catch (error) {
            showFormError('tunnelFormError', error.message);
          }
        });
      }
    });
  }

  function bindTunnelUrlPort(form) {
    TunnelWorkbench.bindForm(form);
    const port = form.elements.namedItem('localPort');
    const urlInput = form.elements.namedItem('openUrl');
    let previousPort = Number(port.value);
    const sync = () => {
      const nextPort = Number(port.value);
      if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) return;
      try {
        const url = new URL(urlInput.value);
        const currentPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && currentPort === previousPort) {
          url.port = String(nextPort);
          urlInput.value = url.href;
        }
      } catch { /* 未填写或自定义地址保持原样 */ }
      previousPort = nextPort;
    };
    port.addEventListener('input', sync);
    port.addEventListener('change', sync);
  }

  function tunnelFormPayload(form, excludeId = '') {
    const errorEl = $('#tunnelFormError');
    if (errorEl) errorEl.hidden = true;
    const name = form.name.value.trim();
    const localPort = Number(form.localPort.value);
    const remotePort = Number(form.remotePort.value);
    if (!name) { showFormError('tunnelFormError', '请填写隧道名称。'); return null; }
    if (!(localPort >= 1 && localPort <= 65535)) { showFormError('tunnelFormError', '本机端口必须为 1 - 65535。'); return null; }
    if (!(remotePort >= 1 && remotePort <= 65535)) { showFormError('tunnelFormError', '服务器端口必须为 1 - 65535。'); return null; }
    const duplicate = S.tunnels.find((t) => t.id !== excludeId && Number(t.localPort) === localPort);
    if (duplicate) {
      showFormError('tunnelFormError', `本机端口 ${localPort} 已被「${duplicate.name}」使用。`);
      return null;
    }
    return {
      name,
      serverId: form.serverId.value,
      localHost: '127.0.0.1',
      localPort,
      remoteHost: form.remoteHost.value.trim() || '127.0.0.1',
      remotePort,
      probe: form.probe.value,
      openUrl: form.openUrl.value.trim(),
      ...TunnelWorkbench.payload(form),
      group: form.group.value.trim(),
      note: form.note.value.trim(),
      autoOpen: form.autoOpen.checked
    };
  }

  /* ------------------------------------------------------------
     Server form
     ------------------------------------------------------------ */
  function openServerModal(server = null) {
    const isEdit = !!server;
    const s = server || {
      name: '', host: '', port: S.settings.defaultPort || 22, user: S.settings.defaultUser || 'root',
      keyPath: S.settings.defaultKeyPath || 'data/ssh/id_ed25519', color: 'violet', note: ''
    };
    const body = `<form class="modal-form" id="serverForm">
      <label class="field"><span>显示名称</span><input name="name" value="${esc(s.name)}" placeholder="例如：主节点" maxlength="40" required></label>
      <div class="form-grid two">
        <label class="field"><span>服务器地址</span><input name="host" value="${esc(s.host)}" placeholder="192.0.2.10" spellcheck="false" required></label>
        <label class="field"><span>SSH 端口</span><input name="port" type="number" min="1" max="65535" value="${esc(s.port)}" required></label>
      </div>
      <div class="form-grid two">
        <label class="field"><span>用户名</span><input name="user" value="${esc(s.user)}" spellcheck="false" required></label>
        <label class="field"><span>密钥路径</span><input name="keyPath" value="${esc(s.keyPath)}" spellcheck="false"></label>
      </div>
      <label class="field"><span>备注 <em>可选</em></span><input name="note" value="${esc(s.note || '')}" maxlength="200" placeholder="服务器用途或机房位置"></label>
      <div class="field"><span>标识色</span>
        <div class="accent-row" id="serverColorRow">
          ${['violet', 'ocean', 'emerald', 'amber', 'rose'].map((c) => `<button type="button" class="accent-dot ${c === s.color ? 'is-active' : ''}" data-color="${c}" style="--dot:${{ violet: '#8b5cf6', ocean: '#3b82f6', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e' }[c]}" aria-label="${c}"></button>`).join('')}
        </div>
      </div>
      <div class="form-error" id="serverFormError" hidden></div>
    </form>`;
    openModal({
      title: isEdit ? '编辑服务器' : '添加服务器',
      subtitle: '地址、端口和用户会用于所有关联的隧道，密钥路径支持 ~ 展开。',
      body,
      footer: `<button class="btn btn-ghost" data-modal-cancel>取消</button>
        <button class="btn btn-primary" id="serverSubmit">${icon(isEdit ? 'check' : 'plus')}${isEdit ? '保存修改' : '添加服务器'}</button>`,
      onMount(root, close) {
        $('[data-modal-cancel]', root).addEventListener('click', close);
        const form = $('#serverForm', root);
        let color = s.color || 'violet';
        $$('#serverColorRow .accent-dot', root).forEach((dot) => dot.addEventListener('click', () => {
          color = dot.dataset.color;
          $$('#serverColorRow .accent-dot', root).forEach((d) => d.classList.toggle('is-active', d === dot));
        }));
        $('#serverSubmit', root).addEventListener('click', () => form.requestSubmit());
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const payload = {
            name: form.name.value.trim(),
            host: form.host.value.trim(),
            port: Number(form.port.value),
            user: form.user.value.trim(),
            keyPath: form.keyPath.value.trim(),
            note: form.note.value.trim(),
            color
          };
          if (!payload.name || !payload.host) { showFormError('serverFormError', '名称和服务器地址不能为空。'); return; }
          if (!(payload.port >= 1 && payload.port <= 65535)) { showFormError('serverFormError', '端口必须为 1 - 65535。'); return; }
          try {
            if (isEdit) await api(`/api/servers/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: payload });
            else await api('/api/servers', { method: 'POST', body: payload });
            close();
            toast('success', isEdit ? '服务器已更新' : '服务器已添加', `${payload.user}@${payload.host}:${payload.port}`);
            await reloadBootstrap();
          } catch (error) {
            showFormError('serverFormError', error.message);
          }
        });
      }
    });
  }

  function confirmAction({ title, message, detail = '', confirmText = '确认', danger = false, requireText = '' }) {
    return new Promise((resolve) => {
      let settled = false;
      const body = `<div style="display:flex;gap:14px;align-items:flex-start">
        <span class="confirm-icon">${icon(danger ? 'alert' : 'info')}</span>
        <div style="min-width:0;flex:1">
          <div style="font-size:12.5px;color:var(--text-2);line-height:1.65">${message}</div>
          ${detail ? `<div class="confirm-list">${detail}</div>` : ''}
          ${requireText ? `<label class="field" style="margin-top:12px"><span>输入 <code>${esc(requireText)}</code> 以继续</span><input id="confirmTextInput" autocomplete="off"></label>` : ''}
        </div>
      </div>`;
      openModal({
        title,
        body,
        footer: `<button class="btn btn-ghost" data-modal-cancel>取消</button>
          <button class="btn ${danger ? 'btn-ghost danger-ghost' : 'btn-primary'}" id="confirmActionBtn" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>`,
        onMount(root, close) {
          const btn = $('#confirmActionBtn', root);
          const input = $('#confirmTextInput', root);
          if (input) {
            input.addEventListener('input', () => { btn.disabled = input.value.trim() !== requireText; });
            setTimeout(() => input.focus(), 50);
          }
          $('[data-modal-cancel]', root).addEventListener('click', () => { if (!settled) { settled = true; resolve(false); } close(); });
          btn.addEventListener('click', () => { if (!settled) { settled = true; resolve(true); } close(); });
          const overlay = $('#modalOverlay');
          overlay?.addEventListener('mousedown', (e) => { if (e.target === overlay && !settled) { settled = true; resolve(false); } });
        },
        onClose() { if (!settled) { settled = true; resolve(false); } }
      });
    });
  }

  /* ------------------------------------------------------------
     Tunnel actions
     ------------------------------------------------------------ */
  async function toggleTunnel(id, next) {
    const t = S.tunnels.find((x) => x.id === id);
    if (!t) return;
    if (S.pendingToggles?.has(id)) return;
    S.pendingToggles ??= new Set();
    S.pendingToggles.add(id);
    const switches = $$(`.tunnel-card[data-id="${id}"] .switch, [data-row-id="${id}"] .switch`);
    switches.forEach(el => el.classList.add('is-busy'));
    try {
      await api(`/api/tunnels/${encodeURIComponent(id)}/${next ? 'open' : 'close'}`, { method: 'POST' });
      if (next) toast('info', '正在开启隧道', t.name, 1800);
      scheduleRefresh(250);
    } catch (error) {
      toast('error', next ? '开启失败' : '关闭失败', error.message);
      if (next && error.message.includes('占用')) showPortDiagnosis(t);
      scheduleRefresh(100);
    } finally {
      setTimeout(() => { S.pendingToggles.delete(id); switches.forEach(el => el.classList.remove('is-busy')); }, 700);
    }
  }
  async function restartTunnel(id) {
    const t = S.tunnels.find((x) => x.id === id);
    if (!t) return;
    try {
      await api(`/api/tunnels/${encodeURIComponent(id)}/restart`, { method: 'POST' });
      toast('info', '正在重启隧道', t.name);
      scheduleRefresh(300);
    } catch (error) { toast('error', '重启失败', error.message); }
  }
  async function deleteTunnel(id) {
    const t = S.tunnels.find((x) => x.id === id);
    if (!t) return;
    const ok = await confirmAction({
      title: '删除隧道',
      message: `确定要删除「${esc(t.name)}」吗？`,
      detail: `本机 127.0.0.1:${t.localPort} → ${(t.server || {}).host || ''}:${t.remotePort}。正在运行的隧道会先被关闭。`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      S.selection.delete(id);
      if (S.drawer.id === id) closeDrawer();
      await reloadBootstrap();
      toast('success', '隧道已删除', t.name);
      pollState();
    } catch (error) { toast('error', '删除失败', error.message); }
  }
  async function showPortDiagnosis(t) {
    try {
      const result = await api(`/api/tunnels/${encodeURIComponent(t.id)}/port`);
      const diagnosis = result.diagnosis;
      const labels = { free: '端口空闲', managed: '本项目已记录的隧道', matching: '相同映射，归属未确认', external: '其他程序或独立 SSH 会话', unknown: '归属无法核实' };
      openModal({
        title: '端口诊断',
        subtitle: `${t.name} · ${result.host}:${result.port}`,
        body: `<div class="drawer-note" style="display:grid;gap:12px;overflow-wrap:anywhere">
          <strong>${esc(labels[diagnosis.kind] || labels.unknown)}</strong>
          <p>${esc(diagnosis.message)}</p>
          ${(diagnosis.listeners || []).map((item) => `<div><strong>${esc(item.name)} · PID ${item.pid}</strong><br>监听：${esc((item.addresses || []).join(', ') || item.address || '—')}<br>${esc(item.detail || '')}${item.parent ? `<br>父进程：${esc(item.parent.name)} · PID ${item.parent.pid}${item.parent.retryDetected ? '<br><strong class="danger-text">父进程脚本包含 SSH 重试循环。只结束 SSH 子进程可能会被重新拉起，PID 会变化但端口不变。请先停止原启动脚本，再处理占用。</strong>' : ''}` : ''}</div>`).join('')}
          <p>面板仅管理本次运行创建的 SSH 子进程。其他占用请修改本机端口，或确认所属项目后到对应项目关闭；修改端口后，服务页面的后端地址也要同步更新。</p>
          ${S.simulation ? '<p>当前为演示模式；此处显示的是真实本机监听情况。</p>' : ''}
        </div>`,
        footer: `<button class="btn btn-ghost" id="portRefresh">${icon('refresh')}重新检查</button><button class="btn btn-ghost" id="portEdit">${icon('edit')}修改本机端口</button>`,
        onMount(root, close) {
          $('#portRefresh', root).addEventListener('click', () => showPortDiagnosis(t));
          $('#portEdit', root).addEventListener('click', () => { close(); openTunnelModal(t); });

        }
      });
    } catch (error) { toast('error', '无法诊断端口', error.message); }
  }

  function localBackendUrl(t) {
    let host = t.localHost || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
    let protocol = 'http:';
    try { if (new URL(t.url || t.openUrl).protocol === 'https:') protocol = 'https:'; } catch { /* 默认 HTTP */ }
    return `${protocol}//${host}:${t.localPort}`;
  }

  function showTunnelConnection(t) {
    const server = t.server || S.servers.find((s) => s.id === t.serverId) || {};
    const backend = localBackendUrl(t);
    if (t.kind === 'dedicated' || !t.url) {
      openModal({title: '连接信息', subtitle: t.name,
        body: `<div class="drawer-note" style="display:grid;gap:14px"><div><strong>${t.kind === 'dedicated' ? 'HTTP 代理地址' : '本机入口'}</strong><br><code>${esc(t.kind === 'dedicated' ? backend : `${t.localHost}:${t.localPort}`)}</code></div><div>SSH：${esc(server.user)}@${esc(server.host)}:${server.port || 22}<br>远端入口：${esc(t.remoteHost)}:${t.remotePort}</div>${TunnelWorkbench.summary(t)}<p>${t.kind === 'dedicated' ? '请在对应浏览器或应用中配置此代理。预期出口仅为配置记录，未实时验证。' : '请通过支持对应协议的应用连接本机入口。'}</p></div>`,
        footer: `<button class="btn btn-primary" id="copyConnection">${icon('copy')}复制地址</button>`,
        onMount(root) { $('#copyConnection', root).addEventListener('click', () => copyText(t.kind === 'dedicated' ? backend : `${t.localHost}:${t.localPort}`)); }
      });
      return;
    }
    const mihomo = Number(t.remotePort) === 9090;
    openModal({
      title: '连接信息',
      subtitle: `${server.name || ''} · ${server.host || ''}`,
      body: `<div class="drawer-note" style="display:grid;gap:14px">
        <div>页面入口<br><code style="overflow-wrap:anywhere">${esc(t.url)}</code></div>
        <div><strong>本机后端地址</strong><br><code style="overflow-wrap:anywhere">${esc(backend)}</code></div>
        <div>SSH 目标：${esc(server.user)}@${esc(server.host)}:${server.port || 22}<br>远端服务：${esc(t.remoteHost)}:${t.remotePort}</div>
        <p>${mihomo ? '在 Mihomo 页面填写上面的本机后端地址；Secret 使用当前服务器的 Mihomo 密钥。两台服务器的密钥可能不同。' : '如果服务页面要求填写后端地址，请使用上面的本机后端地址；登录凭据使用当前服务器对应服务的配置。'}</p>
        <p>连接被拒绝通常表示隧道未开启；HTTP 401 / 403 表示服务已响应，需要核对登录凭据。演示模式不会建立真实连接。</p>
      </div>`,
      footer: `<button class="btn btn-ghost" id="copyBackend">${icon('copy')}复制后端地址</button><button class="btn btn-primary" id="openConnection">${icon('external')}打开面板</button>`,
      onMount(root) {
        $('#copyBackend', root).addEventListener('click', () => copyText(backend, '后端地址已复制'));
        $('#openConnection', root).addEventListener('click', () => openTunnelPanel(t, true));
      }
    });
  }

  const pendingPanelOpens = new Set();
  async function openTunnelPanel(t, skipGuide = false) {
    if (!t?.url) return;
    if (Number(t.remotePort) === 9090 && !skipGuide) { showTunnelConnection(t); return; }
    if (pendingPanelOpens.has(t.id)) {
      toast('info', '正在打开面板', '正在等待隧道和登录链接，请勿重复点击。');
      return;
    }
    pendingPanelOpens.add(t.id);
    toast('info', '正在打开面板', '正在检查隧道并准备登录链接，请稍候。');
    try {
      let snapshot = await api('/api/state');
      if (snapshot.simulation) {
        toast('warning', '当前是演示模式', '请在设置中切换到真实模式，再打开服务面板。');
        return;
      }
      let state = (snapshot.runtime || {})[t.id] || {};
      if (state.status !== 'online') {
        await api(`/api/tunnels/${encodeURIComponent(t.id)}/open`, { method: 'POST' });
        const deadline = Date.now() + 15000;
        do {
          await new Promise((resolve) => setTimeout(resolve, 400));
          snapshot = await api('/api/state');
          if (snapshot.simulation) throw new Error('已切换到演示模式，请切回真实模式后重试。');
          state = (snapshot.runtime || {})[t.id] || {};
          if (['error', 'occupied', 'offline'].includes(state.status)) throw new Error(state.error || '隧道未能建立，请查看运行日志。');
        } while (state.status !== 'online' && Date.now() < deadline);
        if (state.status !== 'online') throw new Error('隧道仍在连接，请稍后重试。');
      }
      await api('/api/open-url', { method: 'POST', body: { url: t.url } });
      pollState();
    } catch (error) { toast('error', '无法打开面板', error.message); } finally { pendingPanelOpens.delete(t.id); }
  }
  function copyLocal(t) {
    copyText(`${t.localHost}:${t.localPort}`, '已复制本机地址');
  }

  /* ------------------------------------------------------------
     Batch
     ------------------------------------------------------------ */
  async function batchAction(action) {
    const ids = Array.from(S.selection);
    if (!ids.length) return;
    if (action === 'delete') {
      const ok = await confirmAction({
        title: '批量删除隧道',
        message: `确定删除选中的 ${ids.length} 条隧道吗？`,
        detail: '正在运行的隧道会先被关闭，删除后不可撤销。',
        confirmText: '删除',
        danger: true
      });
      if (!ok) return;
    }
    try {
      const result = await api('/api/batch', { method: 'POST', body: { action, ids } });
      const failed = (result.results || []).filter((r) => !r.ok);
      if (failed.length) toast('warning', '部分操作未完成', failed.map((f) => f.error).join('；'));
      else toast('success', action === 'delete' ? '已删除' : '操作已下发', `${ids.length} 条隧道`);
      S.selection.clear();
      await reloadBootstrap();
      pollState();
    } catch (error) { toast('error', '批量操作失败', error.message); }
  }

  /* ------------------------------------------------------------
     Settings bindings
     ------------------------------------------------------------ */
  function bindSettingSwitches() {
    $$('[data-setting]').forEach((input) => {
      input.addEventListener('change', async () => {
        const key = input.dataset.setting;
        const value = input.checked;
        if (key === 'simulation') {
          const ok = await confirmAction({
            title: value ? '切换到演示模式' : '切换到真实 SSH 模式',
            message: value
              ? '演示模式只模拟状态和延迟，不会启动任何 SSH 进程。'
              : '真实模式会调用本机 ssh 建立端口转发。请确认所有隧道已关闭，并且密钥可以正常登录。',
            detail: value ? '' : '切换前需要先关闭全部隧道；面板不会接管或结束其他 SSH 会话。',
            confirmText: value ? '启用演示模式' : '启用真实模式',
            danger: !value
          });
          if (!ok) { input.checked = !value; return; }
        }
        input.closest('.switch')?.classList.add('is-busy');
        try {
          const res = await api('/api/settings', { method: 'POST', body: { [key]: value } });
          if (res.settings) S.settings = res.settings;
          if (key === 'simulation') {
            S.simulation = !!value;
            renderModeBadge();
            toast(value ? 'info' : 'warning', value ? '已切换到演示模式' : '已切换到真实模式', value ? '所有操作都在本地模拟。' : '隧道操作将调用 ssh。');
            await reloadBootstrap();
          } else {
            toast('success', '设置已保存', '');
          }
        } catch (error) {
          input.checked = !value;
          toast('error', '设置未保存', error.message);
        } finally {
          input.closest('.switch')?.classList.remove('is-busy');
        }
      });
    });
  }

  function markSettingsDirty() {
    S.settingsDirty = true;
    $('#saveSettingsBar').hidden = false;
    $('#settingsSaved').hidden = true;
  }

  async function saveSettingsInputs() {
    const payload = {};
    $$('[data-setting-input]').forEach((input) => {
      const key = input.dataset.settingInput;
      const value = input.type === 'number' ? Number(input.value) : input.value.trim();
      payload[key] = value;
    });
    if (!(payload.defaultPort >= 1 && payload.defaultPort <= 65535)) { toast('error', '端口无效', '默认端口必须为 1 - 65535。'); return; }
    if (!(payload.panelPort >= 1024 && payload.panelPort <= 65535)) { toast('error', '端口无效', '面板端口建议使用 1024 - 65535。'); return; }
    if (!(payload.refreshMs >= 700 && payload.refreshMs <= 15000)) { toast('error', '刷新频率无效', '刷新间隔应在 700 - 15000 ms。'); return; }
    try {
      const res = await api('/api/settings', { method: 'POST', body: payload });
      if (res.settings) S.settings = res.settings;
      S.settingsDirty = false;
      $('#saveSettingsBar').hidden = true;
      $('#settingsSaved').hidden = false;
      setTimeout(() => { $('#settingsSaved').hidden = true; }, 2200);
      toast('success', '设置已保存', payload.panelPort !== Number(S.env.panelPort) ? '面板端口将在下次启动时生效。' : '');
      restartPolling();
    } catch (error) {
      toast('error', '保存失败', error.message);
    }
  }

  async function toggleAutostart(next) {
    if (next) {
      const ok = await confirmAction({
        title: '启用开机自启',
        message: '将在当前用户的启动项中写入 Tunnel Studio 的启动命令。',
        detail: '登录系统后，面板会在后台启动；不会自动弹浏览器。此操作不需要管理员权限，可随时关闭。',
        confirmText: '启用开机自启'
      });
      if (!ok) { $('#autostartToggle').checked = false; return; }
    }
    try {
      const res = await api('/api/startup', { method: 'POST', body: { enabled: next } });
      S.autostart = res.autostart || {};
      if (S.autostart.requiresApproval) toast('warning', '等待系统允许', '请在系统设置 → 通用 → 登录项中允许 Tunnel Studio');
      else toast('success', next ? '已启用开机自启' : '已关闭开机自启', next ? '下次登录系统时自动启动面板' : '');
      renderSettings();
    } catch (error) {
      $('#autostartToggle').checked = !next;
      toast('error', '操作失败', error.message);
    }
  }

  async function exportConfig() {
    try {
      const response = await fetch('/api/export', { headers: { 'X-Panel-Token': S.token }, cache: 'no-store' });
      if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tunnel-studio-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('success', '配置已导出', '包含服务器、隧道与面板设置');
    } catch (error) { toast('error', '导出失败', error.message); }
  }

  async function importConfig(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const ok = await confirmAction({
        title: '导入配置',
        message: '导入会覆盖当前的服务器与隧道配置，并停止所有运行中的隧道。',
        detail: `文件：${file.name}`,
        confirmText: '导入并覆盖',
        danger: true
      });
      if (!ok) return;
      await api('/api/import', { method: 'POST', body: { config: parsed } });
      await reloadBootstrap();
      toast('success', '配置已导入', '服务器与隧道列表已更新');
    } catch (error) {
      toast('error', '导入失败', error.message);
    } finally {
      const input = $('#importFile');
      if (input) input.value = '';
    }
  }

  /* ------------------------------------------------------------
     Access wizard
     ------------------------------------------------------------ */
  function accessFormPayload() {
    return {
      host: $('#accessHost').value.trim(),
      port: Number($('#accessPort').value),
      user: $('#accessUser').value.trim(),
      password: '',
      keyPath: $('#accessKeyPath').value.trim(),
      alias: $('#accessAlias').value.trim(),
      generateKey: $('#accessGenerateKey').checked,
      saveServer: $('#accessSaveServer').checked
    };
  }

  async function startAccess() {
    if (S.access.timer) return;
    const payload = accessFormPayload();
    if (!payload.host) { toast('error', '请填写服务器地址', ''); $('#accessHost').focus(); return; }
    if (!(payload.port >= 1 && payload.port <= 65535)) { toast('error', '端口无效', 'SSH 端口必须为 1 - 65535。'); return; }

    if (S.access.timer) clearInterval(S.access.timer);
    S.access.jobId = null;
    S.access.lastJob = null;
    setAccessState('running');
    const startBtn = $('#btnStartAccess');
    if (startBtn) startBtn.disabled = true;
    try {
      const res = await api('/api/passwordless', { method: 'POST', body: payload });
      S.access.jobId = res.jobId;
      S.access.lastJob = res.job;
      renderAccessSteps(res.job);
      S.access.timer = setInterval(pollAccessJob, 500);
      pollAccessJob();
      toast('info', '已生成配置步骤', `${payload.user}@${payload.host}:${payload.port}`);
    } catch (error) {
      setAccessState('failed');
      const startBtn = $('#btnStartAccess');
      if (startBtn) startBtn.disabled = false;
      toast('error', '无法开始配置', error.message);
    }
  }

  async function pollAccessJob() {
    if (!S.access.jobId) return;
    try {
      const res = await api(`/api/passwordless?id=${encodeURIComponent(S.access.jobId)}`);
      const job = res.job;
      if (!job) return;
      S.access.lastJob = job;
      renderAccessStepStates(job);
      if (job.status !== 'running') {
        clearInterval(S.access.timer);
        S.access.timer = null;
        const startBtn = $('#btnStartAccess');
        if (startBtn) startBtn.disabled = false;
        const passwordEl = $('#accessPassword');
        if (passwordEl) passwordEl.value = '';
        setAccessState(job.status);
        renderAccessResult(job);
        if (job.status === 'success') {
          toast('success', '免密登录配置完成', job.simulation ? '演示模式：未连接服务器' : '公钥已写入并通过验证');
          const host = job.host;
          const port = job.port;
          const user = job.user;
          await reloadBootstrap();
          if (job.serverId) {
            const s = S.servers.find((x) => x.id === job.serverId);
            if (s) toast('info', '服务器已保存', `${s.name} · ${s.user}@${s.host}:${s.port}`, 3800);
          }
          $('#accessHost').value = host;
          $('#accessPort').value = port;
          $('#accessUser').value = user;
        } else if (job.status === 'manual') {
          toast('warning', '需要手动完成', '自动安装未成功，请复制下方 Shell 命令执行。', 6000);
          $('#commandPanel').scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'center' });
        } else {
          toast('error', '配置失败', job.message || '请检查服务器与密钥配置。');
        }
      }
    } catch (error) {
      clearInterval(S.access.timer);
      S.access.timer = null;
      const startBtn = $('#btnStartAccess');
      if (startBtn) startBtn.disabled = false;
      setAccessState('failed');
      toast('error', '读取任务失败', error.message);
    }
  }

  function setAccessState(state) {
    const badge = $('#accessStateBadge');
    const text = $('#accessStatusText');
    const map = {
      idle: ['待开始', '待开始'],
      running: ['进行中', '正在与服务器交互…'],
      success: ['已完成', '全部步骤已完成'],
      failed: ['失败', '请检查错误信息'],
      manual: ['需手动完成', '请复制命令手动执行']
    };
    if (badge) {
      badge.dataset.state = state;
      badge.textContent = (map[state] || map.idle)[0];
    }
    if (text) text.textContent = (map[state] || map.idle)[1];
    $('#accessResult').hidden = state === 'idle' || state === 'running';
  }

  function renderAccessSteps(job) {
    $$('#accessSteps li').forEach((li) => {
      li.dataset.state = 'idle';
      if (!li.dataset.desc) li.dataset.desc = li.querySelector('small').textContent;
      li.querySelector('small').textContent = li.dataset.desc;
    });
    if (job && job.steps) {
      renderAccessStepStates(job);
      if (job.status !== 'running') renderAccessResult(job);
      else { $('#accessResult').hidden = true; setAccessState('running'); }
    } else {
      setAccessState('idle');
      $('#accessResult').hidden = true;
    }
  }
  function renderAccessStepStates(job) {
    if (!job || !job.steps) return;
    const byId = {};
    job.steps.forEach((step) => { byId[step.id] = step; });
    $$('#accessSteps li').forEach((li) => {
      const step = byId[li.dataset.step];
      if (!step) return;
      li.dataset.state = step.status || 'pending';
      if (!li.dataset.desc) li.dataset.desc = li.querySelector('small').textContent;
      const small = li.querySelector('small');
      if (small) small.textContent = step.detail || li.dataset.desc;
      li.title = step.detail || '';
    });
    const running = job.steps.find((s) => s.status === 'running');
    if (running) setAccessState('running');
    else if (job.status === 'success') setAccessState('success');
    else if (job.status === 'manual') setAccessState('manual');
    else if (job.status === 'failed') setAccessState('failed');
  }
  function renderAccessResult(job) {
    const box = $('#accessResult');
    if (!box) return;
    box.hidden = false;
    box.className = `access-result ${job.status}`;
    let message = job.message || '';
    if (job.status === 'success') {
      message = `已为 ${job.user}@${job.host}:${job.port} 配置免密登录${job.simulation ? '（演示模式，未实际写入服务器）' : ''}。`;
      if (job.serverId) message += ' 服务器已加入列表。';
    }
    box.innerHTML = `${esc(message)}${job.status === 'success' ? ` <button class="link-btn" data-nav="servers" style="margin-left:4px">查看服务器 ${icon('chevron-right')}</button>` : ''}`;
  }

  function updateAccessCommand({ immediate = false } = {}) {
    const payload = accessFormPayload();
    if (S.access.commandTimer) clearTimeout(S.access.commandTimer);
    if (!payload.host) {
      S.access.commandRequestSeq++;
      S.access.command = null;
      renderCommand();
      return Promise.resolve(null);
    }
    const requestSeq = ++S.access.commandRequestSeq;
    const run = async () => {
      try {
        const res = await api('/api/passwordless/command', {
          method: 'POST',
          body: { host: payload.host, port: payload.port, user: payload.user, keyPath: payload.keyPath, alias: payload.alias }
        });
        if (res.command && requestSeq === S.access.commandRequestSeq) {
          S.access.command = res.command;
          renderCommand();
          const target = $('#cmdTarget');
          if (target) target.textContent = `为 ${res.command.target} 生成，可直接粘贴到 Mac 终端执行。`;
        }
        return res.command || null;
      } catch { /* 输入过程中网络短暂失败时保留上一份命令 */ return null; }
    };
    if (immediate) return run();
    S.access.commandTimer = setTimeout(run, 350);
    return Promise.resolve(null);
  }

  function renderCommand() {
    const command = S.access.command || S.commands;
    const code = $('#commandCode');
    if (!code) return;
    const host = $('#accessHost')?.value.trim() || '';
    if (!host || !command) {
      code.innerHTML = '';
      code.dataset.raw = '';
      const target = $('#cmdTarget');
      if (target) target.textContent = '填写服务器地址后生成，可直接粘贴到 Mac 终端执行。';
      return;
    }
    const map = { single: command.single, onepass: command.onepass, steps: command.steps, sshconfig: command.sshconfig };
    const text = map[S.access.tab] || command.onepass || '';
    code.innerHTML = highlightShell(text);
    code.dataset.raw = text;
    $$('#commandTabs .tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === S.access.tab));
    const notes = {
      single: '单条 SSH 写入命令：读取本机公钥后幂等写入 authorized_keys',
      onepass: '在 macOS 终端 中执行，会提示一次服务器密码',
      steps: '按步骤执行，适合排查或只做其中一部分',
      sshconfig: '直接连接命令，不修改系统 SSH 配置'
    };
    $('#codeNote').textContent = notes[S.access.tab] || '';
    const target = $('#cmdTarget');
    if (target && command.target) target.textContent = `为 ${command.target} 生成，可直接粘贴到 Mac 终端执行。`;
  }

  /* ------------------------------------------------------------
     Logs
     ------------------------------------------------------------ */
  function renderLogSources() {
    if (S.logs.source !== 'all' && S.logs.source !== 'panel' && !S.tunnels.some((t) => t.id === S.logs.source)) {
      S.logs.source = 'all';
    }
    const holder = $('#logSources');
    if (!holder) return;
    const sources = [{ id: 'all', name: '全部日志', iconName: 'list' }, { id: 'panel', name: '面板', iconName: 'grid' }]
      .concat(S.tunnels.map((t) => ({ id: t.id, name: t.name, iconName: 'route', status: (S.runtime[t.id] || {}).status })));
    $('#logSourceCount').textContent = sources.length;
    holder.innerHTML = sources.map((s) => {
      const active = S.logs.source === s.id ? 'is-active' : '';
      const dot = s.status === 'online' ? '<span class="src-dot"></span>' : '';
      return `<button class="log-source ${active}" data-source="${esc(s.id)}">${icon(s.iconName)}<span>${esc(s.name)}</span>${dot}</button>`;
    }).join('');
    $$('#logSources .log-source').forEach((btn) => btn.addEventListener('click', () => {
      S.logs.source = btn.dataset.source;
      S.logs.loaded = false;
      renderLogSources();
      resetLogs();
      loadLogs(true);
      const t = S.tunnels.find((x) => x.id === S.logs.source);
      $('#logTitle').textContent = t ? `tunnel / ${t.name}` : S.logs.source === 'panel' ? 'panel / 面板' : 'all / 全部日志';
      $('#logFootSource').textContent = t ? t.name : S.logs.source === 'panel' ? '面板' : '全部日志';
    }));
  }

  function resetLogs() {
    S.logs.lines = [];
    S.logs.lastId = 0;
    S.logs.loaded = false;
    const box = $('#logConsole');
    if (box) box.innerHTML = `<div class="console-empty" id="logEmpty">${icon('terminal')}<p>等待日志…</p></div>`;
    $('#logCount').textContent = '0 行';
  }

  function filteredLogLines() {
    const level = S.logs.level;
    const q = S.logs.query.trim().toLowerCase();
    return S.logs.lines.filter((line) => {
      if (level !== 'all' && line.level !== level) return false;
      if (q && !(`${line.text} ${line.source}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function logLineHtml(line) {
    const cls = line.level === 'warn' ? 'warn' : line.level === 'error' ? 'error' : line.level === 'success' ? 'success' : line.level === 'debug' ? 'debug' : 'info';
    return `<div class="log-line level-${line.level}" data-line-id="${line.id}">
      <span class="log-time">${timeOf(line.ts)}</span>
      <span class="log-level ${cls}">${LEVEL_TEXT[line.level] || line.level}</span>
      <span class="log-src" title="${esc(line.source)}">${esc(line.source)}</span>
      <span class="log-text">${esc(line.text)}</span>
    </div>`;
  }

  function renderConsole({ incremental = false } = {}) {
    const box = $('#logConsole');
    if (!box) return;
    const lines = filteredLogLines();
    const previousScroll = box.scrollTop;
    $('#logCount').textContent = `${lines.length} 行`;
    if (!lines.length) {
      box.innerHTML = `<div class="console-empty">${icon('terminal')}<p>没有匹配的日志</p></div>`;
      return;
    }
    box.innerHTML = lines.map(logLineHtml).join('');
    if (S.logs.follow) box.scrollTop = box.scrollHeight;
    else box.scrollTop = Math.min(previousScroll, box.scrollHeight - box.clientHeight);
  }

  async function loadLogs(reset = false) {
    if (reset) {
      S.logs.lines = [];
      S.logs.lastId = 0;
    }
    const source = S.logs.source;
    try {
      const data = await api(`/api/logs?source=${encodeURIComponent(source)}&since=${S.logs.lastId}&limit=300`);
      const lines = data.lines || [];
      if (lines.length) {
        const existing = new Set(S.logs.lines.map((l) => l.id));
        lines.forEach((line) => { if (!existing.has(line.id)) S.logs.lines.push(line); });
        S.logs.lines.sort((a, b) => a.id - b.id);
        if (S.logs.lines.length > 900) S.logs.lines = S.logs.lines.slice(-900);
      }
      if (Number(data.lastId) > S.logs.lastId) S.logs.lastId = Number(data.lastId);
      S.logs.loaded = true;
      renderConsole({ incremental: !reset });
    } catch (error) {
      if (S.view === 'logs') toast('error', '日志读取失败', error.message);
    }
  }

  function startLogsPolling() {
    if (S.logs.timer) clearInterval(S.logs.timer);
    S.logs.timer = setInterval(() => {
      if (S.view !== 'logs' || document.visibilityState !== 'visible') return;
      loadLogs(false);
    }, 2000);
  }

  function downloadLogs() {
    const lines = filteredLogLines();
    if (!lines.length) { toast('warning', '没有可下载的日志', ''); return; }
    const text = lines.map((l) => `[${new Date(l.ts).toLocaleString('zh-CN', { hour12: false })}] [${(LEVEL_TEXT[l.level] || l.level)}] [${l.source}] ${l.text}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tunnel-studio-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  /* ------------------------------------------------------------
     Command palette
     ------------------------------------------------------------ */
  const NAV_ITEMS = [
    ['overview', '总览', 'grid'], ['tunnels', '隧道', 'route'], ['servers', '服务器', 'server'],
    ['logs', '运行日志', 'terminal'], ['access', '免密登录', 'key'], ['settings', '设置', 'settings']
  ];

  function paletteItems() {
    const items = [];
    NAV_ITEMS.forEach(([view, label, iconName]) => items.push({
      group: '跳转', label, hint: `打开${label}页面`, icon: iconName,
      action: () => setView(view)
    }));
    items.push(
      { group: '操作', label: '新建隧道', hint: '创建一条端口映射', icon: 'plus', action: () => openTunnelModal() },
      { group: '操作', label: '添加服务器', hint: '配置 SSH 目标', icon: 'server', action: () => openServerModal() },
      { group: '操作', label: '全部开启', hint: '开启所有隧道', icon: 'play', action: () => batchAll('open') },
      { group: '操作', label: '全部关闭', hint: '关闭所有隧道', icon: 'stop', action: () => batchAll('close') },
      { group: '操作', label: '刷新状态', hint: '立即同步隧道状态', icon: 'refresh', action: () => pollState(true) },
      { group: '操作', label: '切换主题', hint: '深色 / 浅色', icon: 'moon', action: toggleTheme },
      { group: '操作', label: '导出配置', hint: '下载 JSON', icon: 'download', action: exportConfig }
    );
    S.tunnels.forEach((t) => {
      const state = S.runtime[t.id] || {};
      const online = state.status === 'online';
      items.push({
        group: '隧道', label: t.name, hint: `${t.localPort} → ${(t.server || {}).host || ''}:${t.remotePort}`,
        icon: 'route', action: () => { setView('overview'); openDrawer(t.id); }
      });
      items.push({
        group: '隧道', label: `${online ? '关闭' : '开启'} ${t.name}`,
        hint: online ? '停止转发' : '开始转发', icon: online ? 'stop' : 'play',
        action: () => toggleTunnel(t.id, !online)
      });
    });
    S.servers.forEach((s) => {
      items.push({
        group: '服务器', label: `测试 ${s.name}`, hint: `${s.user}@${s.host}:${s.port}`,
        icon: 'zap', action: () => testServer(s.id)
      });
    });
    return items;
  }

  function openPalette() {
    if (S.palette.open) return;
    S.palette.open = true;
    S.palette.query = '';
    S.palette.selected = 0;
    const root = $('#paletteRoot');
    root.innerHTML = `<div class="palette-overlay" id="paletteOverlay">
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="palette-input">${icon('search')}<input id="paletteInput" placeholder="搜索隧道、服务器或操作…" autocomplete="off" spellcheck="false"><kbd>ESC</kbd></div>
        <div class="palette-list" id="paletteList"></div>
        <div class="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 执行</span>
          <span class="foot-right">Tunnel Studio 命令面板</span>
        </div>
      </div>
    </div>`;
    document.body.classList.add('no-scroll');
    const input = $('#paletteInput');
    input.addEventListener('input', () => { S.palette.query = input.value; S.palette.selected = 0; renderPalette(); });
    input.addEventListener('keydown', (event) => {
      const items = S.palette.items;
      if (event.key === 'ArrowDown') { event.preventDefault(); S.palette.selected = Math.min(items.length - 1, S.palette.selected + 1); renderPalette(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); S.palette.selected = Math.max(0, S.palette.selected - 1); renderPalette(); }
      else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(); }
    });
    $('#paletteOverlay').addEventListener('mousedown', (e) => { if (e.target.id === 'paletteOverlay') closePalette(); });
    renderPalette();
    setTimeout(() => input.focus(), 30);
  }
  function closePalette() {
    if (!S.palette.open) return;
    S.palette.open = false;
    $('#paletteRoot').innerHTML = '';
    if (!$('#modalRoot')?.children.length && !document.querySelector('.drawer.is-open')) document.body.classList.remove('no-scroll');
  }
  function highlightQuery(text, query) {
    if (!query) return esc(text);
    const lower = String(text).toLowerCase();
    const q = query.toLowerCase();
    let out = '';
    let index = 0;
    for (;;) {
      const found = lower.indexOf(q, index);
      if (found === -1) { out += esc(String(text).slice(index)); break; }
      out += esc(String(text).slice(index, found));
      out += `<mark>${esc(String(text).slice(found, found + q.length))}</mark>`;
      index = found + q.length;
      if (index >= String(text).length) break;
    }
    return out;
  }

  function renderPalette() {
    const q = S.palette.query.trim().toLowerCase();
    let items = paletteItems();
    if (q) {
      items = items.filter((i) => `${i.label} ${i.hint} ${i.group}`.toLowerCase().includes(q));
    }
    S.palette.items = items;
    S.palette.selected = clamp(S.palette.selected, 0, Math.max(0, items.length - 1));
    const list = $('#paletteList');
    if (!items.length) { list.innerHTML = `<div class="palette-empty">没有匹配的命令</div>`; return; }
    let html = '';
    let lastGroup = '';
    items.forEach((item, index) => {
      if (item.group !== lastGroup) {
        html += `<div class="palette-group">${esc(item.group)}</div>`;
        lastGroup = item.group;
      }
      const label = q ? highlightQuery(item.label, q) : esc(item.label);
      html += `<button class="palette-item ${index === S.palette.selected ? 'is-selected' : ''}" data-index="${index}">
        <span class="p-icon">${icon(item.icon)}</span>
        <span class="p-text"><strong>${label}</strong><small>${esc(item.hint)}</small></span>
        <span class="p-meta">${icon('corner-down')}</span>
      </button>`;
    });
    list.innerHTML = html;
    $$('.palette-item', list).forEach((btn) => {
      btn.addEventListener('mouseenter', () => { S.palette.selected = Number(btn.dataset.index); $$('.palette-item', list).forEach((b) => b.classList.toggle('is-selected', b === btn)); });
      btn.addEventListener('click', () => { S.palette.selected = Number(btn.dataset.index); runPaletteItem(); });
    });
    const selected = $(`.palette-item[data-index="${S.palette.selected}"]`, list);
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }
  function runPaletteItem() {
    const item = S.palette.items[S.palette.selected];
    if (!item) return;
    closePalette();
    setTimeout(() => item.action(), 80);
  }

  /* ------------------------------------------------------------
     Help & shortcuts
     ------------------------------------------------------------ */
  function openShortcuts() {
    const rows = [
      ['Ctrl / ⌘ + K', '打开命令面板'],
      ['N', '新建隧道'],
      ['/', '聚焦命令面板'],
      ['Esc', '关闭弹窗 / 抽屉 / 面板'],
      ['Enter', '在命令面板中执行选中项'],
      ['↑ / ↓', '在命令面板中移动']
    ];
    openModal({
      title: '键盘快捷键',
      subtitle: '在不离开键盘的情况下控制隧道。',
      body: `<div style="display:flex;flex-direction:column;gap:2px">${rows.map(([key, desc]) => `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 2px;border-bottom:1px solid var(--border-soft)"><span style="font-size:12px;color:var(--text-2)">${desc}</span><kbd style="height:24px;padding:0 8px">${key}</kbd></div>`).join('')}</div>
        <div class="wizard-tip" style="margin-top:14px">${icon('info')}<p>面板只监听 <strong>127.0.0.1</strong>，不会暴露到局域网；所有修改请求都需要页面令牌。</p></div>`,
      footer: `<button class="btn btn-primary" data-modal-cancel>知道了</button>`,
      onMount(root, close) { $('[data-modal-cancel]', root).addEventListener('click', close); }
    });
  }

  /* ------------------------------------------------------------
     Misc actions
     ------------------------------------------------------------ */
  async function testServer(id) {
    const s = S.servers.find((x) => x.id === id);
    if (!s) return;
    const card = document.querySelector(`.server-card[data-server-id="${id}"]`);
    const resultEl = card?.querySelector('[data-live="test"]');
    if (resultEl) { resultEl.className = 'test-result'; resultEl.textContent = '测试中…'; }
    try {
      const res = await api(`/api/servers/${encodeURIComponent(id)}/test`, { method: 'POST' });
      S.testResults[id] = res;
      if (resultEl) {
        resultEl.className = `test-result ${res.ok ? 'ok' : 'bad'}`;
        resultEl.textContent = res.simulation ? '演示结果 · 未连接' : res.ok ? `${res.ms} ms · TCP` : (res.error || '不可达');
      }
      toast(res.ok ? 'success' : 'error', res.simulation ? '演示：未连接服务器' : (res.ok ? 'SSH 端口可达（未验证认证）' : '服务器不可达'), `${s.name} · ${res.ok ? res.ms + ' ms' : res.error}`);
    } catch (error) {
      if (resultEl) { resultEl.className = 'test-result bad'; resultEl.textContent = '失败'; }
      toast('error', '测试失败', error.message);
    }
  }

  async function showServerCommand(id) {
    const s = S.servers.find((x) => x.id === id);
    if (!s) return;
    try {
      const res = await api(`/api/servers/${encodeURIComponent(id)}/command`, { method: 'POST' });
      const cmd = res.command;
      openModal({
        title: '服务器 macOS 终端命令',
        subtitle: `${s.user}@${s.host}:${s.port} · 一键免密配置`,
        wide: true,
        body: `<div class="code-shell"><div class="code-bar"><span class="code-lang">${icon('command')}shell</span><span class="code-note">单条 SSH 写入命令 · 在 macOS 终端 中执行</span></div><pre><code>${highlightShell(cmd.single || cmd.onepass)}</code></pre></div>`,
        footer: `<button class="btn btn-ghost" data-modal-cancel>关闭</button><button class="btn btn-primary" id="cmdCopy">${icon('copy')}复制命令</button>`,
        onMount(root, close) {
          $('[data-modal-cancel]', root).addEventListener('click', close);
          $('#cmdCopy', root).addEventListener('click', () => copyText(cmd.single || cmd.onepass, '单条 SSH 命令已复制'));
        }
      });
    } catch (error) { toast('error', '命令生成失败', error.message); }
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    syncThemeToServer();
  }

  async function batchAll(action) {
    if (!S.tunnels.length) { toast('info', '暂无隧道', ''); return; }
    if (action === 'close') {
      const active = S.tunnels.filter((t) => ['online', 'connecting'].includes((S.runtime[t.id] || {}).status));
      if (!active.length) { toast('info', '没有运行中的隧道', ''); return; }
    }
    try {
      const res = await api('/api/batch', { method: 'POST', body: { action, ids: S.tunnels.map((t) => t.id) } });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) {
        toast('warning', `有 ${failed.length} 条隧道未完成`, failed.slice(0, 3).map((f) => f.error).join('；'), 4800);
      } else {
        toast('success', action === 'open' ? '正在开启全部隧道' : '正在关闭全部隧道', `${S.tunnels.length} 条映射`);
      }
      scheduleRefresh(400);
    } catch (error) { toast('error', '操作失败', error.message); }
  }

  async function testServerById(id) { return testServer(id); }

  async function importFileChange(file) { await importConfig(file); }

  async function shutdownPanel() {
    const ok = await confirmAction({
      title: '停止面板服务',
      message: '停止后此页面将无法继续同步状态。',
      detail: '停止面板会同时关闭本面板创建的 SSH 隧道；其他项目的进程保持独立。重新运行 bin/start.sh 可启动。',
      confirmText: '停止面板',
      danger: true
    });
    if (!ok) return;
    try {
      const res = await api('/api/shutdown', { method: 'POST' });
      toast('info', '面板正在关闭', res.message || '', 4000);
    } catch (error) {
      toast('error', '停止失败', error.message);
    }
    stopPolling();
    setConnection(false);
    setTimeout(() => showBootError('面板服务已停止。重新运行 bin/start.sh 即可恢复。'), 600);
  }

  async function resetPanel() {
    const ok = await confirmAction({
      title: '重置面板配置',
      message: '这会永久删除全部服务器与隧道映射。',
      detail: '日志与设置会保留，清空前自动备份配置到 data/sync。可通过配置导入恢复备份中的 config。',
      confirmText: '确认重置',
      danger: true,
      requireText: 'RESET'
    });
    if (!ok) return;
    try {
      await api('/api/reset', { method: 'POST' });
      S.selection.clear();
      closeDrawer();
      await reloadBootstrap();
      toast('success', '面板已重置', '服务器与隧道列表已清空');
    } catch (error) { toast('error', '重置失败', error.message); }
  }

  /* ------------------------------------------------------------
     Toasts & copy
     ------------------------------------------------------------ */
  function toast(type, title, message = '', duration = 3200, action = null) {
    const stack = $('#toasts');
    if (!stack) return;
    const icons = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icon(icons[type] || 'info')}</span>
      <div class="toast-body"><strong>${esc(title)}</strong>${message ? `<span>${esc(message)}</span>` : ''}</div>
      ${action ? `<button class="toast-action">${esc(action.label)}</button>` : ''}
      <button class="toast-close" aria-label="关闭">${icon('x')}</button>
      <span class="toast-progress" style="animation-duration:${duration}ms"></span>`;
    stack.appendChild(el);
    const remove = () => {
      if (!el.isConnected) return;
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 260);
    };
    el.querySelector('.toast-close').addEventListener('click', remove);
    if (action) el.querySelector('.toast-action').addEventListener('click', () => { action.onClick(); remove(); });
    setTimeout(remove, duration);
    while (stack.children.length > 4) stack.firstElementChild.remove();
  }

  async function copyText(text, successMessage = '已复制到剪贴板') {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('success', successMessage, '', 2000);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast('success', successMessage, '', 2000); }
      catch { toast('error', '复制失败', '请手动选择文本'); }
      area.remove();
    }
  }

  /* ------------------------------------------------------------
     Polling
     ------------------------------------------------------------ */
  function startPolling() {
    stopPolling();
    const ms = clamp(Number(S.settings.refreshMs) || 1500, 700, 15000);
    S.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') pollState();
    }, ms);
  }
  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }
  function restartPolling() { if (S.ready) startPolling(); }
  function scheduleRefresh(delay = 300) {
    setTimeout(() => pollState(true), delay);
  }
  async function pollState(force = false) {
    if (!S.ready || S.pollBusy) return;
    S.pollBusy = true;
    try {
      const data = await api('/api/state');
      const prevTunnelSig = S.tunnelSig;
      const prevServerSig = S.serverSig;
      const prevSig = S.configSig;
      S.runtime = data.runtime || S.runtime;
      S.metrics = data.metrics || S.metrics;
      S.servers = data.servers || S.servers;
      S.simulation = !!data.simulation;
      S.sshAvailable = !!data.sshAvailable;
      S.autostart = data.autostart || S.autostart;
      applyServerSignature();
      updateLive();
      if (force) S.activity = data.activity || S.activity;
      else if (data.activity) {
        const incoming = data.activity;
        const currentMax = Math.max(0, ...incoming.map((a) => Number(a.id) || 0));
        if (currentMax > S.activityMax) {
          S.activity = incoming;
          renderActivity();
        }
      }
      S.failCount = 0;
      setConnection(true);
    } catch (error) {
      S.failCount++;
      setConnection(false);
      if (force) toast('error', '无法刷新状态', error.message);
      if (S.failCount === 3) toast('warning', '面板连接中断', '请确认 bin/start.sh 仍在运行。');
    } finally {
      S.pollBusy = false;
    }
  }
  function applyServerSignature() {
    // keep signature fields for future structural polling
  }

  /* ------------------------------------------------------------
     Routing
     ------------------------------------------------------------ */
  function currentRoute() {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    return Object.prototype.hasOwnProperty.call(VIEW_META, hash) ? hash : 'overview';
  }
  function setView(view, { silent = false } = {}) {
    const next = Object.prototype.hasOwnProperty.call(VIEW_META, view) ? view : 'overview';
    S.view = next;
    $$('.view').forEach((section) => {
      const active = section.dataset.view === next;
      section.hidden = !active;
      section.classList.toggle('is-active', active);
    });
    $$('.nav-item[data-nav]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.nav === next));
    $('#crumbCurrent').textContent = VIEW_META[next].crumb;
    document.title = `${VIEW_META[next].title} · Tunnel Studio`;
    if (next === 'logs') {
      S.logs.loaded = true;
      const label = S.logs.source === 'all' ? '全部日志' : S.logs.source === 'panel' ? '面板' : (S.tunnels.find((t) => t.id === S.logs.source) || {}).name || '全部日志';
      $('#logTitle').textContent = `${S.logs.source === 'all' ? 'all' : 'tunnel'} / ${label}`;
      loadLogs(!S.logs.lines.length);
    }
    if (next === 'access') {
      updateAccessCommand();
    }
    if (next === 'settings') {
      renderSettings();
    }
    $('#app').classList.remove('nav-open');
    if (!silent) {
      window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
      if (location.hash !== `#/${next}`) history.replaceState(null, '', `#/${next}`);
    }
  }
  function handleRoute(initial = false) {
    const view = currentRoute();
    setView(view, { silent: true });
    if (initial && view === 'overview') {
      $$('.view').forEach((s) => s.classList.toggle('is-active', s.dataset.view === 'overview'));
    }
  }
  function navigate(view) {
    if (view === S.view) return;
    location.hash = `#/${view}`;
    setView(view);
  }

  /* ------------------------------------------------------------
     Events
     ------------------------------------------------------------ */
  function bindEvents() {
    TunnelWorkbench.init({newTunnel: openTunnelModal, cardClick: handleTunnelCardClick, openDrawer, renderLayout: renderTunnelGrid});
    // Navigation
    document.addEventListener('click', (event) => {
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        event.preventDefault();
        navigate(nav.dataset.nav);
        closePalette();
      }
      const actionNew = event.target.closest('[data-action="new-tunnel"]');
      if (actionNew) { event.preventDefault(); openTunnelModal(); }
      const reloadBtn = event.target.closest('[data-action="reload"]');
      if (reloadBtn) { event.preventDefault(); location.reload(); }
      const openServer = event.target.closest('[data-action="open-server"]');
      if (openServer) {
        const s = S.servers.find((x) => x.id === openServer.dataset.serverId);
        if (s) {
          const tunnels = S.tunnels.filter((t) => t.serverId === s.id);
          if (tunnels.length) { setView('tunnels'); S.tunnelSearch = ''; $('#tunnelSearch').value = ''; S.groupFilter = 'all'; S.tunnelFilter = 'all'; renderGroupFilter(); applyTunnelFilter(); }
          else toast('info', s.name, '该服务器还没有隧道映射。');
        }
      }
    });

    // Overview filter chips
    $('#overviewFilterChips')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-filter-status]');
      if (!chip) return;
      S.overviewFilter = chip.dataset.filterStatus;
      applyOverviewFilter();
    });

    // Tunnel grid interactions
    $('#tunnelGrid')?.addEventListener('click', (event) => handleTunnelCardClick(event));
    $('#tunnelGrid')?.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('tunnel-card')) {
        event.preventDefault();
        openDrawer(event.target.dataset.id);
      }
    });
    document.addEventListener('pointermove', (event) => {
      const card = event.target.closest('.tunnel-card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    }, { passive: true });

    // Tunnels page
    $('#statusFilter')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-filter-status]');
      if (!chip) return;
      S.tunnelFilter = chip.dataset.filterStatus;
      applyTunnelFilter();
    });
    $('#groupFilter')?.addEventListener('change', (event) => {
      S.groupFilter = event.target.value;
      applyTunnelFilter();
    });
    let searchTimer = null;
    $('#tunnelSearch')?.addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.tunnelSearch = event.target.value;
        applyTunnelFilter();
      }, 120);
    });
    $('#selectAllTunnels')?.addEventListener('change', (event) => {
      const visible = S.tunnels.filter(tunnelMatches);
      if (event.target.checked) visible.forEach((t) => S.selection.add(t.id));
      else visible.forEach((t) => S.selection.delete(t.id));
      renderBatchBar();
    });
    $('#tunnelTableBody')?.addEventListener('click', (event) => {
      const cb = event.target.closest('[data-select]');
      if (cb) {
        if (cb.checked) S.selection.add(cb.dataset.select);
        else S.selection.delete(cb.dataset.select);
        renderBatchBar();
        return;
      }
      const row = event.target.closest('.t-row');
      if (!row) return;
      if (event.target.closest('button, .switch, label')) return;
      openDrawer(row.dataset.rowId);
    });
    $('#tunnelTableBody')?.addEventListener('change', (event) => {
      const toggle = event.target.closest('[data-role="toggle"]');
      if (!toggle) return;
      const row = toggle.closest('.t-row');
      if (!row) return;
      toggleTunnel(row.dataset.rowId, toggle.checked);
    });
    $('#tunnelTableBody')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      const row = btn.closest('.t-row');
      if (!row) return;
      event.stopPropagation();
      const id = row.dataset.rowId;
      if (btn.dataset.act === 'logs') { setView('logs'); S.logs.source = id; renderLogSources(); resetLogs(); loadLogs(true); }
      if (btn.dataset.act === 'edit') { const t = S.tunnels.find((x) => x.id === id); if (t) openTunnelModal(t); }
    });
    $('#tunnelTableBody')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.classList.contains('t-row')) openDrawer(event.target.dataset.rowId);
    });
    $('#tunnelMobileList')?.addEventListener('click', (event) => handleTunnelCardClick(event));

    $('#btnOpenAll')?.addEventListener('click', () => batchAll('open'));
    $('#btnCloseAll')?.addEventListener('click', () => batchAll('close'));
    $('#btnCloseAll2')?.addEventListener('click', () => batchAll('close'));
    $('#btnRefresh')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget.querySelector('.icon');
      btn?.classList.add('spin');
      await pollState(true);
      setTimeout(() => btn?.classList.remove('spin'), 600);
      toast('info', '状态已刷新', '');
    });
    $('#btnNewTunnel')?.addEventListener('click', () => openTunnelModal());
    $('#btnNewTunnelPage')?.addEventListener('click', () => openTunnelModal());
    $$('#tunnelTableEmpty [data-action="new-tunnel"]').forEach((btn) => btn.addEventListener('click', () => openTunnelModal()));
    $('#btnNewServer')?.addEventListener('click', () => openServerModal());
    $('#btnNewServer2')?.addEventListener('click', () => openServerModal());
    $('#btnBatchOpen')?.addEventListener('click', () => batchAction('open'));
    $('#btnBatchClose')?.addEventListener('click', () => batchAction('close'));
    $('#btnBatchDelete')?.addEventListener('click', () => batchAction('delete'));
    $('#btnBatchClear')?.addEventListener('click', () => { S.selection.clear(); renderBatchBar(); });

    // Servers page
    $('#serverGrid')?.addEventListener('click', (event) => {
      const card = event.target.closest('.server-card');
      if (!card) return;
      const id = card.dataset.serverId;
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'test') testServer(id);
      if (btn.dataset.act === 'command') showServerCommand(id);
      if (btn.dataset.act === 'edit') openServerModal(S.servers.find((s) => s.id === id));
      if (btn.dataset.act === 'delete') deleteServer(id);
    });

    // Drawer
    $('#scrim')?.addEventListener('click', closeDrawer);

    // Settings theme / accent
    $('#themeSegment')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-theme-value]');
      if (!btn) return;
      applyTheme(btn.dataset.themeValue);
      syncThemeToServer();
    });
    $('#accentRow')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-accent-value]');
      if (!btn) return;
      applyAccent(btn.dataset.accentValue);
      syncThemeToServer();
    });
    $('#btnTheme')?.addEventListener('click', toggleTheme);
    $('#btnHelp')?.addEventListener('click', openShortcuts);
    $('#btnPalette')?.addEventListener('click', openPalette);

    // Settings forms
    bindSettingSwitches();
    $$('[data-setting-input]').forEach((input) => input.addEventListener('input', markSettingsDirty));
    $('#btnSaveSettings')?.addEventListener('click', saveSettingsInputs);
    $('#btnResetSettings')?.addEventListener('click', () => { renderSettings(); toast('info', '已撤销未保存的修改', '', 1800); });
    $('#autostartToggle')?.addEventListener('change', (event) => toggleAutostart(event.target.checked));
    $('#btnCopyAutostart')?.addEventListener('click', () => copyText(S.autostart.expected || '', '启动命令已复制'));
    $('#btnExportConfig')?.addEventListener('click', exportConfig);
    $('#btnImportConfig')?.addEventListener('click', () => $('#importFile').click());
    $('#importFile')?.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importConfig(file);
    });
    $('#btnOpenData')?.addEventListener('click', () => openFolder('data'));
    $('#btnOpenLogs')?.addEventListener('click', () => openFolder('logs'));
    $('#btnResetPanel')?.addEventListener('click', resetPanel);
    $('#btnShutdownPanel')?.addEventListener('click', shutdownPanel);

    // Logs
    $('#logLevelFilters')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-level]');
      if (!chip) return;
      S.logs.level = chip.dataset.level;
      $$('#logLevelFilters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderConsole();
    });
    let logSearchTimer = null;
    $('#logSearch')?.addEventListener('input', (event) => {
      clearTimeout(logSearchTimer);
      logSearchTimer = setTimeout(() => { S.logs.query = event.target.value; renderConsole(); }, 120);
    });
    $('#logFollowBtn')?.addEventListener('click', () => {
      S.logs.follow = !S.logs.follow;
      $('#logFollowBtn').dataset.follow = S.logs.follow ? 'on' : 'off';
      $('#logFollowBtn').innerHTML = `<span class="live-dot"></span>${S.logs.follow ? '跟随' : '暂停'}`;
      if (S.logs.follow) { const box = $('#logConsole'); box.scrollTop = box.scrollHeight; }
    });
    $('#btnLogCopy')?.addEventListener('click', () => {
      const text = filteredLogLines().map((l) => `[${timeOf(l.ts)}] [${l.level.toUpperCase()}] [${l.source}] ${l.text}`).join('\n');
      copyText(text, '日志已复制');
    });
    $('#btnLogDownload')?.addEventListener('click', downloadLogs);
    $('#btnLogClear')?.addEventListener('click', async () => {
      const ok = await confirmAction({ title: '清空日志', message: '仅清空面板内存中的日志缓冲区，不会删除磁盘日志。', confirmText: '清空', danger: true });
      if (!ok) return;
      try {
        await api('/api/logs/clear', { method: 'POST' });
        resetLogs();
        toast('success', '日志已清空', '');
      } catch (error) { toast('error', '清空失败', error.message); }
    });
    $('#btnClearActivity')?.addEventListener('click', async () => {
      try {
        await api('/api/activity/clear', { method: 'POST' });
        S.activity = [];
        S.activityMax = 0;
        renderActivity(true);
        pollState();
      } catch (error) { toast('error', '清空失败', error.message); }
    });

    // Access
    $('#accessForm')?.addEventListener('submit', (event) => { event.preventDefault(); startAccess(); });
    $('#btnCommandOnly')?.addEventListener('click', async () => {
      await updateAccessCommand({ immediate: true });
      $('#commandPanel').scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'center' });
      toast('info', '命令已生成', '命令需在 Mac 终端手动执行；向导不会修改服务器。');
    });
    $('#btnTogglePassword')?.addEventListener('click', () => {
      const input = $('#accessPassword');
      const wrap = $('.input-with-action');
      const next = input.type === 'password' ? 'text' : 'password';
      input.type = next;
      wrap?.classList.toggle('is-revealed', next === 'text');
    });
    ['accessHost', 'accessPort', 'accessUser', 'accessKeyPath', 'accessAlias'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', updateAccessCommand);
    });
    $('#commandTabs')?.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      S.access.tab = tab.dataset.tab;
      renderCommand();
    });
    $('#btnCopyCommand')?.addEventListener('click', async () => {
      await updateAccessCommand({ immediate: true });
      const code = $('#commandCode');
      copyText(code?.dataset.raw || code?.textContent || '', 'Shell 命令已复制');
    });
    $('#btnCopyCommandClean')?.addEventListener('click', async () => {
      await updateAccessCommand({ immediate: true });
      const code = $('#commandCode');
      const raw = code?.dataset.raw || code?.textContent || '';
      copyText(raw.split('\n').filter(line => !/^\s*#/.test(line)).join('\n'), '纯命令已复制（已移除注释）');
    });

    // Global keyboard
    document.addEventListener('keydown', (event) => {
      const tag = (event.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (S.palette.open) closePalette(); else openPalette();
        return;
      }
      if (event.key === 'Escape') {
        if (S.palette.open) closePalette();
        else if ($('#modalRoot')?.children.length) closeModal();
        else if (document.querySelector('.drawer.is-open')) closeDrawer();
        return;
      }
      if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === 'n' || event.key === 'N') { event.preventDefault(); openTunnelModal(); }
        if (event.key === '/') { event.preventDefault(); openPalette(); }
        if (event.key === '?') { event.preventDefault(); openShortcuts(); }
      }
    });

    // Hash routing
    window.addEventListener('hashchange', () => setView(currentRoute()));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.ready) pollState(true);
    });

    // Close mobile nav on scrim? use rail click outside
    document.addEventListener('click', (event) => {
      if ($('#app').classList.contains('nav-open') && !event.target.closest('.rail') && !event.target.closest('#btnNavMobile')) {
        $('#app').classList.remove('nav-open');
      }
    });
    $('#btnNavMobile')?.addEventListener('click', () => {
      $('#app').classList.toggle('nav-open');
    });
  }

  function handleTunnelCardClick(event) {
    const card = event.target.closest('.tunnel-card');
    if (!card) return;
    const id = card.dataset.id;
    const actBtn = event.target.closest('[data-act]');
    if (actBtn) {
      event.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === 'logs') {
        setView('logs');
        S.logs.source = id;
        renderLogSources();
        resetLogs();
        loadLogs(true);
      } else if (act === 'edit') {
        const t = S.tunnels.find((x) => x.id === id);
        if (t) openTunnelModal(t);
      } else if (act === 'open-url') {
        const t = S.tunnels.find((x) => x.id === id);
        if (t) openTunnelPanel(t);
      } else if (act === 'connection') {
        const t = S.tunnels.find((x) => x.id === id);
        if (t) showTunnelConnection(t);
      } else if (act === 'port') {
        const t = S.tunnels.find((x) => x.id === id);
        if (t) showPortDiagnosis(t);
      } else if (act === 'copy') {
        const t = S.tunnels.find((x) => x.id === id);
        if (t) { if (t.kind === 'dedicated') copyText(`http://127.0.0.1:${t.localPort}`, '已复制代理地址'); else copyLocal(t); }
      } else if (act === 'menu') {
        openDrawer(id, 'settings');
      } else if (act === 'toggle') {
        // handled by change event; ignore click
      }
      return;
    }
    if (event.target.closest('input, label')) return;
    openDrawer(id);
  }

  async function deleteServer(id) {
    const s = S.servers.find((x) => x.id === id);
    if (!s) return;
    const linked = S.tunnels.filter((t) => t.serverId === id);
    if (linked.length) {
      toast('warning', '无法删除服务器', `仍有 ${linked.length} 条隧道关联到「${s.name}」，请先删除或迁移它们。`);
      return;
    }
    const ok = await confirmAction({
      title: '删除服务器',
      message: `确定删除「${s.name}」吗？`,
      detail: `${s.user}@${s.host}:${s.port}。密钥文件不会被删除。`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await reloadBootstrap();
      toast('success', '服务器已删除', s.name);
    } catch (error) { toast('error', '删除失败', error.message); }
  }

  async function openFolder(kind) {
    try { await api('/api/open-folder', { method: 'POST', body: { kind } }); }
    catch (error) { toast('error', '无法打开目录', error.message); }
  }

  function startClock() {
    updateClock();
    setInterval(updateClock, 20000);
  }
  function updateClock() {
    $$('.activity-title time').forEach((time) => {
      const iso = time.getAttribute('datetime');
      if (iso) time.textContent = relTime(iso);
    });
  }

  // Change handler for tunnel toggles rendered inside cards (both overview and mobile list)
  document.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-role="toggle"]');
    if (!toggle) return;
    const card = toggle.closest('.tunnel-card');
    const row = toggle.closest('.t-row');
    const id = card ? card.dataset.id : row ? row.dataset.rowId : null;
    if (!id) return;
    toggleTunnel(id, toggle.checked);
  });

  // Expose a tiny debug hook for local verification.
  window.__TUNNEL_STUDIO__ = { state: S, api, pollState };

  boot();
})();
