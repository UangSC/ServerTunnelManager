import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../server/app.mjs';
import {install,INSTALL_ROOT} from './install.mjs';
import {Startup} from '../server/startup.mjs';
const execute=promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const app=path.resolve(ROOT,'../../..');
const node=path.join(app,'Contents/Resources/runtime/node');
const marker=path.join(INSTALL_ROOT,'data/desktop.json');
const lock=path.join(INSTALL_ROOT,'data/desktop.lock');
fs.mkdirSync(path.dirname(lock),{recursive:true,mode:0o700});
let acquired=false;
try{
  // Serialize double-clicks and upgrades. A crashed launcher never leaves a permanent lock.
  for(let attempt=0;attempt<200;attempt++){
    try{fs.mkdirSync(lock,{mode:0o700});acquired=true;break;}
    catch(error){if(error.code!=='EEXIST')throw error;
      try{if(Date.now()-fs.statSync(lock).mtimeMs>60000)fs.rmSync(lock,{recursive:true,force:true});}catch{}
      await delay(100);
    }
  }
  if(!acquired)throw Error('另一个启动器正在更新，请稍后再试。');
  const release=JSON.parse(fs.readFileSync(path.join(ROOT,'bin/release.json'),'utf8'));
  let previous={};try{previous=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{}
  const startup=new Startup(INSTALL_ROOT),wasEnabled=startup.status().enabled;
  const service=path.join(INSTALL_ROOT,'bin/service.mjs');
  const control=async args=>{const result=await execute(node,[service,...args],{timeout:20000});process.stdout.write(result.stdout);};
  if(previous.build!==release.build||!fs.existsSync(service)){
    if(fs.existsSync(service))await control(['stop']);
    install();
  }
  fs.writeFileSync(marker,JSON.stringify({app,node,build:release.build,loginBackend:'smappservice'},null,2)+'\n',{mode:0o600});
  // If moved in Finder, repair the previously enabled login entry to its new bundle location.
  if(wasEnabled&&!startup.status().enabled)await startup.set(true);
  await control(['start','--enable-ssh',...(process.argv.includes('--no-browser')?[]:['--open'])]);
}catch(error){console.error(new Date().toISOString(),error.stderr||error.message);process.exitCode=1;}
finally{if(acquired)fs.rmSync(lock,{recursive:true,force:true});}
