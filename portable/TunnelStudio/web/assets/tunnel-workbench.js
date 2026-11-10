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
    init({newTunnel, cardClick, openDrawer}) {
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
