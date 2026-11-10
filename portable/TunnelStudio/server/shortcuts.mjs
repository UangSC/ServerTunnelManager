import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const SHORTCUT_OWNER='com.tunnelstudio.application-shortcut';
export const INSTALL_OWNER='com.tunnelstudio.install';
export const SHORTCUT_MARKER='Contents/Resources/tunnel-studio-shortcut.json';
export const INSTALL_MARKER='data/install.json';
const within=(base,target)=>target===base||target.startsWith(base+path.sep);
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

// Do not follow symlinks when creating/removing an application bundle or its ownership marker.
export function shortcutPath(target){
  target=path.resolve(target);
  for(let current=target;;current=path.dirname(current)){
    let info;try{info=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(info?.isSymbolicLink())throw Error('应用快捷入口不允许使用符号链接路径。');
    if(current===path.dirname(current))break;
  }
  return target;
}

export function shortcutScript(root,nodes){
  return `#!/bin/sh
# Tunnel Studio owned lightweight application shortcut; no configuration or keys are bundled.
root=${quote(root)}
if [ ! -f "$root/bin/service.mjs" ] || [ ! -f "$root/server/app.mjs" ]; then
  printf '%s\\n' 'Tunnel Studio: 本机安装代码不存在，请重新安装。' >&2
  exit 1
fi
launch() {
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] && [ -x "$1" ] || return 1
  version=$("$1" --version 2>/dev/null) || return 1
  case "$version" in v*) major=\${version#v}; major=\${major%%.*} ;; *) return 1 ;; esac
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge 22 ] || return 1
  exec "$1" "$root/bin/service.mjs" start --enable-ssh --open
}
for candidate in ${nodes.map(quote).join(' ')} /opt/homebrew/bin/node /usr/local/bin/node; do
  launch "$candidate"
done
candidate=$(command -v node 2>/dev/null) && launch "$candidate"
printf '%s\\n' 'Tunnel Studio: 未发现 Node.js 22+，请保留完整应用或安装 Node.js。' >&2
exit 1
`;
}

export class ApplicationShortcuts {
  constructor(root,{home=os.homedir(),platform=process.platform,applicationsDir=path.join(home,'Applications'),node=process.execPath,env=process.env,probeNode}={}){
    this.root=fs.realpathSync(root);this.home=path.resolve(home);this.platform=platform;
    this.path=path.join(path.resolve(applicationsDir),'Tunnel Studio.app');this.node=node;this.env=env;
    this.probeNode=probeNode||((candidate)=>{
      try{return /^v(\d+)\./.exec(execFileSync(candidate,['--version'],{encoding:'utf8',timeout:3000}))?.[1]>=22;}catch{return false;}
    });
  }
  installed(){
    if(this.platform!=='darwin')return false;
    try{
      for(const relative of ['bin/service.mjs','server/app.mjs'])if(!fs.statSync(shortcutPath(path.join(this.root,relative))).isFile())return false;
      // Legacy full-app installations have desktop.json and the conventional local installation path.
      if(this.root===path.join(this.home,'Library/Application Support/TunnelStudio'))return true;
      const record=JSON.parse(fs.readFileSync(shortcutPath(path.join(this.root,INSTALL_MARKER)),'utf8'));
      return record.owner===INSTALL_OWNER&&record.version===1&&record.root===this.root;
    }catch{return false;}
  }
  desktop(){
    try{
      const record=JSON.parse(fs.readFileSync(shortcutPath(path.join(this.root,'data/desktop.json')),'utf8'));
      if(!path.isAbsolute(record.app)||!path.isAbsolute(record.node)||record.node!==path.join(record.app,'Contents/Resources/runtime/node'))return null;
      return record;
    }catch{return null;}
  }
  nodes(){
    const candidates=[this.node,this.desktop()?.node,'/opt/homebrew/bin/node','/usr/local/bin/node',
      ...(this.env.PATH||'').split(path.delimiter).filter(path.isAbsolute).map(directory=>path.join(directory,'node'))];
    return [...new Set(candidates.filter(Boolean).map(candidate=>{
      try{return path.isAbsolute(candidate)&&fs.statSync(candidate).isFile()?fs.realpathSync(candidate):null;}catch{return null;}
    }).filter(Boolean))].filter(candidate=>this.probeNode(candidate));
  }
  inspect(){
    shortcutPath(this.path);
    let info;try{info=fs.lstatSync(this.path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!info.isDirectory())throw Error('应用快捷入口路径已被其他文件占用，不会覆盖。');
    const record=JSON.parse(fs.readFileSync(shortcutPath(path.join(this.path,SHORTCUT_MARKER)),'utf8'));
    if(record.owner!==SHORTCUT_OWNER||record.version!==1||record.kind!=='wrapper'||record.root!==this.root||record.path!==this.path||!Array.isArray(record.nodes))
      throw Error('同名应用不是当前安装拥有的快捷入口，不会覆盖或删除。');
    // A complete app/runtime must never be removed, even if someone copied a shortcut marker into it.
    const active=[this.root,this.node,this.desktop()?.node].filter(Boolean).map(target=>{try{return fs.realpathSync(target);}catch{return path.resolve(target);}});
    if(active.some(target=>within(this.path,target)))throw Error('不能移除活动 runtime 或安装源码所在的完整应用。');
    const allowed=new Set(['Contents','Contents/MacOS','Contents/MacOS/TunnelStudio','Contents/Resources',SHORTCUT_MARKER,'Contents/Info.plist','Contents/PkgInfo']);
    const walk=relative=>{
      for(const entry of fs.readdirSync(path.join(this.path,relative),{withFileTypes:true})){
        const name=path.posix.join(relative,entry.name);
        if(entry.isSymbolicLink()||!allowed.has(name))throw Error('应用包含非快捷入口文件或完整 runtime，不会覆盖或删除。');
        if(entry.isDirectory())walk(name);else if(!entry.isFile())throw Error('应用快捷入口包含不受支持的文件。');
      }
    };walk('');
    const script=fs.readFileSync(shortcutPath(path.join(this.path,'Contents/MacOS/TunnelStudio')));
    const plist=fs.readFileSync(shortcutPath(path.join(this.path,'Contents/Info.plist')));
    if(record.scriptHash!==digest(script)||record.plistHash!==digest(plist)||script.toString()!==shortcutScript(this.root,record.nodes))
      throw Error('应用快捷入口已被修改，请人工检查；不会覆盖或删除。');
    return record;
  }
  status(){
    const supported=this.installed();
    let enabled=false,message=supported?'快捷入口使用本机安装代码；不会复制配置或密钥。':'请先安装 macOS 本机代码，再添加应用快捷入口。';
    if(supported)try{enabled=!!this.inspect();}catch(error){message=error.code==='ENOENT'?'已有同名应用没有本安装的 ownership 标记，不会覆盖或删除。':error.message;}
    return {supported,enabled,path:this.path,paths:[this.path],message};
  }
  set(enabled){
    if(typeof enabled!=='boolean')throw Error('应用快捷入口设置必须为布尔值。');
    if(!this.installed())throw Error('请先安装 macOS 本机代码，再设置应用快捷入口。');
    let existing;try{existing=this.inspect();}catch(error){if(error.code==='ENOENT')throw Error('已有同名应用没有本安装的 ownership 标记，不会覆盖或删除。');throw error;}
    if(!enabled){
      if(existing){
        // Revalidate the exact absolute target and ownership immediately before recursive removal.
        shortcutPath(this.path);this.inspect();fs.rmSync(this.path,{recursive:true});
      }
      return this.status();
    }
    if(existing)return this.status();
    const nodes=this.nodes();if(!nodes.length)throw Error('未发现可用的 Node.js 22+ runtime，未创建应用快捷入口。');
    if(nodes.some(node=>within(this.path,node))||within(this.path,this.root))throw Error('应用快捷入口不能覆盖活动 runtime 或安装源码。');
    shortcutPath(path.dirname(this.path));fs.mkdirSync(path.dirname(this.path),{recursive:true,mode:0o755});shortcutPath(this.path);
    // Exclusive mkdir prevents even an empty foreign same-name bundle being replaced.
    try{fs.mkdirSync(this.path,{mode:0o755});}catch(error){if(error.code==='EEXIST')throw Error('同名应用已存在，不会覆盖。');throw error;}
    const script=shortcutScript(this.root,nodes);
    const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TunnelStudio</string>
<key>CFBundleIdentifier</key><string>${SHORTCUT_OWNER}</string>
<key>CFBundleName</key><string>Tunnel Studio</string>
<key>CFBundleDisplayName</key><string>Tunnel Studio</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>TunnelStudioInstallRoot</key><string>${xml(this.root)}</string>
</dict></plist>\n`;
    fs.mkdirSync(path.join(this.path,'Contents/MacOS'),{recursive:true,mode:0o755});
    fs.mkdirSync(path.join(this.path,'Contents/Resources'),{recursive:true,mode:0o755});
    for(const [relative,content,mode] of [['Contents/MacOS/TunnelStudio',script,0o755],['Contents/Info.plist',plist,0o644],['Contents/PkgInfo','APPL????',0o644]])
      fs.writeFileSync(shortcutPath(path.join(this.path,relative)),content,{mode,flag:'wx'});
    fs.writeFileSync(shortcutPath(path.join(this.path,SHORTCUT_MARKER)),JSON.stringify({owner:SHORTCUT_OWNER,version:1,kind:'wrapper',root:this.root,path:this.path,nodes,scriptHash:digest(script),plistHash:digest(plist)},null,2)+'\n',{mode:0o644,flag:'wx'});
    return this.status();
  }
}
