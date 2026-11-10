/* Shared Windows/macOS application-shortcut setting. No OS inference in the browser. */
(() => {
  'use strict';
  const token=document.querySelector('meta[name="panel-token"]')?.content;
  const toggle=document.getElementById('applicationShortcutToggle');
  const status=document.getElementById('applicationShortcutStatus');
  if(!token||!toggle||!status)return;
  let current={supported:false,enabled:false};
  async function request(body) {
    const response=await fetch('/api/application-shortcut',{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',
      headers:{'X-Panel-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok||data.ok===false)throw new Error(data.error||'无法读取快捷图标设置');
    return data.applicationShortcut;
  }
  function render(value) {
    current=value||current;
    toggle.checked=!!current.enabled;toggle.disabled=current.supported===false;
    status.textContent=current.message||(current.enabled?'快捷图标已添加':'尚未添加快捷图标');
    status.title=current.path||'';
  }
  toggle.disabled=true;
  request().then(render).catch(error=>{status.textContent=error.message;});
  toggle.addEventListener('change',async()=>{
    const enabled=toggle.checked;toggle.disabled=true;status.textContent='正在更新快捷图标…';
    try {render(await request({enabled}));}
    catch(error) {render(current);status.textContent=error.message;}
  });
})();
