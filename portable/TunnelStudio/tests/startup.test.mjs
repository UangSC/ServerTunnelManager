import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Startup,LABEL} from '../server/startup.mjs';

function fixture(){
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-login-'));
  const root=path.join(home,'Library/Application Support/TunnelStudio');
  const app=path.join(home,"Applications/Tunnel & Studio's.app"),node=path.join(app,'Contents/Resources/runtime/node');
  fs.mkdirSync(path.dirname(node),{recursive:true});fs.writeFileSync(node,'fixture');
  fs.mkdirSync(path.join(root,'data/logs'),{recursive:true});
  fs.writeFileSync(path.join(root,'data/desktop.json'),JSON.stringify({node,app}));
  let loaded=false,fail=false;const calls=[];
  const run=async(command,args)=>{
    assert.equal(command,'/bin/launchctl');calls.push(args);
    if(args[0]==='print'&&!loaded)throw Object.assign(Error('not loaded'),{code:113});
    if(args[0]==='bootout')loaded=false;
    if(args[0]==='bootstrap'){if(fail)throw Error('injected failure');loaded=true;}
    return {stdout:''};
  };
  return {home,root,app,node,calls,startup:new Startup(root,{home,uid:501,platform:'darwin',run}),
    setFail(value){fail=value;},cleanup(){fs.rmSync(home,{recursive:true,force:true});}};
}

test('登录自启仅对已安装的 Mac 应用开放',()=>{
  const f=fixture();
  try{
    assert.equal(f.startup.status().supported,true);assert.equal(f.startup.status().enabled,false);
    assert.equal(new Startup(f.root,{home:f.home,platform:'linux'}).status().supported,false);
    fs.unlinkSync(f.node);assert.equal(f.startup.status().supported,false);
  }finally{f.cleanup();}
});

test('注册合法 LaunchAgent，空格/引号/XML 字符路径正确，无浏览器或强制保活',async()=>{
  const f=fixture();
  try{
    const status=await f.startup.set(true);assert.equal(status.enabled,true);
    const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',f.startup.file],{encoding:'utf8'}));
    assert.deepEqual(plist.ProgramArguments,[f.node,path.join(f.root,'bin/service.mjs'),'start','--enable-ssh']);
    assert.equal(plist.RunAtLoad,true);assert.equal(plist.KeepAlive,false);assert.equal(plist.AbandonProcessGroup,true);
    assert.equal(fs.statSync(f.startup.file).mode&0o777,0o600);
    assert.ok(f.calls.some(args=>args[0]==='bootstrap'&&args[1]==='gui/501'));
  }finally{f.cleanup();}
});

test('重复启用和关闭幂等，关闭只移除当前应用启动项',async()=>{
  const f=fixture();
  try{
    await f.startup.set(true);await f.startup.set(true);
    assert.equal((await f.startup.set(false)).enabled,false);
    assert.equal((await f.startup.set(false)).enabled,false);
    assert.equal(fs.existsSync(f.startup.file),false);
    assert.ok(f.calls.some(args=>args[0]==='bootout'&&args[1]==='gui/501/'+LABEL));
    assert.equal(fs.existsSync(f.node),true);
  }finally{f.cleanup();}
});

test('注册失败回滚配置，不伪报成功',async()=>{
  const f=fixture();
  try{
    f.setFail(true);await assert.rejects(f.startup.set(true),/注册登录自启失败/);
    assert.equal(f.startup.status().enabled,false);assert.equal(fs.existsSync(f.startup.file),false);
  }finally{f.cleanup();}
});

test('拒绝非布尔值、外部配置覆盖和无效桌面元数据',async()=>{
  const f=fixture();
  try{
    await assert.rejects(f.startup.set('yes'),/布尔/);
    fs.mkdirSync(path.dirname(f.startup.file),{recursive:true});fs.writeFileSync(f.startup.file,'foreign configuration');
    await assert.rejects(f.startup.set(true),/其他配置/);assert.equal(fs.readFileSync(f.startup.file,'utf8'),'foreign configuration');
    fs.writeFileSync(path.join(f.root,'data/desktop.json'),JSON.stringify({app:f.app,node:'/usr/bin/evil'}));
    assert.equal(f.startup.status().supported,false);
  }finally{f.cleanup();}
});

test('原生登录项无需 LaunchAgents 写权限，正确返回启用/关闭状态',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(path.join(f.root,'data/desktop.json'),JSON.stringify({app:f.app,node:f.node,loginBackend:'smappservice'}));
    const startup=new Startup(f.root,{home:f.home,platform:'darwin',run:async(command,args)=>{
      assert.equal(command,path.join(f.app,'Contents/MacOS/TunnelStudio'));
      return {stdout:JSON.stringify({ok:true,status:args[0]==='--login-enable'?1:0,enabled:args[0]==='--login-enable'?1:0,requiresApproval:0})};
    }});
    assert.equal((await startup.set(true)).enabled,true);
    assert.equal((await startup.set(false)).enabled,false);
    assert.equal(fs.existsSync(startup.file),false);
  }finally{f.cleanup();}
});

test('需要系统允许的原生登录项不会被误报为已启用',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(path.join(f.root,'data/desktop.json'),JSON.stringify({app:f.app,node:f.node,loginBackend:'smappservice'}));
    const startup=new Startup(f.root,{home:f.home,platform:'darwin',run:async()=>({stdout:JSON.stringify({ok:true,status:2,enabled:0,requiresApproval:1})})});
    const result=await startup.set(true);assert.equal(result.enabled,false);assert.equal(result.requiresApproval,true);
  }finally{f.cleanup();}
});
