import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';

export const LABEL='com.tunnelstudio.panel';
const execute=promisify(execFile);
const normalize=result=>({...result,enabled:!!result.enabled,requiresApproval:!!result.requiresApproval});
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

export class Startup {
  constructor(root,{home=os.homedir(),platform=process.platform,uid=process.getuid?.(),run=execute}={}) {
    this.root=root;this.home=home;this.platform=platform;this.uid=uid;this.run=run;
    this.file=path.join(home,'Library/LaunchAgents',LABEL+'.plist');
  }
  desktop(){
    if(this.platform!=='darwin'||this.root!==path.join(this.home,'Library/Application Support/TunnelStudio'))return null;
    try{
      const record=JSON.parse(fs.readFileSync(path.join(this.root,'data/desktop.json'),'utf8'));
      if(!path.isAbsolute(record.node)||!path.isAbsolute(record.app)||!record.app.endsWith('.app')||
        record.node!==path.join(record.app,'Contents/Resources/runtime/node')||!fs.statSync(record.node).isFile())return null;
      return record;
    }catch{return null;}
  }
  plist(record){
    const args=[record.node,path.join(this.root,'bin/service.mjs'),'start','--enable-ssh'];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg=>'<string>'+xml(arg)+'</string>').join('')}</array>
<key>WorkingDirectory</key><string>${xml(this.root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(this.root,'data/logs/login.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(this.root,'data/logs/login.log'))}</string>
</dict></plist>\n`;
  }
  status(){
    const record=this.desktop();let saved='';
    if(record?.loginBackend==='smappservice') {
      // Polling the page must not repeatedly spawn native helpers.
      if(!this.cached||Date.now()-this.cached.time>5000){
        try{
          const result=normalize(JSON.parse(execFileSync(path.join(record.app,'Contents/MacOS/TunnelStudio'),['--login-status'],{encoding:'utf8',timeout:5000})));
          this.cached={time:Date.now(),result};
        }catch(error){this.cached={time:Date.now(),result:{enabled:false,error:error.message}};}
      }
      return {supported:true,...this.cached.result,expected:`open ${"'"+record.app.replaceAll("'","'\\''")+"'"}`,backend:'SMAppService'};
    }
    try{saved=fs.readFileSync(this.file,'utf8');}catch{}
    return {supported:!!record,enabled:!!record&&saved===this.plist(record),
      expected:record?`open ${"'"+record.app.replaceAll("'","'\\''")+"'"}`:'请先安装 Tunnel Studio.app',
      path:this.file};
  }
  async set(enabled){
    if(typeof enabled!=='boolean')throw Error('登录自启设置必须为布尔值。');
    const record=this.desktop();if(!record)throw Error('请先从 Tunnel Studio.app 启动一次，再设置登录自启。');
    if(record.loginBackend==='smappservice') {
      const {stdout}=await this.run(path.join(record.app,'Contents/MacOS/TunnelStudio'),[enabled?'--login-enable':'--login-disable'],{timeout:10000});
      const result=normalize(JSON.parse(stdout));
      if(!result.ok)throw Error(result.error||'登录项更新失败。');
      this.cached={time:Date.now(),result};
      return this.status();
    }
    const domain=`gui/${this.uid}`,service=domain+'/'+LABEL;
    const launch=async args=>this.run('/bin/launchctl',args,{timeout:5000});
    let previous=null;
    try{previous=fs.readFileSync(this.file);}catch(error){if(error.code!=='ENOENT')throw error;}
    // A same-label foreign job must never be replaced silently.
    if(previous&&!previous.toString().includes(xml(path.join(this.root,'bin/service.mjs'))))throw Error('启动项路径已有其他配置，请检查后再设置。');
    let loaded=false;
    try{await launch(['print',service]);loaded=true;}catch(error){if(error.code!==113)throw error;}
    if(loaded)await launch(['bootout',service]);
    if(!enabled){fs.rmSync(this.file,{force:true});return this.status();}
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const temp=this.file+'.tmp';
    fs.writeFileSync(temp,this.plist(record),{mode:0o600});fs.renameSync(temp,this.file);
    try{
      await launch(['enable',service]);
      await launch(['bootstrap',domain,this.file]);
    }catch(error){
      if(previous){fs.writeFileSync(this.file,previous,{mode:0o600});if(loaded)await launch(['bootstrap',domain,this.file]).catch(()=>{});}
      else fs.rmSync(this.file,{force:true});
      throw Error('注册登录自启失败：'+(error.stderr||error.message));
    }
    return this.status();
  }
}
