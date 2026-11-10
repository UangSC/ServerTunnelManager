import fs from 'node:fs';
import path from 'node:path';
import {SyncStore} from '../server/sync.mjs';
import {ROOT,defaults} from '../server/app.mjs';
const run=process.argv[2],folder=process.argv[3];
if(!/^~\/.tunnelStudioSync\/.validation-[a-z0-9-]+$/.test(folder))throw Error('只允许独立验收目录');
const local=fs.mkdtempSync(path.join(ROOT,'tests/run-live-'));
const store=new SyncStore(ROOT,{directory:path.relative(ROOT,local),restricted:process.platform!=='win32'});
store.saveSettings({...store.defaults(),remoteDir:folder});
const config=defaults();config.servers=[{id:'verify-server',name:'跨平台验收',host:'example.com',port:22,user:'deploy'}];config.tunnels=[];
if(run==='write'){
  const p=await store.publishPreview(config,[],false);await store.publish(p.token,config);console.log(JSON.stringify({ok:true,platform:process.platform,operation:'write',servers:1}));
}else{
  const p=await store.pull(config,false);const merged=store.prepareApply(p.token,config);
  if(merged.servers.length!==1||merged.servers[0].name!=='跨平台验收')throw Error('跨平台数据不一致');
  console.log(JSON.stringify({ok:true,platform:process.platform,operation:'read',servers:merged.servers.length}));
}