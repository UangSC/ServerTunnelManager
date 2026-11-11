#!/usr/bin/env node
// Dependency-free automation client for both the PowerShell and Node panels.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELP = `Tunnel Studio CLI (Node.js >=22, Windows/macOS)
Usage: node bin/tunnel.mjs [--url http://127.0.0.1:9666] COMMAND
  status
  server list|get ID|add|update ID|delete ID|test ID|command ID
  tunnel list|get ID|add|update ID|delete ID|open ID|close ID|restart ID|port ID|probe ID
  batch open|close|restart|delete ID... [--all] [--yes]
  settings get|set
  startup status|on|off
  shortcut status|on|off
  browser-profile list|get ID|add|update ID|delete ID|apply ID|open ID|discover
    本机 Edge 配置（仅 Windows）；保存后用 apply 应用，delete 仅移除记录。
    字段：--name 名称 --tunnel-id 隧道ID --enabled true|false
  export [--out FILE]
  import --file FILE --yes
  reset --yes
  api GET|POST|PATCH|PUT|DELETE /api/PATH
Input: --json '{...}' | --file FILE | --file - (stdin), or named fields
Examples:
  server add --name demo --host 192.0.2.10 --port 22 --user alice
  tunnel add --name web --server-id srv-ID --local-port 18080 --remote-port 8080 --probe http
  tunnel update t-ID --kind dedicated --proxy-account example --isp-id ISP-01 --proxy-exit-ip 203.0.113.10 --proxy-route direct
  settings set --simulation false --auto-open-on-launch true
Output: JSON on stdout, errors on stderr, nonzero exit on failure.
Only browser-profile open launches a browser; no automatic SSH enrollment or token written to disk.
URL may also be set with TUNNEL_STUDIO_URL; timeout with --timeout (milliseconds).
Deleting resources, importing, resetting and batch delete require --yes.
`;
const fields = new Set(['tunnelId','enabled','name','host','port','user','keyPath','note','color','serverId','localHost','localPort','remoteHost','remotePort','probe','openUrl','group','autoOpen','kind','proxyAccount','ispId','proxyExitIp','proxyRoute',
  'theme','accent','simulation','refreshMs','latencyProbe','autoReconnect','confirmDelete','autoOpenOnLaunch','panelPort','defaultUser','defaultPort','defaultKeyPath','connectTimeout','serverAliveInterval','serverAliveCountMax','strictHostKeyChecking','openBrowserOnStart','logRetention']);
const booleanFields = new Set(['enabled','autoOpen','simulation','latencyProbe','autoReconnect','confirmDelete','autoOpenOnLaunch','strictHostKeyChecking','openBrowserOnStart']);
const numberFields = new Set(['port','localPort','remotePort','refreshMs','panelPort','defaultPort','connectTimeout','serverAliveInterval','serverAliveCountMax','logRetention']);
const camel = value => value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
export function parseArgs(args) {
  const positionals=[], options={}, input={};
  for (let i=0;i<args.length;i++) {
    const arg=args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const split=arg.indexOf('='), name=camel(arg.slice(2,split<0?undefined:split));
    if (Object.hasOwn(options,name)||Object.hasOwn(input,name)) throw new Error(`Duplicate option: --${name}`);
    if (['yes','all','help'].includes(name)) {
      if(split>=0)throw new Error(`--${name} takes no value`);
      options[name]=true; continue;
    }
    const value=split>=0?arg.slice(split+1):args[++i];
    if(value===undefined||value.startsWith('--'))throw new Error(`Missing value: ${arg}`);
    if(['url','timeout','json','file','out'].includes(name)) { options[name]=value; continue; }
    if(!fields.has(name))throw new Error(`Unknown option: ${arg}`);
    if(booleanFields.has(name)) {
      if(!['true','false'].includes(value))throw new Error(`--${name} must be true or false`);
      input[name]=value==='true';
    } else if(numberFields.has(name)) {
      if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error(`--${name} must be an integer`);
      input[name]=Number(value);
    } else input[name]=value;
  }
  if(options.json!==undefined&&options.file!==undefined)throw new Error('Choose --json or --file, not both');
  if((options.json!==undefined||options.file!==undefined)&&Object.keys(input).length)throw new Error('Do not mix named fields with JSON input');
  return {positionals,options,input};
}
export function loopbackUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('Panel URL must be plain http://127.0.0.1:PORT or http://localhost:PORT (no credentials/path)');
  return url.origin;
}
export class Client {
  constructor(url,timeout=10000) {
    this.base=loopbackUrl(url);
    if(!Number.isSafeInteger(timeout)||timeout<100||timeout>120000)throw new Error('Timeout must be 100-120000 milliseconds');
    this.timeout=timeout;this.token=null;
  }
  async fetch(endpoint,options={}) {
    return fetch(this.base+endpoint,{...options,redirect:'error',signal:AbortSignal.timeout(this.timeout)});
  }
  async connect() {
    const response=await this.fetch('/api/health');let health;
    try { health=await response.json(); } catch { throw new Error('Not a Tunnel Studio JSON health endpoint'); }
    if(!response.ok||health.ok!==true||!['Tunnel Studio','tunnel-studio'].includes(health.app))throw new Error('Target is not a healthy Tunnel Studio panel');
    const page=await this.fetch('/');
    if(!page.ok)throw new Error('Cannot read local panel authentication bootstrap');
    this.token=(await page.text()).match(/<meta\s+name="panel-token"\s+content="([A-Za-z0-9_-]+)"/i)?.[1];
    if(!this.token)throw new Error('Panel token missing; update the panel');
    return health;
  }
  async request(method,endpoint,body) {
    if(!/^\/api\/[A-Za-z0-9_/?=&%.-]+$/.test(endpoint)||endpoint.includes('..')||/[\r\n]/.test(endpoint))throw new Error('API path must be /api/...');
    if(!['GET','POST','PATCH','PUT','DELETE'].includes(method))throw new Error('Unsupported HTTP method');
    if(!this.token)await this.connect();
    const response=await this.fetch(endpoint,{method,headers:{'X-Panel-Token':this.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let result;try {result=await response.json();} catch {throw new Error(`API returned non-JSON (HTTP ${response.status})`);}
    if(!response.ok||result.ok===false)throw new Error(result.error||`API failed (HTTP ${response.status})`);
    if(endpoint==='/api/bootstrap')delete result.token;
    if(result.results?.some(item=>item.ok===false)) {
      const error=new Error('One or more batch operations failed');error.result=result;throw error;
    }
    return result;
  }
}
function payload(options,input) {
  if(options.json===undefined&&options.file===undefined)return input;
  const raw=options.json??fs.readFileSync(options.file==='-'?0:options.file,'utf8');
  const value=JSON.parse(raw.replace(/^\uFEFF/,''));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('JSON input must be an object');
  return value;
}
export async function run(args,env=process.env) {
  const {positionals:p,options:o,input}=parseArgs(args);
  if(o.help||!p.length||p[0]==='help')return {help:HELP};
  const client=new Client(o.url||env.TUNNEL_STUDIO_URL||'http://127.0.0.1:9666',o.timeout===undefined?10000:Number(o.timeout));
  const [command,action,id,...extra]=p, data=payload(o,input), call=(m,u,b)=>client.request(m,u,b);
  const confirm=()=>{if(!o.yes)throw new Error('This operation requires explicit --yes');};
  const noExtra=(max)=>{if(p.length>max)throw new Error('Unexpected positional arguments');};
  const requireId=()=>{if(!id||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new Error('Provide a valid resource ID');};
  let result;
  if(command==='status') {noExtra(1);result=await call('GET','/api/state');}
  else if(command==='server'||command==='tunnel') {
    const kind=command==='server'?'servers':'tunnels', endpoint='/api/'+kind;
    if(action==='list') {noExtra(2);result=await call('GET',endpoint);}
    else if(action==='add') {
      noExtra(2);
      if(command==='server') {
        const {settings}=await call('GET','/api/settings');
        data.port??=settings.defaultPort||22;data.user??=settings.defaultUser||'root';data.keyPath??=settings.defaultKeyPath;
      }
      result=await call('POST',endpoint,data);
    } else {
      requireId();noExtra(3);
      if(action==='get')result=await call('GET',endpoint+'/'+id);
      else if(action==='update')result=await call('PATCH',endpoint+'/'+id,data);
      else if(action==='delete') {confirm();result=await call('DELETE',endpoint+'/'+id,{});}
      else if((command==='server'&&['test','command'].includes(action))||(command==='tunnel'&&['open','close','restart','probe','port'].includes(action)))result=await call(action==='port'?'GET':'POST',endpoint+'/'+id+'/'+action,action==='port'?undefined:data);
      else throw new Error('Unknown resource action; use --help');
    }
  } else if(command==='browser-profile') {
    const endpoint='/api/browser-profiles';
    if(action==='list') {noExtra(2);result=await call('GET',endpoint);}
    else if(action==='discover') {noExtra(2);result=await call('POST',endpoint+'/discover',{});}
    else if(action==='add') {noExtra(2);result=await call('POST',endpoint,data);}
    else {
      requireId();noExtra(3);
      if(action==='get')result=await call('GET',endpoint+'/'+id);
      else if(action==='update')result=await call('PATCH',endpoint+'/'+id,data);
      else if(action==='delete') {confirm();result=await call('DELETE',endpoint+'/'+id,{});}
      else if(['apply','open'].includes(action))result=await call('POST',endpoint+'/'+id+'/'+action,{});
      else throw new Error('浏览器配置操作无效，请使用 --help。');
    }
  } else if(command==='settings') {
    noExtra(2);
    if(action==='get')result=await call('GET','/api/settings');
    else if(action==='set') {if(!Object.keys(data).length)throw new Error('Provide settings fields');result=await call('POST','/api/settings',data);}
    else throw new Error('Use settings get|set');
  } else if(command==='startup'||command==='shortcut') {
    noExtra(2);const endpoint=command==='startup'?'/api/startup':'/api/application-shortcut';
    if(action==='status')result=command==='startup'?{ok:true,autostart:(await call('GET','/api/bootstrap')).autostart}:await call('GET',endpoint);
    else if(['on','off'].includes(action))result=await call('POST',endpoint,{enabled:action==='on'});
    else throw new Error('Use status|on|off');
  } else if(command==='batch') {
    if(!['open','close','restart','delete'].includes(action))throw new Error('Use batch open|close|restart|delete');
    let ids=[id,...extra].filter(Boolean);
    if(o.all) {if(ids.length)throw new Error('Do not mix --all and IDs');ids=(await call('GET','/api/tunnels')).tunnels.map(t=>t.id);}
    if(!ids.length)throw new Error('Provide IDs or --all');
    if(action==='delete')confirm();
    result=await call('POST','/api/batch',{action,ids});
  } else if(command==='export') {
    noExtra(1);result=await call('GET','/api/export');
    if(o.out) {fs.writeFileSync(o.out,JSON.stringify(result,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});return {ok:true,path:path.resolve(o.out)};}
  } else if(command==='import') {
    noExtra(1);confirm();if(o.file===undefined&&o.json===undefined)throw new Error('Import requires --file or --json');
    result=await call('POST','/api/import',data);
  } else if(command==='reset') {noExtra(1);confirm();result=await call('POST','/api/reset',{});}
  else if(command==='api') {noExtra(3);if(!action||!id)throw new Error('Use api METHOD /api/PATH');result=await call(action,id,action==='GET'?undefined:data);}
  else throw new Error('Unknown command; use --help');
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const result=await run(process.argv.slice(2));console.log(result.help||JSON.stringify(result,null,2));}
  catch(error) {console.error(JSON.stringify({ok:false,error:error.message,...(error.result?{result:error.result}:{})}));process.exitCode=1;}
}
