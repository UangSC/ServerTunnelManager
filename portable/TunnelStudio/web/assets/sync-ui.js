/* 手动同步：日志选择 → SSH 读取 → 差异预览 → 明确确认。 */
(() => {
  'use strict';
  const token = document.querySelector('meta[name="panel-token"]')?.content;
  const anchor = document.querySelector('.settings-card.danger-card');
  if (!anchor || !token) return;
  const style = document.createElement('style');
  style.textContent = `
    .sync-card .sync-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
    .sync-card .sync-status{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px;font-size:13px}
    .sync-dialog{color:var(--text,#e5e7eb);background:var(--bg-elev,#18202d);border:1px solid var(--border,#465060);border-radius:16px;padding:24px;width:min(620px,calc(100vw - 32px));max-height:85vh;overflow:auto;box-sizing:border-box}
    .sync-dialog::backdrop{background:#0008;backdrop-filter:blur(3px)}
    .sync-dialog h2{margin:0 0 12px;font-size:21px}.sync-dialog p{font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
    .sync-dialog .sync-fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .sync-dialog label{display:grid;gap:7px;font-size:13px}.sync-dialog input[type=text],.sync-dialog input[type=number]{width:100%;min-width:0;box-sizing:border-box;padding:10px;border:1px solid var(--border,#465060);border-radius:8px;background:var(--bg,#111827);color:inherit}
    .sync-dialog .sync-wide{grid-column:1/-1}.sync-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;flex-wrap:wrap}
    .sync-dialog .sync-choice{display:flex;align-items:center;padding:12px 0;gap:8px}.sync-dialog .sync-error{color:#ef7777}
    @media(max-width:480px){.sync-dialog .sync-fields{grid-template-columns:1fr}}
  `;
  document.head.append(style);
  const card = document.createElement('section');
  card.className = 'panel settings-card sync-card';
  card.innerHTML = `<div class="settings-head"><span class="settings-icon tone-blue"><svg class="icon"><use href="#i-server"/></svg></span><div><h3>跨设备配置同步</h3><p>手动同步服务器与面板列表，Windows / Linux / macOS 通用。</p></div></div><p>本机设置、主题、私钥和认证状态不上传。拉取后先预览，再确认覆盖；日志每次单独选择。</p><div class="sync-actions"><button class="btn btn-ghost" data-sync="settings">同步服务器设置</button><button class="btn btn-primary" data-sync="pull">拉取并预览</button><button class="btn btn-ghost" data-sync="publish">发布本机列表</button></div><p class="sync-status" role="status" aria-live="polite"></p>`;
  anchor.before(card);
  const status = card.querySelector('.sync-status');
  let busy = false;
  async function api(route, body) {
    const response = await fetch('/api/sync/' + route, {method:body === undefined ? 'GET' : 'POST',headers:{'X-Panel-Token':token,'Content-Type':'application/json'},cache:'no-store',...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  }
  function dialog(title, content, label = '继续') {
    return new Promise(resolve => {
      const el = document.createElement('dialog'); el.className = 'sync-dialog';
      el.innerHTML = '<form><h2></h2><div class="sync-content"></div><footer><button type="button" class="btn btn-ghost" data-cancel>取消</button><button type="submit" class="btn btn-primary"></button></footer></form>';
      el.querySelector('h2').textContent = title;
      el.querySelector('.sync-content').append(content);
      el.querySelector('[type=submit]').textContent = label;
      const finish = result => { el.close(); el.remove(); resolve(result); };
      el.querySelector('form').onsubmit = event => { event.preventDefault(); finish(new FormData(event.currentTarget)); };
      el.querySelector('[data-cancel]').onclick = () => finish(null);
      el.oncancel = event => { event.preventDefault(); finish(null); };
      document.body.append(el);el.showModal();
    });
  }
  const paragraph = value => { const p = document.createElement('p');p.textContent = value;return p; };
  async function settings() {
    const data = (await api('settings')).settings;
    const content = document.createElement('div');
    content.append(paragraph('使用本机已配置免密的 SSH 账号。该账号需拥有同步目录读写权限；保存设置不会连接或上传。同步主机需要 Python 3。'));
    const fields = document.createElement('div');fields.className = 'sync-fields';
    for (const [name, label] of [['host','服务器地址'],['port','SSH 端口'],['user','SSH 账号'],['remoteDir','远端同步目录'],['keyPath','本机私钥路径'],['knownHostsPath','本机已确认指纹文件']]) {
      const row = document.createElement('label');row.textContent = label;
      if (['keyPath','knownHostsPath'].includes(name)) row.className = 'sync-wide';
      const input = document.createElement('input');input.name = name;input.value = data[name];input.required = true;input.type = name === 'port' ? 'number' : 'text';
      if (name === 'port') { input.min = '1';input.max = '65535'; }
      row.append(input);fields.append(row);
    }
    content.append(fields);
    const result = await dialog('同步服务器设置', content, '保存到本机');
    if (!result) return;
    const payload = Object.fromEntries(result);payload.port = Number(payload.port);
    await api('settings',payload);status.textContent = `已保存：${payload.user}@${payload.host}:${payload.remoteDir}`;
  }
  async function synchronize(kind) {
    const publish = kind === 'publish';
    const content = document.createElement('div');
    content.append(paragraph(publish ? '是否将最近最多 500 条面板日志一同发布？日志可能包含服务器地址和错误详情。' : '是否同时导入服务器快照中的面板日志？本机已有日志文件会保留。'));
    content.innerHTML += '<label class="sync-choice"><input type="radio" name="logs" value="no" checked>仅同步列表，不同步日志</label><label class="sync-choice"><input type="radio" name="logs" value="yes">同时同步日志</label>';
    const choice = await dialog(publish ? '发布内容' : '拉取内容', content, '获取预览');
    if (!choice) return;
    status.textContent = '正在通过 SSH 免密读取同步服务器…';
    const result = await api(kind + '-preview',{includeLogs:choice.get('logs') === 'yes'});
    const preview = document.createElement('div');
    const target = (await api('settings')).settings;
    preview.append(paragraph(`${target.user}@${target.host}:${target.remoteDir}`));
    preview.append(paragraph(publish ? (result.exists ? '确认后将覆盖服务器上的共享快照。' : '确认后将创建服务器上的首份共享快照。') : '确认后将备份并覆盖当前服务器与面板列表，同时关闭本面板管理的隧道。主题、SSH 设置、私钥和本机启动偏好保留。'));
    for (const [key,label] of [['servers','服务器'],['tunnels','面板 / 隧道']]) {
      const changes = result.preview[key];
      preview.append(paragraph(`${label}：同步后 ${changes.total} 项，新增 ${changes.added.length}，修改 ${changes.changed.length}，移除 ${changes.removed.length}`));
      for (const [field,title] of [['added','新增'],['changed','修改'],['removed','移除']]) if (changes[field].length) preview.append(paragraph(`${title}：${changes[field].join('、')}`));
    }
    if (result.localBindings?.length) preview.append(paragraph('保留本机端口：' + result.localBindings.map(x=>`${x.name} → ${x.localPort}`).join('；')));
    preview.append(paragraph(result.includeLogs ? `同时同步 ${result.logCount} 条日志。` : result.logsAvailable === false && choice.get('logs') === 'yes' ? '远端快照没有日志，本机日志保留。' : '本次不传入日志；发布时远端快照将仅包含列表。'));
    if (!await dialog(publish ? '确认发布' : '确认覆盖当前列表', preview, publish ? '确认发布' : '备份并覆盖')) {status.textContent = '已取消，配置未覆盖。';return;}
    const applied = await api(kind + '-apply',{token:result.token,confirm:true});
    if (publish) {status.textContent = '发布成功。其他设备现在可以手动拉取。';return;}
    status.textContent = `同步成功，原配置备份：${applied.backup}`;
    const done = document.createElement('div');done.append(paragraph(status.textContent));
    await dialog('同步完成',done,'刷新列表');location.reload();
  }
  card.addEventListener('click',async event => {
    const button = event.target.closest('[data-sync]');if (!button || busy) return;
    busy = true;card.querySelectorAll('button').forEach(b=>b.disabled=true);
    try { if (button.dataset.sync === 'settings') await settings(); else await synchronize(button.dataset.sync); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false;card.querySelectorAll('button').forEach(b=>b.disabled=false); }
  });
})();
