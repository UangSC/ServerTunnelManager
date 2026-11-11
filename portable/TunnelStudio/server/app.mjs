import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SyncStore } from './sync.mjs';
import { Startup } from './startup.mjs';
import { ApplicationShortcuts } from './shortcuts.mjs';
import { probeTunnel, effectiveProbe } from './probe.mjs';
const execute = promisify(execFile);
export const ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const VERSION = '1.5.0';
const platformName = process.platform === 'darwin' ? 'macOS' : 'Linux';
const openCommand = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
const now = () => new Date().toISOString();
const uid = prefix => prefix + crypto.randomBytes(6).toString('hex');
const fail = message => { throw new Error(message); };
// OpenSSH parses option values again after the shell/argv layer, including spaces.
const sshFile = value => JSON.stringify(String(value));
const q = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const within = (base, target) => target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
// 可写路径和私钥必须在项目内，拒绝符号链接。
export function confined(base, relative) {
  const target = path.resolve(base, relative);
  if (!within(base, target)) fail('路径超出项目授权目录。');
  let current = target;
  while (within(base, current)) {
    let info; try { info = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) fail('不允许使用符号链接路径。');
    if (current === base) break;
    current = path.dirname(current);
  }
  return target;
}
function writeJson(base, relative, value) {
  const target=confined(base,relative), temp=confined(base,relative+'.tmp');
  fs.writeFileSync(temp, JSON.stringify(value,null,2)+'\n',{mode:0o600}); fs.renameSync(temp,target);
}
export function defaults() {
  return {version:2,createdAt:now(),updatedAt:now(),settings:{theme:'light',accent:'ocean',simulation:true,refreshMs:1500,
    latencyProbe:true,autoReconnect:true,confirmDelete:true,autoOpenOnLaunch:false,panelPort:9666,defaultUser:'root',defaultPort:22,
    defaultKeyPath:'data/ssh/id_ed25519',connectTimeout:10,serverAliveInterval:30,serverAliveCountMax:3,
    strictHostKeyChecking:true,openBrowserOnStart:true,logRetention:2000},servers:[],tunnels:[]};
}
function text(value,label,max=200,optional=false) {
  if(typeof value!=='string'||(!optional&&!value.trim())||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(label+'格式不正确。');
  return value.trim();
}
function integer(value,label,min=1,max=65535) {
  if(!Number.isInteger(value)||value<min||value>max)fail(label+`必须为 ${min} - ${max} 的整数。`);return value;
}
function flag(value,label){if(typeof value!=='boolean')fail(label+'必须为布尔值。');return value;}
function host(value){const result=text(value,'服务器地址',253);if(!net.isIP(result)&&!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(result))fail('服务器地址格式不正确。');return result;}
function user(value){const result=text(value,'用户名',64);if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(result))fail('用户名格式不正确。');return result;}
function httpUrl(value){if(!value)return '';text(value,'跳转地址',500);const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('仅允许不含凭据的 HTTP(S) 地址。');return value;}
export function keyPath(root,value){text(value,'私钥路径',500);const target=confined(root,value);if(!within(confined(root,'data/ssh'),target)||target===path.join(root,'data/ssh'))fail('私钥须位于本项目 data/ssh 目录。');return target;}
function serverInput(root,input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('服务器参数格式错误。');
  return {name:text(input.name||input.host,'服务器名称',60),host:host(input.host),port:integer(input.port,'SSH 端口'),user:user(input.user),
    keyPath:path.relative(root,keyPath(root,input.keyPath||'data/ssh/id_ed25519')),note:text(input.note||'','备注',200,true),
    color:['violet','ocean','emerald','amber','rose'].includes(input.color)?input.color:'ocean'};
}
function tunnelInput(root,input,config,existingId=''){
  if(!input||typeof input!=='object')fail('隧道参数格式错误。');
  const localPort=integer(input.localPort,'本机端口'),localHost=input.localHost||'127.0.0.1';
  if(localHost!=='127.0.0.1')fail('当前仅允许监听 127.0.0.1。');
  if(localPort===config.settings.panelPort)fail('不能使用面板自身端口。');
  if(config.tunnels.some(t=>t.id!==existingId&&t.localPort===localPort))fail('本机端口已被其他隧道使用。');
  if(!config.servers.some(s=>s.id===input.serverId))fail('请选择有效服务器。');
  if(input.kind !== undefined && !['standard','dedicated'].includes(input.kind))fail('隧道类型无效。');
  if(input.proxyRoute !== undefined && !['unknown','direct','vpn'].includes(input.proxyRoute))fail('代理路由无效。');
  const proxyExitIp=text(input.proxyExitIp??'','出口 IP',45,true);
  if(proxyExitIp && !net.isIP(proxyExitIp))fail('出口 IP 格式无效。');
  return {kind:input.kind||'standard',proxyAccount:text(input.proxyAccount??'','绑定账号',100,true),ispId:text(input.ispId??'','ISP 标识',32,true),proxyExitIp,proxyRoute:input.proxyRoute||'unknown',name:text(input.name,'隧道名称',60),serverId:input.serverId,localHost,localPort,remoteHost:host(input.remoteHost||'127.0.0.1'),
    remotePort:integer(input.remotePort,'远端端口'),probe:['auto','http','tcp','socks5','none'].includes(input.probe)?input.probe:'tcp',
    openUrl:httpUrl(input.openUrl),group:text(input.group||'','分组',24,true),note:text(input.note||'','备注',200,true),autoOpen:input.autoOpen===undefined?false:flag(input.autoOpen,'自动开启')};
}
function settingsInput(root,input,current){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('设置格式错误。');
  const result={...current},ranges={refreshMs:[700,15000],panelPort:[1024,65535],defaultPort:[1,65535],connectTimeout:[3,120],serverAliveInterval:[5,300],serverAliveCountMax:[1,10],logRetention:[100,5000]};
  for(const [name,value] of Object.entries(input)){
    if(['simulation','latencyProbe','autoReconnect','confirmDelete','autoOpenOnLaunch','strictHostKeyChecking','openBrowserOnStart'].includes(name))result[name]=flag(value,name);
    else if(Object.hasOwn(ranges,name))result[name]=integer(value,name,...ranges[name]);
    else if(name==='defaultUser')result[name]=user(value);
    else if(name==='defaultKeyPath')result[name]=path.relative(root,keyPath(root,value));
    else if(name==='theme'&&['dark','light'].includes(value))result[name]=value;
    else if(name==='accent'&&['violet','ocean','emerald','amber','rose'].includes(value))result[name]=value;
    else fail('不支持的设置：'+name);
  }
  if (!result.strictHostKeyChecking) fail('macOS 版本必须启用主机指纹校验。');
  return result;
}
export function validateConfig(root,data){
  if(!data||!Array.isArray(data.servers)||!Array.isArray(data.tunnels)||data.servers.length>100||data.tunnels.length>200)fail('配置格式或数量不正确。');
  const result=defaults();result.settings=settingsInput(root,data.settings||{},result.settings);
  const ids=new Set();const id=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value)||ids.has(value))fail('配置 ID 无效或重复。');ids.add(value);return value;};
  result.servers=data.servers.map(s=>({...serverInput(root,s),id:id(s.id),passwordless:false,lastCheck:null,lastLatency:null,createdAt: typeof s.createdAt === 'string' && !Number.isNaN(Date.parse(s.createdAt)) ? s.createdAt : now()}));
  for(const t of data.tunnels)result.tunnels.push({...tunnelInput(root,t,result),id:id(t.id),createdAt: typeof t.createdAt === 'string' && !Number.isNaN(Date.parse(t.createdAt)) ? t.createdAt : now(),updatedAt: typeof t.updatedAt === 'string' && !Number.isNaN(Date.parse(t.updatedAt)) ? t.updatedAt : now()});return result;
}
export function commandBundle(root,input){
  const s=serverInput(root,{...input,name:input.host||'服务器'}),key=keyPath(root,s.keyPath),known=confined(root,'data/ssh/known_hosts'),target=`${s.user}@${s.host}`;
  const options=`-F /dev/null -o ${q("UserKnownHostsFile="+sshFile(known))} -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=ask -p ${s.port}`;
  const keyLine=`key=${q(key)}`;
  const remote='umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && { grep -qxF "$pub" ~/.ssh/authorized_keys || printf \'%s\\n\' "$pub" >> ~/.ssh/authorized_keys; } && chmod 600 ~/.ssh/authorized_keys';
  const generate=`${keyLine}; umask 077; mkdir -p "$(dirname "$key")" || exit 1; if [ ! -e "$key" ] && [ ! -e "$key.pub" ]; then ssh-keygen -t ed25519 -f "$key" -C 'tunnelstudio' || exit 1; elif [ -s "$key" ] && [ ! -e "$key.pub" ]; then ssh-keygen -y -f "$key" > "$key.pub.tmp" && mv "$key.pub.tmp" "$key.pub" || exit 1; fi; test -s "$key" && test -s "$key.pub" || { printf '%s\\n' '密钥不完整，请检查后再继续。' >&2; exit 1; }; ssh-keygen -lf "$key.pub" >/dev/null || exit 1`;
  // 公钥以 base64 放入远端参数，终端标准输入留给指纹确认和密码提示。
  const single=`( ${generate}; encoded=$(base64 < "$key.pub" | tr -d '\\r\\n'); remote=${q(remote)}; ssh ${options} -o IdentitiesOnly=yes -i "$key" ${q(target)} "pub=\\$(printf '%s' '$encoded' | base64 -d); $remote" )`;
  const verify=`${keyLine}; ssh -F /dev/null -o ${q("UserKnownHostsFile="+sshFile(known))} -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -i "$key" -p ${s.port} ${q(target)} 'echo SSH_OK'`;
  return {target,shell:'zsh / bash',single,onepass:`${single} && ( ${verify} )`,
    steps:`# 1. 准备项目专用密钥并安装公钥；按终端提示确认指纹、输入服务器密码\n${single}\n\n# 2. 验证免密；有私钥口令时请先将密钥加载到 ssh-agent\n${verify}`,
    sshconfig:'# 使用独立 SSH 配置，不修改 ~/.ssh/config；使用项目专用密钥直接连接\n'+keyLine+'\n'+verify};
}
export function sshArgs(root,s,t,settings){
  const remote=t.remoteHost.includes(':')?`[${t.remoteHost}]`:t.remoteHost;
  return ['-F','/dev/null','-N','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ExitOnForwardFailure=yes','-o','ControlMaster=no',
    '-o',`UserKnownHostsFile=${sshFile(confined(root,'data/ssh/known_hosts'))}`,'-o','GlobalKnownHostsFile=/dev/null','-o','StrictHostKeyChecking=yes',
    '-o',`ConnectTimeout=${settings.connectTimeout}`,'-o',`ServerAliveInterval=${settings.serverAliveInterval}`,'-o',`ServerAliveCountMax=${settings.serverAliveCountMax}`,
    '-i',keyPath(root,s.keyPath),'-p',String(s.port),'-L',`127.0.0.1:${t.localPort}:${remote}:${t.remotePort}`,`${s.user}@${s.host}`];
}
const tcpProbe=(hostname,port,timeout=1800)=>new Promise(resolve=>{
  const start=performance.now(),socket=net.createConnection({host:hostname,port});let done=false;
  const finish=error=>{if(done)return;done=true;socket.destroy();resolve({ok:!error,ms:Math.max(1,Math.round(performance.now()-start)),error:error||''});};
  socket.setTimeout(timeout,()=>finish('连接超时'));socket.once('connect',()=>finish(''));socket.once('error',e=>finish(e.code||'无法连接'));
});
const portFree=port=>new Promise(resolve=>{const listener=net.createServer();listener.once('error',()=>resolve(false));listener.listen({host:'127.0.0.1',port,exclusive:true},()=>listener.close(()=>resolve(true)));});
export class Panel{
  constructor(root=ROOT,{enableSsh=false,config}={}){
    this.root=fs.realpathSync(root);for(const directory of ['data','data/logs','data/ssh'])fs.mkdirSync(confined(this.root,directory),{recursive:true,mode:0o700});
    const configFile=confined(this.root,'data/config.json');
    this.config=validateConfig(this.root,config||(fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8')):defaults()));
    if(!config&&!fs.existsSync(configFile))writeJson(this.root,'data/config.json',this.config);
    this.token=crypto.randomBytes(32).toString('hex');this.enableSsh=enableSsh;this.started=Date.now();this.states=Object.create(null);this.children=new Map();this.jobs=new Map();
    this.sync=new SyncStore(this.root);this.startup=new Startup(this.root);this.shortcuts=new ApplicationShortcuts(this.root);
    this.logs=[];this.activity=[];this.counter=0;this.activityCounter=0;this.history=[];this.closing=false;this.ticking=false;this.probes=0;
    this.log('info','panel',platformName+' 控制台已启动，数据仅保存在项目内。');this.event('info','面板已启动',this.config.settings.simulation?'演示模式：不连接远程服务器':'真实模式：使用项目专用 SSH 文件');
  }
  save(){this.config.updatedAt=now();writeJson(this.root,'data/config.json',this.config);}
  log(level,source,message){
    const line={id:++this.counter,ts:now(),level,source,tunnelId:source==='panel'?'':source,text:String(message).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,1500)};
    this.logs.push(line);this.logs=this.logs.slice(-this.config.settings.logRetention);const file=confined(this.root,'data/logs/panel.log');
    if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024)fs.renameSync(file,confined(this.root,'data/logs/panel.previous.log'));
    fs.appendFileSync(file,JSON.stringify(line)+'\n',{mode:0o600});
  }
  event(kind,title,detail){this.activity.unshift({id:++this.activityCounter,ts:now(),kind,title,detail});this.activity=this.activity.slice(0,80);}
  state(id){return this.states[id]||={status:'offline',error:'',pid:null,since:now(),openedAt:null,uptimeSec:0,latency:null,latencyHistory:[],probeError:'',bytesIn:0,bytesOut:0,reconnectCount:0,retryIn:0};}
  tunnel(id){return this.config.tunnels.find(t=>t.id===id)||fail('隧道不存在。');}
  server(id){return this.config.servers.find(s=>s.id===id)||fail('服务器不存在。');}
  busy(){return Object.values(this.states).some(s=>['online','connecting','closing'].includes(s.status));}
  autostart(){return this.startup.status();}
  snapshot(bootstrap=false){
    const runtime=Object.fromEntries(this.config.tunnels.map(t=>{const s=this.state(t.id);s.uptimeSec=s.openedAt&&s.status==='online'?Math.floor((Date.now()-Date.parse(s.openedAt))/1000):0;return [t.id,{...s,url:t.openUrl,probe:t.probe}];}));
    const states=Object.values(runtime),online=states.filter(s=>s.status==='online'),latencies=online.map(s=>s.latency).filter(Number.isFinite);
    const servers=this.config.servers.map(s=>{const ts=this.config.tunnels.filter(t=>t.serverId===s.id),count=ts.filter(t=>this.state(t.id).status==='online').length;
      return {...s,passwordless:count>0||s.passwordless,tunnelCount:ts.length,onlineCount:count,hasKey:fs.existsSync(keyPath(this.root,s.keyPath)),resolvedKeyPath:keyPath(this.root,s.keyPath),status:count?'online':'offline'};});
    const result={ok:true,now:now(),runtime,servers,activity:this.activity,simulation:this.config.settings.simulation,sshAvailable:fs.existsSync('/usr/bin/ssh'),autostart:this.autostart(),applicationShortcut:this.shortcuts.status(),
      metrics:{total:states.length,online:online.length,connecting:states.filter(s=>s.status==='connecting').length,errors:states.filter(s=>s.status==='error').length,
        avgLatency:latencies.length?Math.round(latencies.reduce((v,n)=>v+n,0)/latencies.length):0,rate:0,traffic:{in:0,out:0,total:0},history:this.history,
        uptimeSec:Math.floor((Date.now()-this.started)/1000),startedAt:new Date(this.started).toISOString()}};
    if(bootstrap)Object.assign(result,{app:'Tunnel Studio',version:VERSION,token:this.token,settings:this.config.settings,
      browserProfiles:[],browserProfileSupport:{supported:false,profiles:[],error:'Edge 配置管理目前仅支持 Windows。'},
      tunnels:this.config.tunnels.map(t=>({...t,server:this.server(t.serverId),url:t.openUrl,effectiveProbe:effectiveProbe(t)})),
      env:{platform:platformName+' '+os.release()+' · '+os.arch(),runtime:'Node.js '+process.versions.node,ssh:'/usr/bin/ssh',sshAvailable:result.sshAvailable,panelPort:this.port,
        dataPath:confined(this.root,'data/config.json'),logsPath:confined(this.root,'data/logs'),rootPath:this.root,demo:this.config.settings.simulation,realSshEnabled:this.enableSsh,trafficAvailable:false,workspaceRestricted:true},
      commands:this.config.servers[0]?commandBundle(this.root,this.config.servers[0]):null});return result;
  }
  async open(id,retry=false){
    if(this.closing)fail('面板正在停止。');const t=this.tunnel(id),s=this.state(id);if(['connecting','online','closing'].includes(s.status))return;
    if(!retry){s.reconnectCount=0;s.retryIn=0;s.retryAt=0;}
    if(!this.config.settings.simulation&&!this.enableSsh)fail('真实 SSH 尚未启用：请先完成 Mac 到服务器的免密验证，再按 README 启用。');
    if(!this.config.settings.simulation){const key=keyPath(this.root,this.server(t.serverId).keyPath);
      if(!fs.existsSync(key)||!fs.statSync(key).isFile())fail('尚无本项目专用私钥；不会读取或修改 ~/.ssh。');
      if(fs.statSync(key).mode&0o077)fail('项目私钥权限过宽，应仅当前用户可读写。');
      if(!fs.existsSync(confined(this.root,'data/ssh/known_hosts')))fail('尚无已确认的主机指纹，请先按手动命令验证连接。');}
    if(!await portFree(t.localPort))fail('本机端口已被占用，请查看端口诊断或修改端口。');
    if(this.closing||!this.config.tunnels.includes(t)||['connecting','online','closing'].includes(s.status))return;
    Object.assign(s,{status:'connecting',since:now(),error:'',stderr:'',openedAt:null,latency:null,probeError:'',probedAt:0});
    this.log('info',id,this.config.settings.simulation?'演示：模拟连接，不执行 SSH。':'使用项目专用密钥建立 SSH 转发。');
    if(this.config.settings.simulation){s.completeAt=Date.now()+450;return;}
    const child=spawn('/usr/bin/ssh',sshArgs(this.root,this.server(t.serverId),t,this.config.settings),{cwd:this.root,stdio:['ignore','ignore','pipe']});
    this.children.set(id,child);s.pid=child.pid;s.connectStarted=Date.now();
    child.stderr.on('data',buffer=>{s.stderr=((s.stderr||'')+buffer.toString('utf8')).slice(-2000);});
    child.on('error',error=>this.failed(id,child,error.message));
    child.on('exit',code=>{if(this.children.get(id)!==child)return;this.children.delete(id);if(s.status==='closing'){Object.assign(s,{status:'offline',pid:null,since:now()});return;}this.failed(id,child,s.stderr?.trim()||`SSH 已退出（${code}）。`);});
  }
  failed(id,child,message){
    const s=this.state(id);if(this.children.get(id)!==child && s.status==='error')return;
    if(this.children.has(id)&&this.children.get(id)!==child)return;this.children.delete(id);
    Object.assign(s,{status:'error',error:message.slice(0,1500),pid:null,since:now(),latency:null,retryIn:0});this.log('error',id,message);this.event('error','隧道连接失败',this.tunnel(id).name);
    if(!this.closing&&this.config.settings.autoReconnect&&s.reconnectCount<3&&!/permission denied|host key|verification|identity|bad permissions|private key/i.test(message)){s.reconnectCount++;s.retryAt=Date.now()+Math.min(30000,3000*2**s.reconnectCount);}
  }
  async close(id){
    this.tunnel(id);const s=this.state(id);s.retryAt=0;s.retryIn=0;s.completeAt=0;const child=this.children.get(id);
    if(child){s.status='closing';child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    this.children.delete(id);Object.assign(s,{status:'offline',pid:null,since:now(),openedAt:null,latency:null,error:'',stderr:''});this.log('info',id,'已关闭本项目隧道并取消重连。');this.event('info','隧道已关闭',this.tunnel(id).name);
  }
  async tick(){
    if(this.ticking||this.closing)return;this.ticking=true;
    try{for(const t of this.config.tunnels){const s=this.state(t.id);
      if(this.config.settings.simulation&&s.status==='connecting'&&Date.now()>=s.completeAt){Object.assign(s,{status:'online',since:now(),openedAt:now(),latency:t.probe==='none'?null:12});this.event('success','演示隧道已开启',t.name);this.log('success',t.id,'演示连接已就绪，没有真实转发。');}
      if(s.retryAt){s.retryIn=Math.max(0,Math.ceil((s.retryAt-Date.now())/1000));if(!s.retryIn){s.retryAt=0;try{await this.open(t.id,true);}catch(e){s.error=e.message;if(s.reconnectCount<3){s.reconnectCount++;s.retryAt=Date.now()+Math.min(30000,3000*2**s.reconnectCount);}}}}
      if(!this.config.settings.simulation&&s.status==='connecting'&&this.children.has(t.id)&&(await tcpProbe('127.0.0.1',t.localPort,150)).ok&&s.status==='connecting'){Object.assign(s,{status:'online',since:now(),openedAt:now()});this.event('success','SSH 隧道已开启',t.name);}
      if(s.status==='online'&&t.probe!=='none'&&this.config.settings.latencyProbe&&this.probes<8&&Date.now()-(s.probedAt||0)>5000){
        s.probedAt=Date.now();this.probes++;const openedAt=s.openedAt;
        const task=this.config.settings.simulation?Promise.resolve({ok:true,ms:12,error:''}):probeTunnel(t,1200);
        task.then(probe=>{if(!this.closing&&this.states[t.id]===s&&s.status==='online'&&s.openedAt===openedAt){
          s.latency=probe.ok?probe.ms:null;s.probeError=probe.error;s.latencyHistory.push(s.latency);s.latencyHistory=s.latencyHistory.slice(-36);
        }}).catch(error=>{if(!this.closing&&s.status==='online')s.probeError=error.message;}).finally(()=>this.probes--);
      }
    }const metrics=this.snapshot().metrics;this.history.push({ts:now(),rate:0,latency:metrics.avgLatency,online:metrics.online});this.history=this.history.slice(-40);
    }finally{this.ticking=false;}
  }
  async diagnosis(t){
    if(await portFree(t.localPort))return {kind:'free',message:'端口空闲，可开启隧道。',listeners:[]};
    if(this.children.has(t.id))return {kind:'managed',message:'端口由本面板创建的 SSH 使用，请通过页面关闭。',listeners:[{pid:this.children.get(t.id).pid,name:'ssh',addresses:[`127.0.0.1:${t.localPort}`]}]};
    try{const {stdout}=await execute(process.platform==='darwin'?'/usr/sbin/lsof':'lsof',['-nP',`-iTCP:${t.localPort}`,'-sTCP:LISTEN','-Fpcn'],{timeout:2500});const listeners=[];let item;
      for(const line of stdout.split('\n')){if(line.startsWith('p')){item={pid:Number(line.slice(1)),name:'未知',addresses:[]};listeners.push(item);}else if(item&&line.startsWith('c'))item.name=line.slice(1);else if(item&&line.startsWith('n'))item.addresses.push(line.slice(1));}
      return {kind:listeners.length?'external':'unknown',message:'不会接管或结束外部进程；可修改本机端口。',listeners};
    }catch{return {kind:'unknown',message:'端口不可绑定，但未能核实监听进程；不会结束外部进程。',listeners:[]};}
  }
  async api(method,pathname,query,body){
    const config=this.config;
    if(method==='GET'&&pathname==='/api/settings')return {ok:true,settings:structuredClone(config.settings),autostart:this.autostart(),applicationShortcut:this.shortcuts.status()};
    if(method==='GET'&&pathname==='/api/bootstrap')return this.snapshot(true);
    if(method==='GET'&&pathname==='/api/browser-profiles')return {ok:true,supported:false,profiles:[],error:'Edge 配置管理目前仅支持 Windows。'};
    if(pathname==='/api/browser-profiles'||pathname.startsWith('/api/browser-profiles/'))fail('Edge 配置管理目前仅支持 Windows。');
    if(method==='GET'&&pathname==='/api/state')return this.snapshot();
    if(method==='GET'&&pathname==='/api/logs')return {ok:true,lines:this.logs.filter(l=>l.id>Number(query.get('since')||0)&&(!query.get('source')||query.get('source')==='all'||l.source===query.get('source'))).slice(-Math.min(1000,Math.max(20,Number(query.get('limit'))||300))),lastId:this.counter};
    if(method==='POST'&&pathname==='/api/logs/clear'){this.logs=[];this.log('info','panel','内存日志已清空。');return {ok:true};}
    if(method==='POST'&&pathname==='/api/activity/clear'){this.activity=[];return {ok:true};}
    if(method==='POST'&&pathname==='/api/settings'){
      const next=settingsInput(this.root,body,config.settings);
      if(next.panelPort!==config.settings.panelPort&&config.tunnels.some(t=>t.localPort===next.panelPort))fail('面板端口与隧道冲突。');
      if(next.simulation!==config.settings.simulation&&this.busy())fail('请先关闭全部隧道，再切换运行模式。');
      if(!next.autoReconnect)for(const state of Object.values(this.states)){state.retryAt=0;state.retryIn=0;}
      config.settings=next;this.save();return {ok:true,settings:next,autostart:this.autostart()};
    }
    if(method==='POST'&&pathname==='/api/startup')return {ok:true,autostart:await this.startup.set(body.enabled)};
    if(method==='GET'&&pathname==='/api/application-shortcut')return {ok:true,applicationShortcut:this.shortcuts.status()};
    if(method==='POST'&&pathname==='/api/application-shortcut')return {ok:true,applicationShortcut:await this.shortcuts.set(body.enabled)};
    if(method==='GET'&&pathname==='/api/sync/settings')return {ok:true,settings:this.sync.settings()};
    if(method==='POST'&&pathname==='/api/sync/settings')return {ok:true,settings:this.sync.saveSettings(body)};
    if(method==='POST'&&pathname==='/api/sync/pull-preview')return await this.sync.pull(config,body.includeLogs);
    if(method==='POST'&&pathname==='/api/sync/pull-apply'){
      if(body.confirm!==true)fail('覆盖当前配置前需要确认。');
      const merged=this.sync.prepareApply(body.token,config),backup=this.sync.backup(config,this.logs);
      for(const t of config.tunnels)await this.close(t.id);
      const previous=structuredClone(config);
      try{config.servers=merged.servers;config.tunnels=merged.tunnels;this.save();}
      catch(error){this.config=previous;throw error;}
      this.states=Object.create(null);this.sync.consume();
      if(merged.includeLogs){
        writeJson(this.root,'data/sync/imported-logs.json',merged.logs);
        for(const line of merged.logs)this.logs.push({...line,id:++this.counter,tunnelId:line.source==='panel'?'':line.source});
        this.logs=this.logs.slice(-config.settings.logRetention);
      }
      this.event('success','服务器与面板列表已同步','覆盖前备份：'+backup);
      return {ok:true,backup,servers:config.servers.length,tunnels:config.tunnels.length,includeLogs:merged.includeLogs};
    }
    if(method==='POST'&&pathname==='/api/sync/publish-preview')return await this.sync.publishPreview(config,this.logs,body.includeLogs);
    if(method==='POST'&&pathname==='/api/sync/publish-apply'){
      if(body.confirm!==true)fail('覆盖同步服务器前需要确认。');
      return await this.sync.publish(body.token,config);
    }
    if(method==='GET'&&pathname==='/api/export')return {...structuredClone(config),exported:now(),app:'Tunnel Studio',versionApp:VERSION};
    if(method==='POST'&&pathname==='/api/import'){
      const incoming=structuredClone(body.config||body);
      const migrateKey=value=>typeof value==='string'&&(/^[A-Za-z]:[\\/]/.test(value)||value==='~/.ssh/id_ed25519')?'data/ssh/id_ed25519':value;
      if(incoming.settings)incoming.settings.defaultKeyPath=migrateKey(incoming.settings.defaultKeyPath);
      if(Array.isArray(incoming.servers))for(const server of incoming.servers)server.keyPath=migrateKey(server.keyPath);
      const next=validateConfig(this.root,incoming);next.settings.simulation=true;next.settings.autoOpenOnLaunch=false;next.tunnels.forEach(t=>t.autoOpen=false);
      const backup=this.sync.backup(config,this.logs);
      for(const t of config.tunnels)await this.close(t.id);
      this.config=next;this.states=Object.create(null);this.save();this.event('warning','配置已导入','已切换演示模式，认证状态需在本机重新验证。');return {ok:true,backup,imported:{servers:next.servers.length,tunnels:next.tunnels.length}};
    }
    if(method==='POST'&&pathname==='/api/reset'){
      const backup=this.sync.backup(config,this.logs),settings={...config.settings,panelPort:this.port};
      for(const t of config.tunnels)await this.close(t.id);
      this.config=defaults();this.config.settings=settings;this.states=Object.create(null);this.save();return {ok:true,backup};
    }
    if(method==='POST'&&pathname==='/api/passwordless/command')return {ok:true,command:commandBundle(this.root,body)};
    if(method==='POST'&&pathname==='/api/passwordless'){
      if(body.password)fail('当前版本不接收或保存密码，请使用手动命令。');
      const command=commandBundle(this.root,body),id=uid('pw-');
      const message='当前仅生成手动命令，未创建密钥、未连接服务器、未写入公钥。在终端执行后请验证免密连接。';
      const job={id,status:'manual',simulation:config.settings.simulation,host:body.host,user:body.user,port:body.port,message,command,
        steps:['key','generate','install','verify','save'].map(step=>({id:step,status:'pending',detail:'等待在终端手动执行'}))};
      this.jobs.set(id,job);if(this.jobs.size>20)this.jobs.delete(this.jobs.keys().next().value);return {ok:true,jobId:id,job};
    }
    if(method==='GET'&&pathname==='/api/passwordless')return {ok:true,job:this.jobs.get(query.get('id'))||fail('任务不存在。')};
    if(method==='POST'&&pathname==='/api/tunnels/order'){
      if(!Array.isArray(body.ids)||new Set(body.ids).size!==body.ids.length)fail('排序参数不正确。');
      const ordered=body.ids.map(id=>this.tunnel(id));config.tunnels=[...ordered,...config.tunnels.filter(t=>!body.ids.includes(t.id))];this.save();return {ok:true};
    }
    if(method==='POST'&&pathname==='/api/batch'){
      if(!['open','close','restart','delete'].includes(body.action)||!Array.isArray(body.ids))fail('批量操作参数不正确。');
      const results=[];for(const id of [...new Set(body.ids)].slice(0,200)){
        try{await this.api(body.action==='delete'?'DELETE':'POST',`/api/tunnels/${encodeURIComponent(id)}${body.action==='delete'?'':'/'+body.action}`,new URLSearchParams(),{});results.push({id,ok:true});}catch(e){results.push({id,ok:false,error:e.message});}
      }return {ok:true,results};
    }
    const match=pathname.match(/^\/api\/(servers|tunnels)(?:\/([A-Za-z0-9_-]+))?(?:\/(test|command|port|open|close|restart|probe))?$/);
    if(match){
      const [,kind,id,action]=match,list=config[kind],item=id?(kind==='servers'?this.server(id):this.tunnel(id)):null;
      if(method==='GET'&&!action)return {ok:true,[id?(kind==='servers'?'server':'tunnel'):kind]:structuredClone(id?item:list)};
      if(method==='POST'&&!id){
        if(list.length>=(kind==='servers'?100:200))fail('数量已达到上限。');
        const entry={...(kind==='servers'?serverInput(this.root,body):tunnelInput(this.root,body,config)),id:uid(kind==='servers'?'srv-':'t-'),createdAt:now(),updatedAt:now()};
        if(kind==='servers')Object.assign(entry,{passwordless:false,lastCheck:null,lastLatency:null});
        list.push(entry);this.save();this.event('success',kind==='servers'?'服务器已添加':'隧道已添加',entry.name);return {ok:true,[kind==='servers'?'server':'tunnel']:entry};
      }
      if(item&&!action&&['PATCH','PUT'].includes(method)){
        if((kind==='tunnels'&&['online','connecting','closing'].includes(this.state(id).status))||(kind==='servers'&&config.tunnels.some(t=>t.serverId===id&&['online','connecting','closing'].includes(this.state(t.id).status))))fail('请先关闭相关隧道，再编辑配置。');
        const next=kind==='servers'?serverInput(this.root,{...item,...body}):tunnelInput(this.root,{...item,...body},config,id);
        if(kind==='tunnels'&&next.localPort!==item.localPort&&next.openUrl&&next.openUrl===item.openUrl){
          const url=new URL(next.openUrl);
          if(['127.0.0.1','localhost'].includes(url.hostname)&&Number(url.port||(url.protocol==='https:'?443:80))===item.localPort){url.port=String(next.localPort);next.openUrl=url.toString();}
        }
        for(const tunnel of config.tunnels.filter(t=>kind==='tunnels'?t.id===id:t.serverId===id)){
          Object.assign(this.state(tunnel.id),{retryAt:0,retryIn:0,status:'offline',error:'',probeError:''});
        }
        Object.assign(item,next,{updatedAt:now()});if(kind==='servers')item.passwordless=false;this.save();return {ok:true,[kind==='servers'?'server':'tunnel']:item};
      }
      if(item&&!action&&method==='DELETE'){
        if(kind==='servers'&&config.tunnels.some(t=>t.serverId===id))fail('服务器仍有关联隧道，请先删除隧道。');
        if(kind==='tunnels')await this.close(id);config[kind]=list.filter(x=>x.id!==id);delete this.states[id];this.save();return {ok:true,id};
      }
      if(item&&kind==='servers'&&action==='command'&&method==='POST')return {ok:true,command:commandBundle(this.root,item)};
      if(item&&kind==='servers'&&action==='test'&&method==='POST'){
        const result=config.settings.simulation?{ok:true,ms:12,error:'',simulation:true}:await tcpProbe(item.host,item.port);
        item.lastCheck=now();item.lastLatency=result.ok?result.ms:null;this.save();this.log(result.ok?'success':'error','panel',`${config.settings.simulation?'演示：':'TCP 连通性测试：'}${item.name}，此测试不验证 SSH 认证。`);return {...result,server:item};
      }
      if(item&&kind==='tunnels'&&action==='port'&&method==='GET')return {ok:true,host:item.localHost,port:item.localPort,diagnosis:await this.diagnosis(item)};
      if(item&&kind==='tunnels'&&method==='POST'){
        if(action==='open')await this.open(id);else if(action==='close')await this.close(id);else if(action==='restart'){await this.close(id);await this.open(id);}
        else if(action==='probe'){if(this.state(id).status!=='online')fail('隧道未开启。');const probe=config.settings.simulation?{ok:true,ms:12,error:''}:await probeTunnel(item);return {ok:probe.ok,latency:probe.ok?probe.ms:null,error:probe.error,history:this.state(id).latencyHistory};}
        else fail('不支持的操作。');return {ok:true,id,action,state:this.snapshot().runtime};
      }
    }
    if(method==='POST'&&pathname==='/api/open-url'){
      const url=httpUrl(body.url);if(!url)fail('没有可打开的地址。');
      if(!config.tunnels.some(t=>t.openUrl===url&&this.state(t.id).status==='online')||config.settings.simulation)fail('仅允许打开已就绪的真实隧道地址。');
      await execute(openCommand,[url],{cwd:this.root,timeout:3000});return {ok:true};
    }
    if(method==='POST'&&pathname==='/api/open-folder'){
      await execute(openCommand,[confined(this.root,body.kind==='logs'?'data/logs':body.kind==='web'?'web':'data')],{cwd:this.root,timeout:3000});return {ok:true};
    }
    if(method==='POST'&&pathname==='/api/open-terminal')fail('请手动打开终端；面板不会自动执行终端命令。');
    if(method==='POST'&&pathname==='/api/shutdown'){setTimeout(()=>this.shutdown(),100);return {ok:true,message:'面板即将停止，本面板创建的隧道也会关闭。'};}
    fail('接口不存在或请求方法不支持。');
  }
  async listen(port=this.config.settings.panelPort){
    this.port=port;
    this.http=http.createServer(async(req,res)=>{
      const send=(status,data,type='application/json; charset=utf-8')=>{
        const content=Buffer.isBuffer(data)?data:Buffer.from(type.startsWith('application/json')?JSON.stringify(data):String(data));
        res.writeHead(status,{'Content-Type':type,'Content-Length':content.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
          'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
        res.end(req.method==='HEAD'?undefined:content);
      };
      try{
        const allowed=new Set([`127.0.0.1:${this.port}`,`localhost:${this.port}`]);
        if(!allowed.has(req.headers.host))return send(403,{ok:false,error:'仅允许从本机访问。'});
        if(req.headers.origin&&![`http://127.0.0.1:${this.port}`,`http://localhost:${this.port}`].includes(req.headers.origin))return send(403,{ok:false,error:'请求来源无效。'});
        const parsed=new URL(req.url,`http://127.0.0.1:${this.port}`),pathname=decodeURIComponent(parsed.pathname);
        if(pathname==='/api/health'&&req.method==='GET')return send(200,{ok:true,app:'Tunnel Studio',version:VERSION,pid:process.pid,port:this.port,rootPath:this.root,uptimeSec:Math.floor((Date.now()-this.started)/1000)});
        if(pathname.startsWith('/api/')){
          if(req.headers['x-panel-token']!==this.token)return send(401,{ok:false,error:'令牌无效，请刷新页面。'});
          if(!['GET','POST','PATCH','PUT','DELETE'].includes(req.method))return send(405,{ok:false,error:'请求方法不支持。'});
          let body={},size=0;const chunks=[];
          if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
            for await(const chunk of req){size+=chunk.length;if(size>1024*1024)return send(413,{ok:false,error:'请求体过大。'});chunks.push(chunk);}
            if(size){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return send(415,{ok:false,error:'仅支持 JSON。'});body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))fail('请求参数格式错误。');}
          }
          const operation=(this.queue||Promise.resolve()).then(()=>this.api(req.method,pathname,parsed.searchParams,body));this.queue=operation.catch(()=>{});return send(200,await operation);
        }
        if(!['GET','HEAD'].includes(req.method))return send(405,{ok:false,error:'请求方法不支持。'});
        const files={'/assets/tunnel-workbench.js':'assets/tunnel-workbench.js','/':'index.html','/index.html':'index.html','/assets/app.js':'assets/app.js','/assets/application-shortcut-ui.js':'assets/application-shortcut-ui.js','/assets/sync-ui.js':'assets/sync-ui.js','/assets/app.css':'assets/app.css','/assets/favicon.svg':'assets/favicon.svg','/preview.png':'preview.png'};
        if(!Object.hasOwn(files,pathname))return send(404,{ok:false,error:'文件不存在。'});
        const target=confined(this.root,'web/'+files[pathname]),ext=path.extname(target),types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
        let data=fs.readFileSync(target);if(ext==='.html')data=Buffer.from(data.toString('utf8').replaceAll('__PANEL_TOKEN__',this.token).replaceAll('__APP_VERSION__',VERSION));send(200,data,types[ext]);
      }catch(e){send(400,{ok:false,error:e.message});}
    });
    this.http.requestTimeout=10000;this.http.headersTimeout=10000;this.http.timeout=10000;
    await new Promise((resolve,reject)=>{this.http.once('error',reject);this.http.listen(port,'127.0.0.1',resolve);});this.port=this.http.address().port;
    this.timer=setInterval(()=>{
      if(this.tickQueued||this.closing)return;
      this.tickQueued=true;
      const work=(this.queue||Promise.resolve()).then(()=>this.tick());
      this.queue=work.catch(e=>this.log('error','panel',e.message)).finally(()=>{this.tickQueued=false;});
    },500);return this;
  }
  async shutdown(){if(this.closing)return;this.closing=true;clearInterval(this.timer);for(const t of this.config.tunnels)await this.close(t.id);if(this.http)await new Promise(resolve=>{this.http.close(resolve);this.http.closeIdleConnections();});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),index=args.indexOf('--port'),panel=new Panel(ROOT,{enableSsh:args.includes('--enable-ssh')});
  const port=index<0?panel.config.settings.panelPort:integer(Number(args[index+1]),'面板端口',1024);
  await panel.listen(port);
  if(panel.config.settings.autoOpenOnLaunch)for(const tunnel of panel.config.tunnels.filter(t=>t.autoOpen)){try{await panel.open(tunnel.id);}catch(error){panel.log('error',tunnel.id,error.message);}}
  console.log(`Tunnel Studio: http://127.0.0.1:${panel.port}/ （${panel.config.settings.simulation?'演示模式':'真实模式'}）`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>panel.shutdown().catch(e=>{console.error(e.message);process.exitCode=1;}));
}
