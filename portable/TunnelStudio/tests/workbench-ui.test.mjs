import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../../shared/tunnel-workbench.js',import.meta.url),'utf8');
function fixture(reduced=false,blockedStorage=false) {
  const handlers={},storage=new Map([['ts-layout-tunnelGrid','list']]);
  let animations=0,cancellations=0;
  const grid={id:'tunnelGrid',dataset:{},getAnimations:()=>[{cancel(){cancellations++;}}],animate(){animations++;}};
  const controls=['cards','list'].map(layout=>({dataset:{layout},attributes:{},classList:{toggle(){}},setAttribute(key,value){this.attributes[key]=value;},closest(){return control;}}));
  const control={dataset:{layoutTarget:grid.id},querySelectorAll:()=>controls};
  const grids={tunnelGrid:grid,dedicatedGrid:{addEventListener(){}},dedicatedOverviewGrid:{addEventListener(){}}};
  const context={window:{},document:{getElementById:id=>grids[id],querySelectorAll:()=>[control],addEventListener:(name,fn)=>handlers[name]=fn},
    localStorage:{getItem:key=>{if(blockedStorage)throw Error('disabled');return storage.get(key);},setItem:(key,value)=>{if(blockedStorage)throw Error('disabled');storage.set(key,value);}},matchMedia:()=>({matches:reduced})};
  vm.runInNewContext(source,context);
  return {workbench:context.window.TunnelWorkbench,grid,controls,storage,get animations(){return animations;},get cancellations(){return cancellations;},
    click(button){handlers.click({target:{closest:selector=>selector==='[data-layout]'?button:null}});}};
}
test('布局恢复、按钮状态、切换动画及重复点击保持一致',()=>{
  const f=fixture();f.workbench.init({});assert.equal(f.grid.dataset.layout,'list');assert.equal(f.controls[1].attributes['aria-pressed'],'true');
  f.click(f.controls[0]);assert.equal(f.grid.dataset.layout,'cards');assert.equal(f.storage.get('ts-layout-tunnelGrid'),'cards');assert.equal(f.controls[0].attributes['aria-pressed'],'true');assert.equal(f.animations,1);assert.equal(f.cancellations,1);
  f.click(f.controls[0]);assert.equal(f.animations,1);
});
test('减少动态效果与禁用存储时仍可切换且不会播放动画',()=>{
  const f=fixture(true,true);f.workbench.init({});assert.equal(f.grid.dataset.layout,'cards');f.click(f.controls[1]);assert.equal(f.grid.dataset.layout,'list');assert.equal(f.animations,0);
});
test('同步账号和出口作为文本显示，不能注入HTML；表单只包含可移植元数据',()=>{
  const f=fixture(),data={kind:'dedicated',proxyAccount:'<img src=x onerror=alert(1)>',ispId:'ISP-01',proxyExitIp:'203.0.113.10',proxyRoute:'vpn'};
  for(const html of [f.workbench.fields(data),f.workbench.summary(data)]) {assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));}
  assert.equal(f.workbench.summary({kind:'standard'}),'');
  const payload=f.workbench.payload({elements:{namedItem:name=>({value:data[name]})}});
  assert.deepEqual(JSON.parse(JSON.stringify(payload)),data);
});
