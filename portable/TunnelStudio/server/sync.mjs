import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX = 2 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const now = () => new Date().toISOString();
const fields = (value, names) => Object.fromEntries(names.map(name => [name, value[name]]));
const serverFields = ['id','name','host','port','user','note','color'];
const tunnelFields = ['id','name','serverId','localHost','localPort','remoteHost','remotePort','probe','openUrl','group','note','kind','proxyAccount','ispId','proxyExitIp','proxyRoute'];
function string(value, label, max = 200, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(label + '格式错误。');
  return value.trim();
}
function port(value) { if (!Number.isInteger(value) || value < 1 || value > 65535) fail('端口无效。'); return value; }
function host(value) { string(value,'地址',253); if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value)) fail('地址格式错误。'); return value; }
function user(value) { string(value,'账号',64); if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) fail('账号格式错误。'); return value; }
function url(value) { if (!value) return ''; string(value,'页面地址',500); const parsed = new URL(value); if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('页面地址必须为不含凭据的 HTTP(S) 地址。'); return value; }
function list(value, max) { if (!Array.isArray(value) || value.length > max) fail('列表格式或数量错误。'); return value; }

// 严格白名单：私钥路径、认证状态、主题、设置和运行记录不会进入同步包。
export function listings(config) {
  return { servers: list(config.servers,100).map(s => fields(s,serverFields)), tunnels: list(config.tunnels,200).map(t => fields(t,tunnelFields)) };
}
export function validateBundle(value) {
  if (!value || value.format !== 'tunnel-studio-sync' || value.version !== 1) fail('同步文件格式不支持。');
  const ids = new Set(), endpoints = new Set(), ports = new Set();
  const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value) || ['__proto__','constructor','prototype'].includes(value) || ids.has(value)) fail('ID 无效或重复。'); ids.add(value); return value; };
  const servers = list(value.servers,100).map(raw => {
    const s = fields(raw,serverFields);
    s.id=id(s.id); s.name=string(s.name,'服务器名称',60); s.host=host(s.host); s.port=port(s.port); s.user=user(s.user);
    s.note=string(s.note||'','备注',200,true); s.color=['violet','ocean','emerald','amber','rose'].includes(s.color)?s.color:'ocean';
    const endpoint=JSON.stringify([s.host.toLowerCase(),s.port,s.user]); if(endpoints.has(endpoint))fail('重复服务器连接。'); endpoints.add(endpoint); return s;
  });
  const tunnels = list(value.tunnels,200).map(raw => {
    const t=fields(raw,tunnelFields);
    t.kind=t.kind===undefined?'standard':t.kind;
    if(!['standard','dedicated'].includes(t.kind))fail('隧道类型无效。');
    t.proxyAccount=string(t.proxyAccount??'','绑定账号',100,true);t.ispId=string(t.ispId??'','ISP 标识',32,true);
    t.proxyExitIp=string(t.proxyExitIp??'','出口 IP',45,true);if(t.proxyExitIp&&!net.isIP(t.proxyExitIp))fail('出口 IP 格式无效。');
    t.proxyRoute=t.proxyRoute===undefined?'unknown':t.proxyRoute;if(!['unknown','direct','vpn'].includes(t.proxyRoute))fail('代理路由无效。');
    t.id=id(t.id); t.name=string(t.name,'隧道名称',60);
    if (!servers.some(s=>s.id===t.serverId)) fail('隧道引用了不存在的服务器。');
    if (!['127.0.0.1','localhost'].includes(t.localHost)) fail('同步仅支持本机回环端口。'); t.localHost='127.0.0.1';
    t.localPort=port(t.localPort); if(ports.has(t.localPort))fail('同步包中存在重复本机端口。'); ports.add(t.localPort);
    t.remoteHost=host(t.remoteHost); t.remotePort=port(t.remotePort); t.openUrl=url(t.openUrl);
    t.group=string(t.group||'','分组',24,true);t.note=string(t.note||'','备注',200,true);
    if(!['auto','http','tcp','socks5','none'].includes(t.probe))fail('探测方式无效。'); return t;
  });
  const result={format:'tunnel-studio-sync',version:1,createdAt:typeof value.createdAt==='string'?value.createdAt:now(),servers,tunnels};
  if (Object.hasOwn(value,'logs')) result.logs=list(value.logs,500).map(l=>{
    if(!l||typeof l!=='object')fail('日志格式错误。');
    return {ts:string(l.ts,'日志时间',64),level:['info','warn','error','success','debug'].includes(l.level)?l.level:'info',source:string(l.source||'panel','日志源',80),text:string(l.text,'日志文本',4000,true)};
  });
  if(Buffer.byteLength(JSON.stringify(result))>MAX)fail('同步包超过 2 MiB。');return result;
}
export function makeBundle(config, logs, includeLogs) {
  return validateBundle({format:'tunnel-studio-sync',version:1,createdAt:now(),...listings(config),...(includeLogs?{logs:(logs||[]).slice(-500).map(l=>({ts:l.ts,level:l.level,source:l.source,text:l.text}))}:{})});
}
const sameServer=(a,b)=>a&&b&&a.host.toLowerCase()===b.host.toLowerCase()&&a.port===b.port&&a.user===b.user;
export function mergeListings(current,bundle) {
  bundle=validateBundle(bundle);
  const localBindings=[];
  const servers=bundle.servers.map(s=>{
    const previous=current.servers.find(old=>old.id===s.id&&sameServer(old,s))||current.servers.find(old=>sameServer(old,s));
    return {...s,keyPath:previous?.keyPath||current.settings.defaultKeyPath,passwordless:previous?.passwordless===true,lastCheck:previous?.lastCheck||null,lastLatency:previous?.lastLatency??null,createdAt:previous?.createdAt||now()};
  });
  const tunnels=bundle.tunnels.map(t=>{
    const previous=current.tunnels.find(old=>old.id===t.id);
    const same=previous&&sameServer(current.servers.find(s=>s.id===previous.serverId),servers.find(s=>s.id===t.serverId))&&previous.remoteHost===t.remoteHost&&previous.remotePort===t.remotePort;
    const next={...t,autoOpen:same?previous.autoOpen===true:false,createdAt:previous?.createdAt||now(),updatedAt:now()};
    if(same){
      next.localPort=previous.localPort; next.localHost=previous.localHost;
      if(t.localPort!==next.localPort){
        localBindings.push({id:t.id,name:t.name,localPort:next.localPort,remoteSuggestedPort:t.localPort});
        if(next.openUrl){const u=new URL(next.openUrl);if(['127.0.0.1','localhost'].includes(u.hostname)&&Number(u.port||(u.protocol==='https:'?443:80))===t.localPort){u.port=String(next.localPort);next.openUrl=u.toString();}}
      }
    }
    return next;
  });
  // 合并本机端口后再次验证，不能把不同条目的端口合并成冲突。
  validateBundle({format:'tunnel-studio-sync',version:1,servers,tunnels});
  if(tunnels.some(t=>t.localPort===current.settings.panelPort))fail('同步映射与本机面板端口冲突，请先调整映射。');
  return {servers,tunnels,localBindings};
}
function diff(before,after) {
  const old=new Map(before.map(x=>[x.id,x])), next=new Map(after.map(x=>[x.id,x]));
  return {added:after.filter(x=>!old.has(x.id)).map(x=>x.name),removed:before.filter(x=>!next.has(x.id)).map(x=>x.name),changed:after.filter(x=>old.has(x.id)&&hash(old.get(x.id))!==hash(x)).map(x=>x.name),total:after.length};
}
export function preview(before,after) {
  before=listings(before);after=listings(after);
  return {servers:diff(before.servers,after.servers),tunnels:diff(before.tunnels,after.tunnels)};
}
export function safePath(root, relative) {
  const target=path.resolve(root,relative),prefix=root+path.sep;
  if(target!==root&&!target.startsWith(prefix))fail('同步文件路径超出项目。');
  let current=target;
  while(current===root||current.startsWith(prefix)){
    try{if(fs.lstatSync(current).isSymbolicLink())fail('同步目录不接受符号链接。');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(current===root)break;current=path.dirname(current);
  }return target;
}
function write(root,name,data){const file=safePath(root,name),temp=safePath(root,name+'.tmp');fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}
function read(root,name){return JSON.parse(fs.readFileSync(safePath(root,name),'utf8'));}

// 同步主机只需 OpenSSH + Python 3。所有写入均局限于用户指定目录。
export const remoteProgram=String.raw`
import os,sys,json,hashlib,tempfile
from pathlib import Path
MAX=2097152
mode,folder=sys.argv[1:3]
directory=Path(os.path.expanduser(folder))
if not directory.is_absolute() or '..' in directory.parts: raise Exception('同步目录必须为绝对路径或 ~/ 路径')
for parent in [directory,*directory.parents]:
    if parent.is_symlink(): raise Exception('同步目录不允许符号链接')
target=directory/'bundle.json'
lock=directory/'.publish.lock'
def existing():
    if target.is_symlink(): raise Exception('同步文件不允许符号链接')
    if not target.exists(): return None,None
    if target.stat().st_size>MAX: raise Exception('同步文件超过 2 MiB')
    raw=target.read_bytes()
    return hashlib.sha256(raw).hexdigest(),json.loads(raw)
if mode=='read':
    revision,bundle=existing()
    print(json.dumps({'revision':revision,'bundle':bundle}))
elif mode=='write':
    incoming=sys.stdin.buffer.read(MAX+1)
    if len(incoming)>MAX: raise Exception('上传内容超过 2 MiB')
    payload=json.loads(incoming)
    raw=(json.dumps(payload['bundle'],ensure_ascii=False,indent=2)+'\n').encode()
    if len(raw)>MAX: raise Exception('同步文件超过 2 MiB')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock.mkdir(mode=0o700)
    temp=None
    try:
        revision,_=existing()
        if revision!=payload['expected']: raise Exception('服务器配置已改变，请重新预览')
        fd,temp=tempfile.mkstemp(prefix='.bundle-',dir=str(directory))
        with os.fdopen(fd,'wb') as f: f.write(raw);f.flush();os.fsync(f.fileno())
        os.replace(temp,target);temp=None
        print(json.dumps({'ok':True,'revision':hashlib.sha256(raw).hexdigest()}))
    finally:
        if temp: os.unlink(temp)
        lock.rmdir()
else: raise Exception('操作无效')
`;
export class SyncStore {
  constructor(root,{directory='data/sync',restricted=true,transport}={}) {
    this.root=fs.realpathSync(root);this.directory=directory;this.restricted=restricted;this.transport=transport;
    fs.mkdirSync(safePath(this.root,directory),{recursive:true,mode:0o700});
  }
  file(name){return this.directory+'/'+name;}
  defaults(){return {host:'',port:22,user:'deploy',remoteDir:'~/.tunnelStudioSync',keyPath:this.restricted?'data/ssh/id_ed25519':'~/.ssh/id_ed25519',knownHostsPath:this.restricted?'data/ssh/known_hosts':'~/.ssh/known_hosts'};}
  resolveFile(value){
    string(value,'SSH 文件路径',500);
    if(this.restricted){const target=safePath(this.root,value);if(!target.startsWith(path.join(this.root,'data/ssh')+path.sep))fail('SSH 文件必须位于本项目 data/ssh。');return target;}
    return path.resolve(value.startsWith('~/')||value.startsWith('~\\')?path.join(os.homedir(),value.slice(2)):value);
  }
  validateSettings(input){
    const result={host:host(input.host),port:port(input.port),user:user(input.user),remoteDir:string(input.remoteDir,'同步目录',500),keyPath:input.keyPath,knownHostsPath:input.knownHostsPath};
    if(!/^(~\/|\/)/.test(result.remoteDir)||result.remoteDir.split('/').includes('..')||result.remoteDir.includes('\\'))fail('同步目录必须为绝对路径或 ~/ 路径，不能含 ..。');
    this.resolveFile(result.keyPath);this.resolveFile(result.knownHostsPath);return result;
  }
  settings(){try{return this.validateSettings(read(this.root,this.file('settings.json')));}catch(e){if(e.code==='ENOENT')return this.defaults();throw e;}}
  saveSettings(input){const settings=this.validateSettings(input);write(this.root,this.file('settings.json'),settings);return settings;}
  async remote(mode,payload){
    const settings=this.settings();if(this.transport)return this.transport(mode,settings,payload);
    this.validateSettings(settings); // Require an explicitly configured host before any real SSH operation.
    const key=this.resolveFile(settings.keyPath),known=this.resolveFile(settings.knownHostsPath);
    if(!fs.existsSync(key)||!fs.statSync(key).isFile())fail('同步私钥不存在，请先在本机完成 deploy 账号的免密配置。');
    if(!fs.existsSync(known)||!fs.statSync(known).isFile())fail('尚无已确认的同步主机指纹，请先在终端核对。');
    const command='python3 -c '+quote(remoteProgram.replaceAll('\r\n','\n'))+' '+quote(mode)+' '+quote(settings.remoteDir);
    const args=['-F',process.platform==='win32'?'NUL':'/dev/null','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=8','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o',`UserKnownHostsFile=${JSON.stringify(known)}`,'-o',`GlobalKnownHostsFile=${process.platform==='win32'?'NUL':'/dev/null'}`,'-i',key,'-p',String(settings.port),`${settings.user}@${settings.host}`,command];
    const executable=process.platform==='win32'?path.join(process.env.WINDIR||'C:\\Windows','System32/OpenSSH/ssh.exe'):'/usr/bin/ssh';
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:this.root,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout=[],stderr=[],size=0,errorSize=0,finished=false;
      const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{child.kill();finish(new Error('SSH 同步超时，请检查网络和免密认证。'));},20000);
      child.on('error',e=>finish(e));child.stdin.on('error',()=>{});
      child.stdout.on('data',b=>{size+=b.length;if(size>MAX+65536){child.kill();finish(new Error('远端响应过大。'));}else stdout.push(b);});
      child.stderr.on('data',b=>{errorSize+=b.length;if(errorSize<8192)stderr.push(b);});
      child.on('close',code=>{if(code!==0)return finish(new Error('SSH 同步失败：'+Buffer.concat(stderr).toString('utf8').slice(-3000)));try{finish(null,JSON.parse(Buffer.concat(stdout).toString('utf8')));}catch{finish(new Error('服务器返回的同步数据不是有效 JSON。'));}});
      child.stdin.end(payload?JSON.stringify(payload):'');
    });
  }
  stage(data){const token=crypto.randomBytes(24).toString('hex');write(this.root,this.file('pending.json'),{...data,token,expires:Date.now()+600000,settingsHash:hash(this.settings())});return token;}
  pending(token,current,kind){
    const data=read(this.root,this.file('pending.json'));
    if(typeof token!=='string'||data.token!==token||data.kind!==kind||data.expires<Date.now()||data.settingsHash!==hash(this.settings()))fail('预览已失效，请重新操作。');
    if(data.localHash!==hash(current))fail('本机配置在预览后发生变化，请重新预览。');return data;
  }
  consume(){write(this.root,this.file('pending.json'),{expires:0});}
  async pull(current,includeLogs){
    if(typeof includeLogs!=='boolean')fail('请明确选择是否同步日志。');
    const response=await this.remote('read');if(!response.bundle)fail('同步服务器尚无 bundle.json，请先从已配置好的面板发布一次。');
    const bundle=validateBundle(response.bundle),merged=mergeListings(current,bundle);
    const logsAvailable=Object.hasOwn(bundle,'logs');
    if(!includeLogs)delete bundle.logs;
    const stage={kind:'pull',localHash:hash(current),revision:response.revision,bundle,includeLogs:includeLogs&&logsAvailable};
    return {ok:true,token:this.stage(stage),preview:preview(current,merged),localBindings:merged.localBindings,includeLogs:stage.includeLogs,logsAvailable,logCount:includeLogs?(bundle.logs||[]).length:0,createdAt:bundle.createdAt};
  }
  // 后端在应用前重新验证；服务端待确认快照不接受浏览器传回任意配置。
  prepareApply(token,current){const data=this.pending(token,current,'pull'),merged=mergeListings(current,data.bundle);return {...merged,logs:data.includeLogs?(data.bundle.logs||[]):[],includeLogs:data.includeLogs};}
  backup(current,logs){const filename='backup-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex')+'.json';write(this.root,this.file(filename),{config:current,logs});return this.file(filename);}
  async publishPreview(current,logs,includeLogs){
    if(typeof includeLogs!=='boolean')fail('请明确选择是否发布日志。');
    const bundle=makeBundle(current,logs,includeLogs),response=await this.remote('read');
    const before=response.bundle?validateBundle(response.bundle):{servers:[],tunnels:[]};
    return {ok:true,token:this.stage({kind:'publish',localHash:hash(current),revision:response.revision,bundle,includeLogs}),preview:preview(before,bundle),includeLogs,logCount:bundle.logs?.length||0,exists:!!response.bundle};
  }
  async publish(token,current){const data=this.pending(token,current,'publish');const result=await this.remote('write',{expected:data.revision,bundle:data.bundle});this.consume();return {ok:true,revision:result.revision};}
}

// Windows PowerShell 通过标准输入调用同一实现，参数不进入 shell 字符串。
if(process.argv.includes('--worker')){
  try{
    let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>8*MAX)fail('本机输入过大。');}
    const request=JSON.parse(input),store=new SyncStore(request.root,{directory:'Panel/sync',restricted:false});let result;
    switch(request.action){
      case 'settings':result={ok:true,settings:store.settings()};break;
      case 'save-settings':result={ok:true,settings:store.saveSettings(request.body)};break;
      case 'pull':result=await store.pull(request.config,request.body.includeLogs);break;
      case 'prepare':result={ok:true,...store.prepareApply(request.body.token,request.config)};break;
      case 'consume':store.consume();result={ok:true};break;
      case 'publish-preview':result=await store.publishPreview(request.config,request.logs,request.body.includeLogs);break;
      case 'publish':if(request.body.confirm!==true)fail('请先确认覆盖服务器同步配置。');result=await store.publish(request.body.token,request.config);break;
      default:fail('同步操作不支持。');
    }process.stdout.write(JSON.stringify(result));
  }catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
