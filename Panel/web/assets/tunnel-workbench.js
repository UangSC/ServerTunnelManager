/* Windows / macOS 共用的隧道布局与专用代理配置。 */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const routes = {unknown:'未标记',direct:'直连 ISP',vpn:'中转 → ISP'};
  const fields = ['kind','proxyAccount','ispId','proxyExitIp','proxyRoute'];
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
    summary(t) {
      if (t.kind !== 'dedicated') return '';
      return `<div class="dedicated-summary"><span title="绑定账号">${escape(t.proxyAccount || '未绑定账号')}</span><span>${escape(t.ispId || '专用代理')}</span><span title="配置的预期出口，未实时验证">预期出口 <b>${escape(t.proxyExitIp || '未填写')}</b></span><span>${routes[t.proxyRoute] || routes.unknown}</span></div>`;
    },
    // 列表采用独立行结构，保留原卡片结构与同一套操作/实时状态钩子。
    listHeader(dedicated) {
      return `<div class="wb-list-header" aria-hidden="true"><span>名称${dedicated ? ' / 账号' : ' / 服务器'}</span><span>本机入口</span><span>${dedicated ? '预期出口 / 远端入口' : '远端目标 / 服务器'}</span><span>状态 / 延迟</span><span class="wb-actions-label">操作</span></div>`;
    },
    row(t, {state, server, statusLabel, icon}) {
      const dedicated = t.kind === 'dedicated';
      const status = state.status || 'offline';
      const active = status === 'online' || status === 'connecting' || (status === 'error' && state.pid != null);
      const local = `${t.localHost}:${t.localPort}`, remote = `${t.remoteHost}:${t.remotePort}`;
      const identity = dedicated ? (t.proxyAccount || '未绑定账号') : `${server.user || 'root'}@${server.host || '—'}`;
      const route = `${t.ispId || '专用代理'} · ${routes[t.proxyRoute] || routes.unknown}`;
      const text = (value, className = '', title = value) => `<span class="wb-truncate ${className}" title="${escape(title)}">${escape(value)}</span>`;
      return `<article class="tunnel-card wb-list-row" data-id="${escape(t.id)}" data-kind="${dedicated ? 'dedicated' : 'standard'}" data-status="${escape(status)}" tabindex="0" aria-label="${escape(t.name)}">
        <div class="wb-cell wb-identity"><div class="wb-name"><span class="status-dot"></span><h3 class="wb-truncate" title="${escape(t.name)}">${escape(t.name)}</h3></div>${text(identity,'wb-secondary')}</div>
        <div class="wb-cell">${text(local,'wb-mono')}${text(dedicated ? 'HTTP 代理' : (t.group || '端口转发'),'wb-secondary')}</div>
        <div class="wb-cell">${text(dedicated ? (t.proxyExitIp || '未填写出口') : remote,'wb-mono',dedicated ? `预期出口：${t.proxyExitIp || '未填写'}（未实时验证） · ${route}` : remote)}${text(dedicated ? remote : (server.name || server.host || '—'),'wb-secondary',`经 ${server.host || '—'} → ${remote}${dedicated ? ' · ' + route : ''}`)}</div>
        <div class="wb-cell wb-state"><span class="status-label wb-truncate" data-live="status" data-status="${escape(status)}">${escape(statusLabel)}</span><span class="wb-secondary wb-truncate" data-live="latency">${state.latency != null ? escape(state.latency) + ' ms' : '—'}</span><span class="wb-row-error wb-truncate" data-live="error" title="${escape(state.error || '')}" ${state.error ? '' : 'hidden'}>${escape(state.error || '')}</span></div>
        <div class="wb-cell wb-actions tc-actions">
          <div class="wb-action-line"><label class="switch" data-act="toggle" title="${active ? '关闭隧道' : '开启隧道'}"><input type="checkbox" data-role="toggle" aria-label="${escape(t.name)}：开关" ${active ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></label><button class="quick-btn wb-info" data-act="connection" title="查看连接信息" aria-label="连接信息">${icon('info')}连接信息</button><button class="icon-btn" data-act="logs" title="查看日志" aria-label="查看日志">${icon('terminal')}</button></div>
          <div class="wb-action-line">${t.url ? `<button class="quick-btn accent" data-act="open-url">${icon('external')}打开</button>` : ''}<button class="quick-btn" data-act="port" title="端口诊断" aria-label="端口诊断" ${status === 'occupied' ? '' : 'hidden'}>${icon('search')}</button><button class="quick-btn" data-act="copy">${icon('copy')}${dedicated ? '代理地址' : '复制'}</button><button class="quick-btn" data-act="menu" title="编辑配置与更多操作">${icon('more')}更多</button></div>
        </div>
      </article>`;
    },
    init({newTunnel, cardClick, openDrawer, renderLayout = () => {}}) {
      for (const id of ['dedicatedOverviewGrid','dedicatedGrid']) {
        const grid = document.getElementById(id);
        grid.addEventListener('click',cardClick);
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
        const target = document.getElementById(control.dataset.layoutTarget);
        if (!target || target.dataset.layout === button.dataset.layout) return;
        target.dataset.layout = button.dataset.layout;
        try { localStorage.setItem('ts-layout-' + target.id, button.dataset.layout); } catch { /* 存储被禁用仍可切换 */ }
        this.renderLayout(control);
        renderLayout();
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          target.getAnimations().forEach(animation => animation.cancel());
          target.animate([{opacity:.35,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'ease-out'});
        }
      });
      document.querySelectorAll('[data-layout-target]').forEach(control => {
        const target = document.getElementById(control.dataset.layoutTarget);
        let saved;try {saved=localStorage.getItem('ts-layout-' + target.id);} catch { /* 使用默认布局 */ }
        target.dataset.layout = saved === 'list' ? 'list' : 'cards';
        this.renderLayout(control);
      });
    },
    renderLayout(control) {
      const layout = document.getElementById(control.dataset.layoutTarget).dataset.layout;
      control.querySelectorAll('[data-layout]').forEach(button => {
        button.classList.toggle('is-active', button.dataset.layout === layout);
        button.setAttribute('aria-pressed',String(button.dataset.layout === layout));
      });
    }
  };
})();
