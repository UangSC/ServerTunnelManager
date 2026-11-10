import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../server/app.mjs';
const source=fs.readFileSync(path.join(ROOT,'web/assets/application-shortcut-ui.js'),'utf8');
function page(){
  const toggle={checked:false,disabled:false,events:{},addEventListener(name,callback){this.events[name]=callback;}};
  const status={textContent:'',title:''},events={},calls=[];
  let state={supported:true,enabled:false,path:'/example/shortcut',message:'ready'},failure=false;
  const context={
    document:{querySelector:()=>({content:'fixture-token'}),getElementById:id=>id==='applicationShortcutToggle'?toggle:status},
    window:{addEventListener:(name,callback)=>{events[name]=callback;}},location:{hash:'#/settings'},
    fetch:async(url,options)=>{
      calls.push({url,options});
      if(failure)return {ok:false,json:async()=>({ok:false,error:'fixture refusal'})};
      if(options.body)state={...state,enabled:JSON.parse(options.body).enabled};
      return {ok:true,json:async()=>({ok:true,applicationShortcut:{...state}})};
    },
  };
  vm.runInNewContext(source,context);
  return {toggle,status,events,calls,setState:value=>{state={...state,...value};},fail:()=>{failure=true;}};
}
await test('shared shortcut UI reads state, sends authenticated JSON and refreshes CLI changes on focus',async()=>{
  const p=page();await new Promise(setImmediate);
  assert.equal(p.toggle.disabled,false);assert.equal(p.toggle.checked,false);
  assert.equal(p.calls[0].options.headers['X-Panel-Token'],'fixture-token');
  assert.equal(p.calls[0].options.redirect,'error');
  p.toggle.checked=true;await p.toggle.events.change();
  assert.equal(p.calls[1].options.method,'POST');assert.deepEqual(JSON.parse(p.calls[1].options.body),{enabled:true});
  assert.equal(p.toggle.checked,true);
  p.setState({enabled:false,message:'changed by CLI'});await p.events.focus();
  assert.equal(p.toggle.checked,false);assert.equal(p.status.textContent,'changed by CLI');
});
await test('shared shortcut UI disables unsupported platforms and rolls back rejected changes',async()=>{
  const p=page();await new Promise(setImmediate);
  p.fail();p.toggle.checked=true;await p.toggle.events.change();
  assert.equal(p.toggle.checked,false);assert.equal(p.status.textContent,'fixture refusal');
  const other=page();await new Promise(setImmediate);
  other.setState({supported:false,enabled:false});await other.events.focus();
  assert.equal(other.toggle.disabled,true);
});
