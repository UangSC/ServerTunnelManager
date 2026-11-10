import test, { after } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SyncStore,makeBundle,validateBundle,mergeListings,remoteProgram } from '../shared/sync.mjs';
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-studio-sync-'));
after(() => fs.rmSync(root, {recursive:true,force:true}));
const config=()=>({settings:{theme:'light',accent:'ocean',panelPort:9666,simulation:false,defaultKeyPath:'local-secret-key'},servers:[{id:'srv-1',name:'服务器',host:'example.com',port:22,user:'deploy',keyPath:'local-secret-key',passwordless:true}],tunnels:[{id:'t-1',name:'面板',serverId:'srv-1',localHost:'127.0.0.1',localPort:29090,remoteHost:'127.0.0.1',remotePort:9090,probe:'auto',openUrl:'http://127.0.0.1:29090/ui',group:'测试',note:'',autoOpen:true}]});
const log={ts:'2026-10-23T12:00:00Z',level:'info',source:'panel',text:'测试日志'};
function fixture(){
  const directory=fs.mkdtempSync(path.join(root,'store-'));let remote=null,revision=null,writes=0;
  const store=new SyncStore(directory,{transport:async(mode,settings,payload)=>{
    if(mode==='read')return {bundle:remote,revision};
    if(payload.expected!==revision)throw new Error('服务器配置已改变');
    remote=payload.bundle;revision='rev-'+(++writes);return {revision};
  }});
  return {store,get remote(){return remote;},set remote(value){remote=value;revision='external';},get writes(){return writes;}};
}
test('同步白名单不上传私钥、主题、认证、启动设置与未选择的日志',()=>{
  const bundle=makeBundle(config(),[log],false),serialized=JSON.stringify(bundle);
  for(const forbidden of ['keyPath','local-secret-key','passwordless','theme','simulation','autoOpen','settings','logs'])assert.ok(!serialized.includes(forbidden),forbidden);
  assert.equal(bundle.tunnels.length,1);assert.deepEqual(makeBundle(config(),[log],true).logs,[log]);
});
test('跨平台合并保留本机密钥、端口、主题和启动偏好；新条目不自动开启',()=>{
  const current=config(),original=JSON.stringify(current),bundle=makeBundle(current,[],false);
  bundle.tunnels[0].localPort=19090;bundle.tunnels[0].openUrl='http://127.0.0.1:19090/ui';
  bundle.tunnels.push({...bundle.tunnels[0],id:'new',localPort:48001});
  const merged=mergeListings(current,bundle);
  assert.equal(JSON.stringify(current),original);assert.equal(merged.servers[0].keyPath,'local-secret-key');
  assert.equal(merged.tunnels[0].localPort,29090);assert.equal(merged.tunnels[0].autoOpen,true);assert.equal(merged.tunnels[1].autoOpen,false);
  assert.equal(merged.tunnels[0].openUrl,'http://127.0.0.1:29090/ui');assert.equal(merged.localBindings.length,1);
});
test('相同 ID 指向不同账号时不会继承旧账号密钥和认证',()=>{
  const current=config();current.settings.defaultKeyPath='new-default';
  const bundle=makeBundle(current,[],false);bundle.servers[0].user='another';
  const merged=mergeListings(current,bundle);assert.equal(merged.servers[0].keyPath,'new-default');assert.equal(merged.servers[0].passwordless,false);
});
test('拒绝非法包、注入、重复 ID、无效引用与合并端口冲突',()=>{
  const base=makeBundle(config(),[],false);
  for(const change of [b=>b.version=2,b=>b.servers[0].host='-oProxyCommand=bad',b=>b.servers[0].user='deploy;id',b=>b.tunnels[0].serverId='missing',b=>b.tunnels[0].localHost='0.0.0.0',b=>b.servers[0].id='__proto__',b=>b.tunnels[0].openUrl='javascript:alert(1)',b=>b.servers.push({...b.servers[0]})]){
    const bundle=structuredClone(base);change(bundle);assert.throws(()=>validateBundle(bundle));
  }
  const b=structuredClone(base);b.tunnels[0].localPort=19090;b.tunnels.push({...b.tunnels[0],id:'new',localPort:29090});assert.throws(()=>mergeListings(config(),b),/重复本机端口/);
});
test('预览与取消不写远端；发布成功后令牌不可重用',async()=>{
  const f=fixture(),current=config();const p=await f.store.publishPreview(current,[log],false);
  assert.equal(f.writes,0);assert.equal(f.remote,null);assert.equal(p.exists,false);
  await f.store.publish(p.token,current);assert.equal(f.writes,1);assert.equal(f.remote.servers.length,1);
  await assert.rejects(f.store.publish(p.token,current),/失效/);
});
test('拒绝过期、伪造令牌、预览后本机配置或同步目标变化',async()=>{
  const f=fixture(),current=config();let p=await f.store.publishPreview(current,[],false);
  await assert.rejects(f.store.publish('forged',current),/失效/);
  const changed=structuredClone(current);changed.settings.theme='dark';await assert.rejects(f.store.publish(p.token,changed),/本机配置/);
  const pending=path.join(f.store.root,'data/sync/pending.json'),data=JSON.parse(fs.readFileSync(pending));data.expires=0;fs.writeFileSync(pending,JSON.stringify(data));
  await assert.rejects(f.store.publish(p.token,current),/失效/);
  p=await f.store.publishPreview(current,[],false);f.store.saveSettings({...f.store.defaults(),host:'other.example'});
  await assert.rejects(f.store.publish(p.token,current),/失效/);
});
test('发布使用远端修订校验防止覆盖其他设备的新数据',async()=>{
  const f=fixture(),current=config(),p=await f.store.publishPreview(current,[],false);f.remote=makeBundle(current,[],false);
  await assert.rejects(f.store.publish(p.token,current),/已改变/);assert.equal(f.writes,0);
});
test('拉取日志必须明确选择；远端没有日志时不清空本机日志',async()=>{
  const f=fixture(),current=config();f.remote=makeBundle(current,[log],true);
  await assert.rejects(f.store.pull(current,undefined),/选择/);
  let p=await f.store.pull(current,false);assert.equal(f.store.prepareApply(p.token,current).includeLogs,false);
  p=await f.store.pull(current,true);assert.deepEqual(f.store.prepareApply(p.token,current).logs,[log]);
  f.remote=makeBundle(current,[],false);p=await f.store.pull(current,true);assert.equal(p.logsAvailable,false);assert.equal(f.store.prepareApply(p.token,current).includeLogs,false);
});
test('备份可以恢复完整本机配置，拒绝越界路径和同步目录',()=>{
  const f=fixture(),current=config(),file=f.store.backup(current,[log]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.store.root,file))).config,current);
  for(const change of [{keyPath:'../key'},{remoteDir:'~/../elsewhere'},{remoteDir:'relative'},{host:'bad;id'}])assert.throws(()=>f.store.saveSettings({...f.store.defaults(),...change}));
});
test('实际 Python 远端程序执行原子写入、读取和并发修订检查',()=>{
  const python=process.env.SYNC_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
  const dir=path.join(root,'remote');
  const run=(mode,payload)=>spawnSync(python,['-c',remoteProgram,mode,dir],{input:JSON.stringify(payload),encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  const bundle=makeBundle(config(),[],false);
  let result=run('write',{expected:null,bundle});assert.equal(result.status,0,result.stderr);
  const revision=JSON.parse(result.stdout).revision;
  result=run('read');assert.deepEqual(JSON.parse(result.stdout),{revision,bundle});
  result=run('write',{expected:null,bundle});assert.notEqual(result.status,0);assert.match(result.stderr,/服务器配置已改变/);
  assert.equal(fs.existsSync(path.join(dir,'.publish.lock')),false);
  assert.deepEqual(JSON.parse(run('read').stdout).bundle,bundle);
});
test('远端没有快照时给出明确提示',async()=>{const f=fixture();await assert.rejects(f.store.pull(config(),false),/尚无/);});
