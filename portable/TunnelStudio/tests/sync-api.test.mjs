import test, { after } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Panel,ROOT,defaults,commandBundle } from '../server/app.mjs';
import { makeBundle } from '../server/sync.mjs';
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-studio-sync-api-'));
after(() => fs.rmSync(root, {recursive:true,force:true}));
const initial=defaults();initial.settings.theme='dark';initial.settings.autoOpenOnLaunch=true;
initial.servers=[{id:'srv-1',name:'原有服务器',host:'example.com',port:22,user:'deploy',keyPath:'data/ssh/local'}];
initial.tunnels=[{id:'t-1',name:'原有面板',serverId:'srv-1',localHost:'127.0.0.1',localPort:29090,remoteHost:'127.0.0.1',remotePort:9090,probe:'tcp',openUrl:'http://127.0.0.1:29090/ui',autoOpen:true}];
const panel=new Panel(root,{config:initial});
const remote=makeBundle(panel.config,[{ts:'2026-10-23T01:00:00Z',level:'info',source:'panel',text:'远端日志'}],true);
remote.servers[0].name='新服务器名称';remote.tunnels[0].localPort=19090;
let writes=0;
panel.sync.transport=async(mode,settings,payload)=>{if(mode==='read')return {bundle:remote,revision:'v1'};writes++;return {revision:'v2'};};
const api=(method,url,body={})=>panel.api(method,url,new URLSearchParams(),body);
test('同步 API 强制确认；预览不修改本机或远端',async()=>{
  const before=JSON.stringify(panel.config);const p=await api('POST','/api/sync/pull-preview',{includeLogs:false});
  assert.equal(JSON.stringify(panel.config),before);assert.equal(writes,0);
  await assert.rejects(api('POST','/api/sync/pull-apply',{token:p.token}),/确认/);
  await assert.rejects(api('POST','/api/sync/pull-apply',{token:'forged',confirm:true}),/失效/);
  assert.equal(JSON.stringify(panel.config),before);
});
test('确认后备份再替换列表，保留本机设置、密钥和端口',async()=>{
  const old=structuredClone(panel.config),p=await api('POST','/api/sync/pull-preview',{includeLogs:false});
  const result=await api('POST','/api/sync/pull-apply',{token:p.token,confirm:true});
  assert.deepEqual(panel.config.settings,old.settings);assert.equal(panel.config.servers[0].name,'新服务器名称');
  assert.equal(panel.config.servers[0].keyPath,'data/ssh/local');assert.equal(panel.config.tunnels[0].localPort,29090);
  assert.equal(panel.config.tunnels[0].autoOpen,true);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,result.backup))).config,old);
  assert.ok(!panel.logs.some(l=>l.text==='远端日志'));assert.equal(panel.state('t-1').status,'offline');
  await assert.rejects(api('POST','/api/sync/pull-apply',{token:p.token,confirm:true}),/失效/);
});
test('选择日志后导入日志并保存独立副本，不删除原日志文件',async()=>{
  const p=await api('POST','/api/sync/pull-preview',{includeLogs:true});
  await api('POST','/api/sync/pull-apply',{token:p.token,confirm:true});
  assert.ok(panel.logs.some(l=>l.text==='远端日志'));assert.ok(panel.logs.some(l=>l.text.includes('控制台已启动')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'data/sync/imported-logs.json'))).length,1);
});
test('发布 API 必须确认，服务端只使用预览快照',async()=>{
  const p=await api('POST','/api/sync/publish-preview',{includeLogs:false});
  await assert.rejects(api('POST','/api/sync/publish-apply',{token:p.token}),/确认/);assert.equal(writes,0);
  await api('POST','/api/sync/publish-apply',{token:p.token,confirm:true});assert.equal(writes,1);
});
test('生成命令可执行、引号安全且重复安装公钥不会重复追加',{skip:process.platform==='win32'},()=>{
  const dir=path.join(root,"quote's project"),home=path.join(dir,'home'),bin=path.join(dir,'bin');
  fs.mkdirSync(path.join(dir,'data/ssh'),{recursive:true});fs.mkdirSync(home);fs.mkdirSync(bin);
  const key=path.join(dir,'data/ssh/id_ed25519');
  execFileSync('/usr/bin/ssh-keygen',['-t','ed25519','-f',key,'-N','','-C',"quote's $(not-a-command)"],{stdio:'pipe'});
  fs.writeFileSync(path.join(bin,'ssh'),'#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n',{mode:0o700});
  const command=commandBundle(dir,{host:'example.com',port:22,user:'deploy'}).single;
  const env={...process.env,HOME:home,PATH:bin+':'+process.env.PATH};
  for(let n=0;n<2;n++)execFileSync('/bin/sh',['-c',command],{env,stdio:'pipe'});
  assert.equal(fs.readFileSync(path.join(home,'.ssh/authorized_keys'),'utf8'),fs.readFileSync(key+'.pub','utf8'));
  assert.equal(fs.statSync(path.join(home,'.ssh/authorized_keys')).mode&0o777,0o600);
});
