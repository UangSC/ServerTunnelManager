import test, { after } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Panel,ROOT,defaults,confined,keyPath,validateConfig,commandBundle,sshArgs } from '../server/app.mjs';
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-studio-app-'));
fs.mkdirSync(path.join(root,'web/assets'),{recursive:true});
for(const file of ['index.html','assets/app.js','assets/app.css','assets/favicon.svg','assets/sync-ui.js','assets/application-shortcut-ui.js','assets/tunnel-workbench.js'])fs.copyFileSync(path.join(ROOT,'web',file),path.join(root,'web',file));
const panel=await new Panel(root,{config:defaults()}).listen(0);
const base=`http://127.0.0.1:${panel.port}`;
const call=async(method,url,body)=>{
  const response=await fetch(base+url,{method,headers:{'X-Panel-Token':panel.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
};
const raw=(url,headers={})=>new Promise((resolve,reject)=>{const request=http.get(base+url,{headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);});
let server,tunnel;
try{
  await test('页面与所有静态资源可加载，HTML 注入令牌',async()=>{
    const html=await(await fetch(base+'/')).text();assert.ok(html.includes(panel.token));assert.ok(!html.includes('__PANEL_TOKEN__'));
    for(const file of ['app.js','app.css','favicon.svg','sync-ui.js','application-shortcut-ui.js','tunnel-workbench.js'])assert.equal((await fetch(base+'/assets/'+file)).status,200);
  });
  await test('未携带令牌不能调用 API',async()=>assert.equal((await fetch(base+'/api/bootstrap')).status,401));
  await test('拒绝伪造 Host',async()=>assert.equal(await raw('/api/health',{Host:'evil.example'}),403));
  await test('拒绝跨站 Origin',async()=>assert.equal(await raw('/api/health',{Origin:'https://evil.example'}),403));
  await test('静态目录不能读取配置、源码或私钥',async()=>{
    for(const file of ['/data/config.json','/server/app.mjs','/data/ssh/id_ed25519','/assets/%2e%2e%2f%2e%2e%2fdata/config.json'])assert.equal((await fetch(base+file)).status,404);
  });
  await test('拒绝非 JSON 和格式错误请求',async()=>{
    assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{'X-Panel-Token':panel.token},body:'abc'})).status,415);
    assert.equal((await call('POST','/api/settings',null)).status,400);
    assert.equal((await call('POST','/api/settings',[])).status,400);
  });
  await test('拒绝超出上限的请求体',async()=>assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{'X-Panel-Token':panel.token,'Content-Type':'application/json'},body:JSON.stringify({note:'x'.repeat(1048576)})})).status,413));
  await test('默认演示模式、登录自启关闭、SSH 未激活',async()=>{
    const {data}=await call('GET','/api/bootstrap');assert.equal(data.env.demo,true);assert.equal(data.env.realSshEnabled,false);assert.equal(data.autostart.supported,false);assert.equal(data.env.trafficAvailable,false);
  });
  await test('创建服务器且不会迁移已免密状态',async()=>{
    const result=await call('POST','/api/servers',{name:'测试服务器',host:'127.0.0.1',port:22,user:'tester',keyPath:'data/ssh/test_ed25519',passwordless:true});
    assert.equal(result.status,200);server=result.data.server;assert.equal(server.passwordless,false);
  });
  await test('拒绝服务器选项注入和用户注入',async()=>{
    for(const payload of [{...server,host:'-oProxyCommand=bad'},{...server,user:'root;echo bad'},{...server,keyPath:'/Users/example/.ssh/id_ed25519'}])assert.equal((await call('POST','/api/servers',payload)).status,400);
  });
  await test('创建隧道并返回页面兼容的数据结构',async()=>{
    const result=await call('POST','/api/tunnels',{name:'测试面板',serverId:server.id,localPort:48231,remotePort:8080,openUrl:'http://127.0.0.1:48231/ui/',group:'测试'});
    assert.equal(result.status,200);tunnel=result.data.tunnel;
    const {data}=await call('GET','/api/bootstrap');assert.equal(data.tunnels[0].server.host,'127.0.0.1');assert.equal(data.tunnels[0].url,tunnel.openUrl);
  });
  await test('拒绝重复端口、公开监听地址、面板端口和危险 URL',async()=>{
    for(const payload of [{...tunnel},{...tunnel,localPort:48232,localHost:'0.0.0.0'},{...tunnel,localPort:panel.config.settings.panelPort},{...tunnel,localPort:48232,openUrl:'javascript:alert(1)'},{...tunnel,localPort:2.3}])assert.equal((await call('POST','/api/tunnels',payload)).status,400);
  });
  await test('禁止删除仍关联隧道的服务器',async()=>assert.equal((await call('DELETE','/api/servers/'+server.id)).status,400));
  await test('演示开启不启动 SSH 子进程',async()=>{
    assert.equal((await call('POST',`/api/tunnels/${tunnel.id}/open`,{})).status,200);
    panel.state(tunnel.id).completeAt=0;await panel.tick();
    assert.equal(panel.state(tunnel.id).status,'online');assert.equal(panel.children.size,0);assert.equal(panel.state(tunnel.id).pid,null);
  });
  await test('运行中不能改映射、服务器或切换模式',async()=>{
    assert.equal((await call('PATCH','/api/tunnels/'+tunnel.id,{localPort:48232})).status,400);
    assert.equal((await call('PATCH','/api/servers/'+server.id,{name:'新名称'})).status,400);
    assert.equal((await call('POST','/api/settings',{simulation:false})).status,400);
  });
  await test('重启、关闭和批量操作可用',async()=>{
    assert.equal((await call('POST',`/api/tunnels/${tunnel.id}/restart`,{})).status,200);
    const result=await call('POST','/api/batch',{action:'close',ids:[tunnel.id,'missing']});assert.deepEqual(result.data.results.map(x=>x.ok),[true,false]);assert.equal(panel.state(tunnel.id).status,'offline');
  });
  await test('真实 SSH 未授权启用时失败且不启动子进程',async()=>{
    await call('POST','/api/settings',{simulation:false});const result=await call('POST',`/api/tunnels/${tunnel.id}/open`,{});
    assert.equal(result.status,400);assert.match(result.data.error,/尚未启用/);assert.equal(panel.children.size,0);await call('POST','/api/settings',{simulation:true});
  });
  await test('设置验证原子性和端口冲突检查',async()=>{
    const before=panel.config.settings.theme;
    assert.equal((await call('POST','/api/settings',{theme:'dark',connectTimeout:0})).status,400);assert.equal(panel.config.settings.theme,before);
    assert.equal((await call('POST','/api/settings',{panelPort:tunnel.localPort})).status,400);
    assert.equal((await call('POST','/api/settings',{defaultKeyPath:'../outside'})).status,400);
  });
  await test('私钥和可写路径不能超出项目，拒绝失效符号链接',async()=>{
    assert.throws(()=>confined(root,'../outside'));
    assert.throws(()=>keyPath(root,'/Users/example/.ssh/id_ed25519'));
    const link=path.join(root,'data/ssh/link');fs.symlinkSync(path.join(root,'missing-target'),link);
    assert.throws(()=>keyPath(root,'data/ssh/link')); // 只创建了项目内的链接，没有写入目标。
  });
  await test('配置持久化并可重新读取',async()=>{
    const result=await call('POST','/api/settings',{theme:'dark',accent:'rose'});assert.equal(result.status,200);
    const saved=JSON.parse(fs.readFileSync(path.join(root,'data/config.json'),'utf8'));assert.equal(saved.settings.theme,'dark');assert.equal(saved.servers.length,1);
  });
  await test('命令动态使用目标和项目路径，shell 语法有效',async()=>{
    const result=await call('POST','/api/passwordless/command',{...server,host:'192.0.2.7',port:2222,user:'alice'});
    assert.equal(result.status,200);const bundle=result.data.command;assert.equal(bundle.target,'alice@192.0.2.7');assert.match(bundle.single,/-p 2222/);assert.ok(bundle.single.includes(path.join(root,'data/ssh')));
    for(const code of [bundle.single,bundle.onepass,bundle.steps,bundle.sshconfig])execFileSync('/bin/sh',['-n'],{input:code});
  });
  await test('含单引号项目路径也生成合法 shell 命令',async()=>{
    const quoted=path.join(root,"quote's");fs.mkdirSync(quoted);const bundle=commandBundle(quoted,server);execFileSync('/bin/sh',['-n'],{input:bundle.onepass});
  });
  await test('密码向导仅返回手动步骤，不创建密钥、不伪报成功',async()=>{
    const result=await call('POST','/api/passwordless',server);assert.equal(result.data.job.status,'manual');assert.equal(fs.existsSync(path.join(root,server.keyPath)),false);
    assert.equal((await call('GET','/api/passwordless?id='+result.data.jobId)).data.job.status,'manual');
    assert.equal((await call('POST','/api/passwordless',{...server,password:'never-log-this-secret'})).status,400);
    assert.ok(!fs.readFileSync(path.join(root,'data/logs/panel.log'),'utf8').includes('never-log-this-secret'));
  });
  await test('SSH 参数禁止读取用户配置，指纹与私钥限定项目且不执行远端命令',async()=>{
    const args=sshArgs(root,server,tunnel,panel.config.settings);assert.deepEqual(args.slice(0,4),['-F','/dev/null','-N','-T']);assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));assert.equal(args.at(-1),'tester@127.0.0.1');
  });
  await test('拒绝非法导入且不破坏已有配置',async()=>{
    const before=JSON.stringify(panel.config);const bad=structuredClone(panel.config);bad.tunnels[0].serverId='missing';
    assert.equal((await call('POST','/api/import',{config:bad})).status,400);assert.equal(JSON.stringify(panel.config),before);
  });
  await test('导入强制演示、清除认证和自动开启标记',async()=>{
    const data=structuredClone(panel.config);data.settings.simulation=false;data.settings.autoOpenOnLaunch=true;data.servers[0].passwordless=true;data.tunnels[0].autoOpen=true;
    assert.equal((await call('POST','/api/import',{config:data})).status,200);assert.equal(panel.config.settings.simulation,true);assert.equal(panel.config.servers[0].passwordless,false);assert.equal(panel.config.tunnels[0].autoOpen,false);
  });
  await test('Windows 默认私钥路径导入为项目专用路径',async()=>{
    const data=structuredClone(panel.config);data.settings.defaultKeyPath='~/.ssh/id_ed25519';data.servers[0].keyPath='C:\\Users\\tester\\.ssh\\id_ed25519';
    assert.equal((await call('POST','/api/import',{config:data})).status,200);
    assert.equal(panel.config.settings.defaultKeyPath,'data/ssh/id_ed25519');assert.equal(panel.config.servers[0].keyPath,'data/ssh/id_ed25519');
  });
  await test('重复 ID、重复映射和越界私钥无法导入',async()=>{
    for(const alter of [c=>c.servers.push(c.servers[0]),c=>c.tunnels.push({...c.tunnels[0],id:'different'}),c=>c.servers[0].keyPath='/tmp/bad']){const data=structuredClone(panel.config);alter(data);assert.throws(()=>validateConfig(root,data));}
  });
  await test('端口诊断能区分真实空闲和外部占用，不结束外部进程',async()=>{
    assert.equal((await call('GET',`/api/tunnels/${tunnel.id}/port`)).data.diagnosis.kind,'free');
    const listener=net.createServer();await new Promise(resolve=>listener.listen(tunnel.localPort,'127.0.0.1',resolve));
    try{const result=await call('GET',`/api/tunnels/${tunnel.id}/port`);assert.ok(['external','unknown'].includes(result.data.diagnosis.kind));assert.equal(listener.listening,true);assert.equal((await call('POST',`/api/tunnels/${tunnel.id}/open`,{})).status,400);}finally{await new Promise(resolve=>listener.close(resolve));}
  });
  await test('日志过滤、导出、排序和清空可用',async()=>{
    assert.ok((await call('GET','/api/logs?source=panel')).data.lines.every(l=>l.source==='panel'));
    assert.equal((await call('GET','/api/export')).data.servers.length,1);
    assert.equal((await call('POST','/api/tunnels/order',{ids:[tunnel.id]})).status,200);
    assert.equal((await call('POST','/api/logs/clear',{})).status,200);assert.equal((await call('POST','/api/activity/clear',{})).status,200);
  });
  await test('禁止自动写登录项、打开终端及演示隧道页面',async()=>{
    for(const [url,body] of [['/api/startup',{enabled:true}],['/api/open-terminal',{shell:'zsh'}],['/api/open-url',{url:tunnel.openUrl}]])assert.equal((await call('POST',url,body)).status,400);
  });
  await test('删除测试隧道和服务器，以及重置配置可用',async()=>{
    assert.equal((await call('DELETE','/api/tunnels/'+tunnel.id)).status,200);assert.equal((await call('DELETE','/api/servers/'+server.id)).status,200);
    assert.equal((await call('POST','/api/reset',{})).status,200);assert.equal(panel.config.tunnels.length,0);
  });
}finally{await panel.shutdown();fs.rmSync(root,{recursive:true,force:true});}
console.log('测试使用系统临时目录，完成后自动清理；未连接远程服务器。');
