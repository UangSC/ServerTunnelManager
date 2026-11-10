import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ApplicationShortcuts, INSTALL_OWNER, INSTALL_MARKER, SHORTCUT_MARKER, shortcutScript } from '../server/shortcuts.mjs';
import { install } from '../bin/install.mjs';
import { ROOT, Panel, defaults } from '../server/app.mjs';

function fixture(){
  const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-shortcut-'));
  const root=path.join(base,"App Support/quote's Tunnel Studio");
  for(const directory of ['bin','server','data'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  for(const file of ['bin/service.mjs','server/app.mjs'])fs.writeFileSync(path.join(root,file),'// fake installed source\n');
  fs.writeFileSync(path.join(root,INSTALL_MARKER),JSON.stringify({owner:INSTALL_OWNER,version:1,root}));
  const home=path.join(base,'home'),apps=path.join(home,'Applications');
  const node=path.join(base,"fake node's runtime");
  fs.writeFileSync(node,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.1.0; else printf "%s\\n" "$@"; fi\n',{mode:0o755});
  const shortcuts=new ApplicationShortcuts(root,{home,applicationsDir:apps,platform:'darwin',node,env:{PATH:''},probeNode:()=>true});
  return {base,root,node,home,apps,shortcuts};
}

await test('macOS application shortcut is optional, idempotent, executable and references local installed code',()=>{
  const f=fixture();try{
    assert.equal(f.shortcuts.status().enabled,false);
    assert.equal(f.shortcuts.status().supported,true);
    assert.equal(f.shortcuts.set(true).enabled,true);
    assert.equal(f.shortcuts.set(true).enabled,true);
    const app=f.shortcuts.path,executable=path.join(app,'Contents/MacOS/TunnelStudio');
    const script=fs.readFileSync(executable,'utf8');
    execFileSync('/bin/sh',['-n'],{input:script});
    const output=execFileSync('/bin/sh',[executable],{encoding:'utf8',env:{PATH:''}}).trim().split('\n');
    assert.deepEqual(output,[path.join(f.root,'bin/service.mjs'),'start','--enable-ssh','--open']);
    assert.equal(fs.existsSync(path.join(app,'data')),false);
    assert.equal(fs.existsSync(path.join(app,'Contents/Resources/runtime')),false);
    assert.equal(f.shortcuts.set(false).enabled,false);
    assert.equal(f.shortcuts.set(false).enabled,false);
    assert.equal(fs.existsSync(f.root),true);
  }finally{fs.rmSync(f.base,{recursive:true,force:true});}
});

await test('macOS shortcut refuses foreign bundles, symlinks, extra files and tampered wrappers',()=>{
  for(const kind of ['foreign','symlink','extra-runtime','tampered','wrong-owner']){
    const f=fixture();try{
      fs.mkdirSync(f.apps,{recursive:true});
      if(kind==='foreign')fs.mkdirSync(f.shortcuts.path);
      else if(kind==='symlink')fs.symlinkSync(f.root,f.shortcuts.path);
      else {
        f.shortcuts.set(true);
        if(kind==='extra-runtime')fs.mkdirSync(path.join(f.shortcuts.path,'Contents/Resources/runtime'));
        if(kind==='tampered')fs.appendFileSync(path.join(f.shortcuts.path,'Contents/MacOS/TunnelStudio'),'# modified\n');
        if(kind==='wrong-owner'){
          const marker=path.join(f.shortcuts.path,SHORTCUT_MARKER),record=JSON.parse(fs.readFileSync(marker,'utf8'));
          record.root='/other-install';fs.writeFileSync(marker,JSON.stringify(record));
        }
      }
      assert.throws(()=>f.shortcuts.set(true));assert.throws(()=>f.shortcuts.set(false));
      assert.equal(fs.existsSync(f.shortcuts.path),true);assert.equal(fs.existsSync(path.join(f.root,'server/app.mjs')),true);
    }finally{fs.rmSync(f.base,{recursive:true,force:true});}
  }
});

await test('macOS shortcut rejects non-booleans, missing installations and unavailable Node without creating an app',()=>{
  const f=fixture();try{
    assert.throws(()=>f.shortcuts.set('true'),/布尔/);
    const missing=new ApplicationShortcuts(f.root,{platform:'linux'});
    assert.equal(missing.status().supported,false);assert.throws(()=>missing.set(true),/安装/);
    const noNode=new ApplicationShortcuts(f.root,{home:f.home,applicationsDir:f.apps,platform:'darwin',node:f.node,env:{PATH:''},probeNode:()=>false});
    assert.throws(()=>noNode.set(true),/Node/);assert.equal(fs.existsSync(noNode.path),false);
    fs.unlinkSync(path.join(f.root,INSTALL_MARKER));
    assert.equal(f.shortcuts.status().supported,false);
  }finally{fs.rmSync(f.base,{recursive:true,force:true});}
});

await test('installer explicit shortcut options preserve data and default to no system shortcut creation',()=>{
  const f=fixture();try{
    const target=path.join(f.base,'installed'),legacy=path.join(f.base,'not-present.json');
    const options={home:f.home,applicationsDir:f.apps,platform:'darwin',node:f.node,env:{PATH:''},probeNode:()=>true};
    assert.equal(install({source:ROOT,target,legacy,shortcutOptions:options}).applicationShortcut.enabled,false);
    assert.equal(fs.existsSync(path.join(f.apps,'Tunnel Studio.app')),false);
    fs.writeFileSync(path.join(target,'data/ssh/local-key'),'do-not-copy');
    assert.equal(install({source:ROOT,target,legacy,shortcutOptions:options,applicationShortcut:true}).applicationShortcut.enabled,true);
    assert.equal(fs.readFileSync(path.join(target,'data/ssh/local-key'),'utf8'),'do-not-copy');
    assert.equal(install({source:ROOT,target,legacy,shortcutOptions:options,applicationShortcut:false}).applicationShortcut.enabled,false);
  }finally{fs.rmSync(f.base,{recursive:true,force:true});}
});

await test('shortcut API is authenticated and does not export machine-specific system settings',async()=>{
  const f=fixture();const panel=await new Panel(f.root,{config:defaults()}).listen(0);panel.shortcuts=f.shortcuts;
  const url=`http://127.0.0.1:${panel.port}/api/application-shortcut`;
  const headers={'X-Panel-Token':panel.token,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(url)).status,401);
    const response=await fetch(url,{method:'POST',headers,body:'{"enabled":true}'});
    assert.equal(response.status,200);assert.equal((await response.json()).applicationShortcut.enabled,true);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"enabled":"false"}'})).status,400);
    assert.equal((await panel.api('GET','/api/settings',new URLSearchParams(),{})).applicationShortcut.enabled,true);
    const exported=await panel.api('GET','/api/export',new URLSearchParams(),{});
    assert.equal(Object.hasOwn(exported.settings,'applicationShortcut'),false);
    assert.equal(Object.hasOwn(exported,'applicationShortcut'),false);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"enabled":false}'})).status,200);
  }finally{await panel.shutdown();fs.rmSync(f.base,{recursive:true,force:true});}
});
