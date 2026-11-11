import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Panel, ROOT, defaults } from '../server/app.mjs';
import { run, parseArgs, loopbackUrl, Client } from '../bin/tunnel.mjs';

await test('CLI validates URLs and strictly typed flags before networking', async()=>{
  for(const url of ['https://127.0.0.1:9666','http://192.0.2.10','http://u:p@localhost','http://localhost/api','http://localhost?token=x'])assert.throws(()=>loopbackUrl(url));
  assert.equal(loopbackUrl('http://localhost:9666'),'http://localhost:9666');
  assert.deepEqual(parseArgs(['settings','set','--simulation','false','--panel-port=9667']).input,{simulation:false,panelPort:9667});
  for(const args of [['--simulation','yes'],['--port','12.5'],['--json','{}','--name','x'],['--file','x','--json','{}'],['--url'],['--foo','x'],['--yes=false'],['--name','a','--name','b']])assert.throws(()=>parseArgs(args));
  assert.match((await run(['--help'])).help,/server list/);
  await assert.rejects(run(['reset']),/--yes/);
  await assert.rejects(run(['tunnel','delete','t-test']),/--yes/);
});

await test('CLI automates both resource collections without a browser', async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tunnel-cli-'));
  fs.mkdirSync(path.join(root,'web'),{recursive:true});
  fs.copyFileSync(path.join(ROOT,'web/index.html'),path.join(root,'web/index.html'));
  const panel=await new Panel(root,{config:defaults()}).listen(0);
  const prefix=['--url',`http://127.0.0.1:${panel.port}`];
  const cli=(...args)=>run([...prefix,...args]);
  try {
    assert.equal((await cli('status')).simulation,true);
    assert.equal((await cli('server','list')).servers.length,0);
    const {server}=await cli('server','add','--name','示例','--host','192.0.2.10','--user','alice');
    assert.equal(server.port,22);assert.equal(server.keyPath,path.join('data','ssh','id_ed25519'));
    assert.equal((await cli('server','get',server.id)).server.name,'示例');
    await cli('server','update',server.id,'--note','via CLI');
    const {tunnel}=await cli('tunnel','add','--name','web','--server-id',server.id,'--local-port','48761','--remote-port','8080','--probe','http','--auto-open','true','--kind','dedicated','--proxy-account','example','--isp-id','ISP-01','--proxy-exit-ip','203.0.113.10','--proxy-route','direct');
    assert.equal((await cli('tunnel','list')).tunnels.length,1);
    assert.equal((await cli('tunnel','get',tunnel.id)).tunnel.autoOpen,true);
    await cli('tunnel','update',tunnel.id,'--group','test');
    const dedicated=(await cli('tunnel','get',tunnel.id)).tunnel;
    assert.equal(dedicated.kind,'dedicated');assert.equal(dedicated.proxyAccount,'example');assert.equal(dedicated.proxyExitIp,'203.0.113.10');assert.equal(dedicated.proxyRoute,'direct');
    await assert.rejects(cli('tunnel','update',tunnel.id,'--kind','bad'),/类型/);
    await assert.rejects(cli('tunnel','update',tunnel.id,'--proxy-exit-ip','invalid'),/IP/);
    await assert.rejects(cli('tunnel','update',tunnel.id,'--proxy-route','invalid'),/路由/);
    const restored=new Panel(root);assert.equal(restored.config.tunnels[0].kind,'dedicated');
    await cli('tunnel','open',tunnel.id);
    assert.equal(panel.children.size,0);
    await cli('batch','close','--all');
    await cli('settings','set','--theme','dark','--auto-open-on-launch','false');
    assert.equal((await cli('settings','get')).settings.theme,'dark');
    assert.equal((await cli('startup','status')).autostart.enabled,false);
    assert.equal(typeof (await cli('shortcut','status')).applicationShortcut.enabled,'boolean');
    const bootstrap=await cli('api','GET','/api/bootstrap');assert.ok(!Object.hasOwn(bootstrap,'token'));
    assert.equal(bootstrap.browserProfileSupport.supported,false);
    assert.deepEqual(bootstrap.browserProfiles,[]);
    const profiles=await cli('browser-profile','list');assert.equal(profiles.supported,false);assert.deepEqual(profiles.profiles,[]);
    for(const args of [['add','--tunnel-id',tunnel.id],['discover'],['get','bp-fixture'],['update','bp-fixture','--enabled','false'],['apply','bp-fixture'],['open','bp-fixture'],['delete','bp-fixture','--yes']])await assert.rejects(cli('browser-profile',...args),/仅支持 Windows/);
    await assert.rejects(cli('batch','close','missing'),error=>error.result.results[0].ok===false);
    await assert.rejects(cli('settings','set','--connect-timeout','0'),/整数/);
    const exported=path.join(root,'export.json');
    assert.equal((await cli('export','--out',exported)).ok,true);
    await assert.rejects(cli('export','--out',exported),/EEXIST/);
    await cli('import','--file',exported,'--yes');
    assert.equal(panel.config.settings.simulation,true);assert.equal(panel.config.tunnels[0].autoOpen,false);
    await cli('tunnel','delete',tunnel.id,'--yes');
    await cli('server','delete',server.id,'--yes');
    await cli('reset','--yes');
    assert.equal(panel.config.servers.length,0);
    await assert.rejects(cli('api','GET','/api/../config'),/API path/);
  } finally { await panel.shutdown();fs.rmSync(root,{recursive:true,force:true}); }
});

await test('CLI refuses redirects while discovering its session token', async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(302,{Location:'http://192.0.2.10/'});res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await assert.rejects(new Client(`http://127.0.0.1:${server.address().port}`,500).connect());}
  finally {await new Promise(resolve=>server.close(resolve));}
});
