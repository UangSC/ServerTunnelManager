import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,Panel,defaults,sshArgs,commandBundle,validateConfig} from '../server/app.mjs';
import {install,migrateConfig} from '../bin/install.mjs';
const run=promisify(execFile);
const temporary=()=>fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-studio-macos-'));
const freePort=async()=>{const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};

test('macOS 安装、升级及进程管理集成',async t=>{
  const workspace=temporary(),target=path.join(workspace,"Application Support/quote's TunnelStudio"),legacy=path.join(workspace,'windows.json');
  const config=defaults();config.settings.defaultKeyPath='C:\\Users\\user\\.ssh\\id_ed25519';
  config.settings.panelPort=await freePort();
  config.servers=[{id:'srv',name:'测试服务器',host:'::1',port:22,user:'tester',keyPath:'~/.ssh/id_ed25519'}];
  config.tunnels=[{id:'t',name:'测试服务',serverId:'srv',localPort:await freePort(),remoteHost:'::1',remotePort:8080,probe:'http',autoOpen:true}];
  fs.writeFileSync(legacy,'\uFEFF'+JSON.stringify(config));
  const service=async action=>run(process.execPath,[path.join(target,'bin/service.mjs'),action],{timeout:15000});
  try{
    await t.test('从 BOM/Windows 配置迁移，私钥不从 Windows 路径读取',()=>{
      const result=install({target,legacy});assert.equal(result.firstInstall,true);
      const current=JSON.parse(fs.readFileSync(path.join(target,'data/config.json')));
      assert.equal(current.servers.length,1);assert.equal(current.settings.simulation,true);
      assert.equal(current.tunnels[0].autoOpen,false);assert.equal(current.tunnels[0].probe,'http');
      assert.equal(current.servers[0].keyPath,'data/ssh/id_ed25519');
      assert.equal(fs.statSync(path.join(target,'data/config.json')).mode&0o777,0o600);
    });
    await t.test('升级保留本机配置、密钥和同步设置；拒绝符号链接',()=>{
      const configFile=path.join(target,'data/config.json'),before=fs.readFileSync(configFile,'utf8');
      fs.writeFileSync(path.join(target,'data/ssh/test-key'),'fixture');
      assert.equal(install({target,legacy}).firstInstall,false);
      assert.equal(fs.readFileSync(configFile,'utf8'),before);
      assert.equal(fs.readFileSync(path.join(target,'data/ssh/test-key'),'utf8'),'fixture');
      const link=path.join(workspace,'link');fs.symlinkSync(target,link);
      assert.throws(()=>install({target:link,legacy}),/符号链接/);
    });
    await t.test('SSH 参数在含空格、单引号的目录中仍读取正确的 known_hosts',()=>{
      const current=JSON.parse(fs.readFileSync(path.join(target,'data/config.json')));
      const args=sshArgs(target,current.servers[0],current.tunnels[0],current.settings);
      const output=execFileSync('/usr/bin/ssh',['-G',...args],{encoding:'utf8'});
      assert.ok(output.includes(path.join(target,'data/ssh/known_hosts')));
      assert.ok(args.includes('127.0.0.1:'+current.tunnels[0].localPort+':[::1]:8080'));
      const bundle=commandBundle(target,current.servers[0]);
      for(const command of [bundle.single,bundle.onepass,bundle.steps])execFileSync('/bin/zsh',['-n'],{input:command});
    });
    await t.test('后台启动、重复启动及并发启动复用同一实例',async()=>{
      await Promise.all([service('start'),service('start')]);
      const base=`http://127.0.0.1:${config.settings.panelPort}`;
      const first=await(await fetch(base+'/api/health')).json();
      assert.equal(first.rootPath,target);
      await service('start');const second=await(await fetch(base+'/api/health')).json();
      assert.equal(first.pid,second.pid);assert.match((await service('status')).stdout,/运行中/);
    });
    await t.test('重启后 PID 改变；重复停止正常退出，不保留失效记录',async()=>{
      const base=`http://127.0.0.1:${config.settings.panelPort}`;
      const first=await(await fetch(base+'/api/health')).json();
      await service('restart');const second=await(await fetch(base+'/api/health')).json();
      assert.notEqual(first.pid,second.pid);await service('stop');await service('stop');
      assert.equal(fs.existsSync(path.join(target,'data/service.json')),false);
      assert.match((await service('status')).stdout,/未运行/);
    });
    await t.test('占用面板端口的外部 HTTP 服务不会被接管或结束',async()=>{
      const foreign=http.createServer((req,res)=>{res.writeHead(200);res.end('not Tunnel Studio');});
      await new Promise(resolve=>foreign.listen(config.settings.panelPort,'127.0.0.1',resolve));
      try{
        for(const action of ['start','stop','restart'])await assert.rejects(service(action),/其他服务占用/);
        assert.equal(foreign.listening,true);
      }finally{await new Promise(resolve=>foreign.close(resolve));}
    });
    await t.test('随面板启动设置生效，停止面板关闭模拟隧道',async()=>{
      const filename=path.join(target,'data/config.json'),current=JSON.parse(fs.readFileSync(filename));
      current.settings.autoOpenOnLaunch=true;current.tunnels[0].autoOpen=true;fs.writeFileSync(filename,JSON.stringify(current));
      await service('start');
      const base=`http://127.0.0.1:${config.settings.panelPort}`;
      const token=(await(await fetch(base+'/')).text()).match(/name="panel-token" content="([^"]+)"/)[1];
      const state=await(await fetch(base+'/api/state',{headers:{'X-Panel-Token':token}})).json();
      assert.ok(['connecting','online'].includes(state.runtime.t.status));await service('stop');
    });
  }finally{await service('stop').catch(()=>{});fs.rmSync(workspace,{recursive:true,force:true});}
});

