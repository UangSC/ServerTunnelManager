/* Windows / macOS 共用的隧道布局、操作菜单与专用代理配置。 */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const routes = {unknown:'未标记', direct:'直连 ISP', vpn:'中转 → ISP'};
  const fields = ['kind','proxyAccount','ispId','proxyExitIp','proxyRoute'];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /* ---------------- 操作菜单 ---------------- */
  /* 行/卡片只保留“开关 + 更多”，其余功能集中到同一个菜单里，
     避免每条隧道因为可用按钮不同而出现高低不齐的按钮堆。 */
  let menuState = null;

  function closeMenu({ restoreFocus = false } = {}) {
    if (!menuState) return;
    const state = menuState;
    menuState = null;
    document.removeEventListener('pointerdown', state.onPointerDown, true);
    document.removeEventListener('keydown', state.onKeyDown, true);
    window.removeEventListener('resize', state.onReposition);
    window.removeEventListener('scroll', state.onReposition, true);
    try { state.root.remove(); } catch { /* 已被移除 */ }
    if (state.anchor && state.anchor.isConnected) {
      state.anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus) state.anchor.focus({ preventScroll: true });
    }
  }

  function openMenu(anchor, items, onSelect) {
    const visible = (items || []).filter(Boolean);
    if (!anchor || !visible.length) return;
    if (menuState && menuState.anchor === anchor) { closeMenu({ restoreFocus: true }); return; }
    closeMenu();
    const root = document.createElement('div');
    root.className = 'wb-menu';
    root.setAttribute('role', 'menu');
    root.setAttribute('aria-label', '隧道操作');
    root.innerHTML = visible.map((item) => (item.separator
      ? '<div class="wb-menu-sep" role="separator"></div>'
      : `<button type="button" role="menuitem" class="wb-menu-item${item.tone === 'danger' ? ' danger' : ''}" data-menu-act="${escape(item.act)}">${item.icon ? `<svg class="icon" aria-hidden="true"><use href="#i-${escape(item.icon)}"/></svg>` : ''}<span>${escape(item.label)}</span></button>`)).join('');
    document.body.appendChild(root);

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const pad = 8;
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      let left = rect.right - width;
      left = clamp(left, pad, Math.max(pad, window.innerWidth - width - pad));
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - pad) top = Math.max(pad, rect.top - height - 6);
      root.style.left = `${Math.round(left)}px`;
      root.style.top = `${Math.round(top)}px`;
    };
    place();

    const onPointerDown = (event) => {
      if (root.contains(event.target)) return;
      if (anchor.contains(event.target)) return;
      closeMenu();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu({ restoreFocus: true }); return; }
      if (event.key !== 'Tab') {
        const buttons = [...root.querySelectorAll('.wb-menu-item')];
        const index = buttons.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = buttons[(index + delta + buttons.length) % buttons.length];
          next?.focus({ preventScroll: true });
        }
      }
    };
    const onReposition = () => closeMenu();

    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-menu-act]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const act = button.dataset.menuAct;
      closeMenu({ restoreFocus: true });
      onSelect?.(act);
    });

    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    menuState = { root, anchor, onPointerDown, onKeyDown, onReposition };
    root.querySelector('.wb-menu-item')?.focus({ preventScroll: true });
  }

  /* 卡片与列表共用同一套操作定义；调用方只负责实现动作。 */
  function menuItems(t, { active = false, compact = false } = {}) {
    const dedicated = t.kind === 'dedicated';
    const items = [];
    if (t.url) items.push({ act: 'open-url', label: '打开面板', icon: 'external' });
    items.push({ act: 'connection', label: '连接信息', icon: 'info' });
    items.push({ act: 'copy', label: dedicated ? '复制代理地址' : '复制本机地址', icon: 'copy' });
    items.push({ act: 'port', label: '端口诊断', icon: 'search' });
    if (active) items.push({ act: 'restart', label: '重启隧道', icon: 'refresh' });
    items.push({ separator: true });
    items.push({ act: 'edit', label: '编辑配置', icon: 'edit' });
    items.push({ act: 'logs', label: '查看日志', icon: 'terminal' });
    if (!compact) items.push({ separator: true }, { act: 'delete', label: '删除隧道', icon: 'trash', tone: 'danger' });
    return items;
  }

  /* ---------------- 布局切换动画 ---------------- */
  /* 只读取一次几何信息，之后仅播放 transform/opacity 动画，
     不修改布局属性，也不会在轮询时重复触发。 */
  function captureRects() {
    const map = new Map();
    for (const control of document.querySelectorAll('[data-layout-target]')) {
      const grid = document.getElementById(control.dataset.layoutTarget);
      if (!grid || !grid.children) continue;
      for (const child of grid.children) {
        const id = child && child.dataset ? child.dataset.id : null;
        if (!id) continue;
        map.set(id, child.getBoundingClientRect());
      }
    }
    return map;
  }

  function dealIn(grid, before, reduced) {
    if (reduced || !grid || !grid.children) return;
    const nodes = [...grid.children].filter((el) => el.dataset && el.dataset.id);
    if (!nodes.length) return;
    const dense = nodes.length > 40;
    /* 卡片从旧位置轻微立起，列表只是平移，两种布局各有手感。 */
    const tilt = grid.dataset && grid.dataset.layout === 'cards';
    /* 总时长控制在半秒内：条目越多，每条之间的间隔越短。 */
    const step = Math.max(4, Math.min(dense ? 5 : 16, Math.floor(320 / nodes.length)));
    const duration = dense ? 260 : 330;
    const limit = Math.min(nodes.length, 60);
    for (let index = 0; index < limit; index++) {
      const node = nodes[index];
      const last = node.getBoundingClientRect();
      const first = before.get(node.dataset.id);
      const dx = first ? clamp(first.left - last.left, -170, 170) : 0;
      const dy = first ? clamp(first.top - last.top, -170, 170) : (tilt ? 14 : 10);
      const from = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)` + (tilt ? ' rotateX(-7deg) scale(.975)' : '');
      node.animate([
        { opacity: 0, transform: from },
        { opacity: 1, transform: 'none' }
      ], { duration, delay: index * step, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'backwards' });
    }
  }

  window.TunnelWorkbench = {
    fields(t) {
      return `<div class="dedicated-fields"><label class="field"><span>隧道类型</span><select name="kind"><option value="standard" ${t.kind !== 'dedicated' ? 'selected' : ''}>普通隧道</option><option value="dedicated" ${t.kind === 'dedicated' ? 'selected' : ''}>专用隧道</option></select></label>
        <div class="dedicated-options" ${t.kind === 'dedicated' ? '' : 'hidden'}>
          <div class="form-grid two"><label class="field"><span>绑定账号</span><input name="proxyAccount" value="${escape(t.proxyAccount)}" maxlength="100" placeholder="账号别名或邮箱"></label><label class="field"><span>ISP 标识</span><input name="ispId" value="${escape(t.ispId)}" maxlength="32" placeholder="ISP-01"></label></div>
          <div class="form-grid two"><label class="field"><span>预期出口 IP</span><input name="proxyExitIp" value="${escape(t.proxyExitIp)}" maxlength="45" placeholder="203.0.113.10"></label><label class="field"><span>服务器路由备注</span><select name="proxyRoute">${Object.entries(routes).map(([key,label]) => `<option value="${key}" ${(t.proxyRoute || 'unknown') === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
          <p class="field-hint">本机通过 SSH 转发服务器的 HTTP 代理入口。出口与路由仅作记录；修改此处不会更改服务器路由或 ISP 认证。浏览器需另行绑定代理。</p>
        </div></div>`;
    },
    bindForm(form) {
      const select = form.elements.namedItem('kind');
      select.addEventListener('change', () => { form.querySelector('.dedicated-options').hidden = select.value !== 'dedicated'; });
    },
    payload(form) {
      return Object.fromEntries(fields.map(name => [name, form.elements.namedItem(name).value.trim()]));
    },
    /* 专用隧道摘要：两行等高的键值行，替代原来零散的多行文字。 */
    summary(t) {
      if (t.kind !== 'dedicated') return '';
      return `<div class="dedicated-summary">
        <div class="ds-row"><span class="ds-label">账号</span><b class="ds-value" title="${escape(t.proxyAccount || '未绑定账号')}">${escape(t.proxyAccount || '未绑定账号')}</b><span class="ds-isp" title="ISP 标识">${escape(t.ispId || '专用代理')}</span></div>
        <div class="ds-row"><span class="ds-label">出口</span><b class="ds-value" title="配置的预期出口，未实时验证">${escape(t.proxyExitIp || '未填写')}</b><span class="ds-note" title="服务器路由备注">${escape(routes[t.proxyRoute] || routes.unknown)}</span></div>
      </div>`;
    },
    listHeader(dedicated) {
      return `<div class="wb-list-header" aria-hidden="true"><span>${dedicated ? '名称 / 账号' : '名称 / 服务器'}</span><span>本机入口</span><span>${dedicated ? '预期出口 / 远端入口' : '远端目标 / 服务器'}</span><span>状态</span><span class="wb-actions-label">操作</span></div>`;
    },
    /* 列表行：两行信息 + 固定宽度的“开关 + 更多”，任何一行都不会错位。 */
    row(t, {state, server, statusLabel, icon}) {
      const dedicated = t.kind === 'dedicated';
      const status = state.status || 'offline';
      const active = status === 'online' || status === 'connecting' || (status === 'error' && state.pid != null);
      const local = `${t.localHost}:${t.localPort}`;
      const remote = `${t.remoteHost || '127.0.0.1'}:${t.remotePort}`;
      const identity = dedicated ? (t.proxyAccount || '未绑定账号') : `${server.user || 'root'}@${server.host || '—'}`;
      const localNote = dedicated ? 'HTTP 代理' : (t.group || '端口转发');
      const primaryRemote = dedicated ? (t.proxyExitIp || '未填写出口') : remote;
      const secondaryRemote = dedicated
        ? `${t.ispId || '专用代理'} · ${routes[t.proxyRoute] || routes.unknown}`
        : (server.name || server.host || '—');
      const remoteTitle = dedicated
        ? `预期出口 ${t.proxyExitIp || '未填写'}（未实时验证） · 远端入口 ${remote}`
        : `经 ${server.host || '—'} → ${remote}`;
      const latency = state.latency != null ? `${state.latency} ms` : '—';
      const text = (value, className = '', title = value) => `<span class="wb-truncate ${className}" title="${escape(title)}">${escape(value)}</span>`;
      return `<article class="tunnel-card wb-list-row" data-id="${escape(t.id)}" data-kind="${dedicated ? 'dedicated' : 'standard'}" data-status="${escape(status)}" tabindex="0" aria-label="${escape(t.name)}" title="${escape(state.error || '')}">
        <div class="wb-cell wb-identity"><span class="status-dot"></span><div class="wb-id-text"><h3 class="wb-truncate" title="${escape(t.name)}">${escape(t.name)}</h3>${text(identity,'wb-secondary',identity)}</div></div>
        <div class="wb-cell">${text(local,'wb-mono',local)}${text(localNote,'wb-secondary')}</div>
        <div class="wb-cell">${text(primaryRemote,'wb-mono',remoteTitle)}${text(secondaryRemote,'wb-secondary',remoteTitle)}</div>
        <div class="wb-cell wb-state"><span class="status-label wb-truncate" data-live="status" data-status="${escape(status)}">${escape(statusLabel)}</span><span class="wb-secondary wb-truncate" data-live="latency">${escape(latency)}</span><span class="wb-row-error" data-live="error" ${state.error ? '' : 'hidden'}>${escape(state.error || '')}</span></div>
        <div class="wb-cell wb-actions tc-actions">
          <label class="switch" data-act="toggle" title="${active ? '关闭隧道' : '开启隧道'}"><input type="checkbox" data-role="toggle" aria-label="${escape(t.name)}：开关" ${active ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label>
          <button class="wb-more" data-act="menu" aria-haspopup="menu" aria-expanded="false" title="更多操作" aria-label="${escape(t.name)}：更多操作">${icon('more')}</button>
        </div>
      </article>`;
    },
    init({newTunnel, cardClick, openDrawer, renderLayout = () => {}}) {
      for (const id of ['dedicatedOverviewGrid','dedicatedGrid']) {
        const grid = document.getElementById(id);
        if (!grid) continue;
        grid.addEventListener('click', cardClick);
        grid.addEventListener('keydown', event => {
          if (['Enter',' '].includes(event.key) && event.target.classList.contains('tunnel-card')) {
            event.preventDefault();openDrawer(event.target.dataset.id);
          }
        });
      }
      document.addEventListener('click', event => {
        if (event.target.closest('[data-action="new-dedicated"]')) newTunnel(null, 'dedicated');
        const button = event.target.closest('[data-layout]');
        if (!button) return;
        const control = button.closest('[data-layout-target]');
        if (!control) return;
        const target = document.getElementById(control.dataset.layoutTarget);
        if (!target || target.dataset.layout === button.dataset.layout) return;
        /* 先记录旧位置，再重建 DOM，最后按“发牌”顺序播放过渡。 */
        const before = captureRects();
        target.dataset.layout = button.dataset.layout;
        try { localStorage.setItem('ts-layout-' + target.id, button.dataset.layout); } catch { /* 存储被禁用仍可切换 */ }
        this.renderLayout(control);
        renderLayout();
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const grids = [...document.querySelectorAll('[data-layout-target]')]
          .map(item => document.getElementById(item.dataset.layoutTarget))
          .filter(Boolean);
        for (const grid of grids) {
          grid.getAnimations?.().forEach(animation => animation.cancel());
          /* 容器只做极小的位移收尾，让“发牌”过程由条目自己完成。 */
          grid.animate(
            [{ transform: 'translateY(5px)' }, { transform: 'none' }],
            { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' }
          );
          dealIn(grid, before, false);
        }
      });
      document.querySelectorAll('[data-layout-target]').forEach(control => {
        const target = document.getElementById(control.dataset.layoutTarget);
        if (!target) return;
        let saved;try {saved=localStorage.getItem('ts-layout-' + target.id);} catch { /* 使用默认布局 */ }
        target.dataset.layout = saved === 'list' ? 'list' : 'cards';
        this.renderLayout(control);
      });
    },
    renderLayout(control) {
      const target = document.getElementById(control.dataset.layoutTarget);
      if (!target) return;
      const layout = target.dataset.layout;
      control.querySelectorAll('[data-layout]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.layout === layout);
        button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
      });
    },
    menuItems,
    openMenu,
    closeMenu
  };
})();
