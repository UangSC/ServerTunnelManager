import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, confined, defaults } from '../server/app.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const directory of ['data','data/logs','data/ssh']) fs.mkdirSync(confined(ROOT,directory),{recursive:true,mode:0o700});
const configPath=confined(ROOT,'data/config.json');
if(!fs.existsSync(configPath))fs.writeFileSync(configPath,JSON.stringify(defaults(),null,2)+'\n',{mode:0o600,flag:'wx'});
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const recordPath=confined(ROOT,'data/service.json');
let record={};
try{record=JSON.parse(fs.readFileSync(recordPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
let activePort=config.settings.panelPort;
const base=port=>`http://127.0.0.1:${port}`;
async function health(port){
  let response;
  try{response=await fetch(base(port)+'/api/health',{signal:AbortSignal.timeout(1000)});}
  catch(error){if(error.cause?.code==='ECONNREFUSED')return null;throw new Error(`无法确认端口 ${port} 的服务状态：${error.message}`);}
  let data;try{data=await response.json();}catch{}
  if(!response.ok||data?.app!=='Tunnel Studio'||data.rootPath!==ROOT||data.port!==port||!Number.isInteger(data.pid))
    throw new Error(`端口 ${port} 由其他服务占用，不会停止或接管。`);
  return data;
}
async function current(){
  const ports=[...new Set([record.root===ROOT?record.port:null,config.settings.panelPort].filter(Number.isInteger))];
  for(const port of ports){const data=await health(port);if(data){activePort=port;return data;}}
  return null;
}
async function start(){
  const running=await current();
  if(running){console.log(`面板已在运行：${base(activePort)}/`);return;}
  const log=fs.openSync(confined(ROOT,'data/logs/service.log'),'a',0o600);
  const args=[path.join(ROOT,'server/app.mjs')];if(process.argv.includes('--enable-ssh'))args.push('--enable-ssh');
  const child=spawn(process.execPath,args,{cwd:ROOT,detached:true,stdio:['ignore',log,log]});fs.closeSync(log);
  let spawnError;child.on('error',error=>{spawnError=error;});child.unref();
  for(let i=0;i<40;i++){
    if(spawnError)throw spawnError;
    await sleep(150);
    const data=await health(config.settings.panelPort);
    if(data){
      // A concurrent launch may have won the bind; only reuse a verified instance of this installation.
      fs.writeFileSync(recordPath,JSON.stringify({pid:data.pid,port:data.port,root:ROOT})+'\n',{mode:0o600});
      activePort=data.port;console.log(`面板已启动：${base(activePort)}/`);return;
    }
    if(child.exitCode!==null)break;
  }
  throw new Error('面板启动失败，请查看 data/logs/service.log。');
}
async function stop(){
  const running=await current();if(!running){console.log('面板未运行。');return;}
  const html=await(await fetch(base(activePort)+'/',{signal:AbortSignal.timeout(2000)})).text();
  const token=html.match(/name="panel-token" content="([^\"]+)"/)?.[1];if(!token)throw new Error('未取得当前面板令牌，停止操作。');
  const response=await fetch(base(activePort)+'/api/shutdown',{method:'POST',headers:{'X-Panel-Token':token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('面板拒绝停止。');
  for(let i=0;i<60;i++){
    await sleep(150);
    if(!await health(activePort)){
      fs.rmSync(recordPath,{force:true});record={};
      console.log('面板及其自建隧道已停止。');return;
    }
  }
  throw new Error('停止尚未完成；不会强制结束未知进程。');
}
const action=process.argv[2]||'status';
try{
  if(action==='start')await start();
  else if(action==='stop')await stop();
  else if(action==='restart'){await stop();await start();}
  else if(action==='status'){const data=await current();console.log(data?`运行中：${base(activePort)}/ · PID ${data.pid}`:'面板未运行。');}
  else throw new Error('用法：node bin/service.mjs start|stop|restart|status [--open] [--enable-ssh]');
  if(process.argv.includes('--open')&&['start','restart'].includes(action))spawn(process.platform==='darwin'?'/usr/bin/open':'xdg-open',[base(activePort)+'/'],{cwd:ROOT,stdio:'ignore'}).on('error',error=>console.error(error.message));
}catch(error){console.error(error.message);process.exitCode=1;}
