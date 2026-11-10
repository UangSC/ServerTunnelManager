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


test('列表行保留开关与实时状态钩子；其余功能集中到同一个操作菜单',()=>{
  const f=fixture(),t={id:'t-1',name:'<img onerror=bad>',kind:'dedicated',proxyAccount:'account"<script>',localHost:'127.0.0.1',localPort:18001,remoteHost:'127.0.0.1',remotePort:18001,proxyExitIp:'203.0.113.1',proxyRoute:'vpn'};
  const html=f.workbench.row(t,{state:{status:'occupied',error:'<script>bad</script>'},server:{host:'example.com'},statusLabel:'端口占用',icon:name=>`<svg data-icon="${name}"></svg>`});
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;script&gt;'));
  for(const hook of ['data-role="toggle"','data-live="status"','data-live="latency"','data-live="error"','data-act="menu"'])assert.ok(html.includes(hook),hook);
  assert.ok(!html.includes('data-act="open-url"'));
  // 行内不再堆叠功能按钮，操作列只有开关与“更多”。
  for(const legacy of ['data-act="copy"','data-act="connection"','data-act="port"','data-act="logs"','data-act="edit"'])assert.ok(!html.includes(legacy),legacy);
  assert.ok(html.indexOf('data-role="toggle"')>html.indexOf('wb-actions tc-actions'));
  const active=f.workbench.row({...t,url:'http://127.0.0.1:18001/'},{state:{status:'online'},server:{host:'example.com'},statusLabel:'运行中',icon:()=>''});
  assert.match(active,/data-role="toggle"[^>]*checked/);assert.ok(active.includes('data-act="menu"'));
});

test('操作菜单按可用功能生成，避免出现没用的按钮',()=>{
  const f=fixture();
  const acts=list=>JSON.parse(JSON.stringify(list.filter(item=>item.act).map(item=>item.act)));
  const t={id:'t-1',name:'n',kind:'standard',localHost:'127.0.0.1',localPort:18001,remoteHost:'127.0.0.1',remotePort:18001};
  assert.deepEqual(acts(f.workbench.menuItems(t,{active:false})),['connection','copy','port','edit','logs','delete']);
  assert.deepEqual(acts(f.workbench.menuItems({...t,url:'http://127.0.0.1:18001/'},{active:true})),['open-url','connection','copy','port','restart','edit','logs','delete']);
  assert.deepEqual(acts(f.workbench.menuItems({...t,kind:'dedicated'},{active:false})),['connection','copy','port','edit','logs','delete']);
  assert.ok(f.workbench.menuItems(t,{active:false}).some(item=>item.separator));
});