test('关闭不响应 SIGTERM 的自建子进程有时间上限',async()=>{
  const root=temporary(),config=defaults();
  config.servers=[{id:'s',name:'test',host:'127.0.0.1',port:22,user:'test'}];
  config.tunnels=[{id:'t',name:'test',serverId:'s',localPort:12345,remotePort:80}];
  const panel=new Panel(root,{config});
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
  await new Promise(resolve=>child.stdout.once('data',resolve));
  panel.children.set('t',child);panel.state('t').status='online';
  try{await panel.close('t');assert.equal(child.signalCode,'SIGKILL');assert.equal(panel.state('t').status,'offline');}
  finally{child.kill('SIGKILL');await panel.shutdown();fs.rmSync(root,{recursive:true,force:true});}
});

test('配置拒绝关闭指纹校验，保留所有探测类型与 IPv6',()=>{
  const root=temporary();
  try{
    const config=defaults();config.settings.strictHostKeyChecking=false;
    assert.throws(()=>validateConfig(root,config),/指纹/);
    config.settings.strictHostKeyChecking=true;
    config.servers=[{id:'s',name:'test',host:'::1',port:22,user:'test'}];
    for(const probe of ['auto','http','tcp','socks5','none']){
      config.tunnels=[{id:'t',name:'test',serverId:'s',localPort:12345,remotePort:80,remoteHost:'::1',probe}];
      assert.equal(migrateConfig(root,config).tunnels[0].probe,probe);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('失败状态可修正配置，端口变更同步本地 URL，导入和重置有备份',async()=>{
  const root=temporary(),config=defaults();config.settings.theme='dark';
  config.servers=[{id:'s',name:'test',host:'127.0.0.1',port:22,user:'test'}];
  config.tunnels=[{id:'t',name:'test',serverId:'s',localPort:12345,remotePort:80,openUrl:'http://127.0.0.1:12345/ui/?x=1#test'}];
  const panel=new Panel(root,{config});panel.port=9666;
  const api=(method,url,body={})=>panel.api(method,url,new URLSearchParams(),body);
  try{
    Object.assign(panel.state('t'),{status:'error',retryAt:Date.now()+6000,error:'old error'});
    await api('PATCH','/api/tunnels/t',{localPort:12346});
    assert.equal(panel.tunnel('t').openUrl,'http://127.0.0.1:12346/ui/?x=1#test');
    assert.equal(panel.state('t').retryAt,0);assert.equal(panel.state('t').status,'offline');
    const previous=structuredClone(panel.config);
    const imported=await api('POST','/api/import',{config:previous});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,imported.backup))).config,previous);
    const reset=await api('POST','/api/reset');
    assert.equal(panel.config.settings.theme,'dark');assert.equal(panel.config.tunnels.length,0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,reset.backup))).config.tunnels.length,1);
  }finally{await panel.shutdown();fs.rmSync(root,{recursive:true,force:true});}
});
