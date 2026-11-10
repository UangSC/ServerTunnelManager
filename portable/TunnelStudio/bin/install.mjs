import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ROOT, confined, defaults, validateConfig } from '../server/app.mjs';
import { ApplicationShortcuts, INSTALL_OWNER, INSTALL_MARKER } from '../server/shortcuts.mjs';

export const INSTALL_ROOT = path.join(os.homedir(), 'Library/Application Support/TunnelStudio');

export function migrateConfig(root, input) {
  const config = structuredClone(input);
  config.settings = {...defaults().settings, ...config.settings, simulation:true, autoOpenOnLaunch:false,
    strictHostKeyChecking:true, defaultKeyPath:'data/ssh/id_ed25519'};
  config.servers = (config.servers || []).map(server => ({...server, keyPath:'data/ssh/id_ed25519', passwordless:false}));
  config.tunnels = (config.tunnels || []).map(tunnel => ({...tunnel, autoOpen:false}));
  return validateConfig(root, config);
}

export function install({source=ROOT, target=INSTALL_ROOT, legacy=path.resolve(source,'../../Panel/config.json'), userSsh=false,
  applicationShortcut, shortcutOptions={}}={}) {
  if(applicationShortcut!==undefined&&typeof applicationShortcut!=='boolean')throw Error('应用快捷入口设置必须为布尔值。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  fs.mkdirSync(target, {recursive:true, mode:0o700});
  // Reject symlink components before copying executable files or credentials.
  confined(path.parse(target).root, path.relative(path.parse(target).root, target));
  target = fs.realpathSync(target);
  if (target === fs.realpathSync(source)) throw new Error('安装目录不能与源码目录相同。');
  for (const directory of ['data','data/logs','data/ssh']) fs.mkdirSync(confined(target,directory), {recursive:true,mode:0o700});
  const permissionCheck = confined(target, 'data/.permission-check');
  fs.writeFileSync(permissionCheck,'',{mode:0o600});
  fs.chmodSync(permissionCheck,0o600);
  const privatePermissions = (fs.statSync(permissionCheck).mode & 0o777) === 0o600;
  fs.unlinkSync(permissionCheck);
  if (!privatePermissions) throw new Error('安装目录不支持 POSIX 权限，请使用本机 APFS 目录，不能使用 ExFAT。');
  const configPath = confined(target,'data/config.json');
  const firstInstall = !fs.existsSync(configPath);
  // Validate before updating any installed source files. A malformed legacy file is not silently ignored.
  const config = firstInstall ? migrateConfig(target,fs.existsSync(legacy)
    ? JSON.parse(fs.readFileSync(legacy,'utf8').replace(/^\uFEFF/,'')) : defaults())
    : validateConfig(target,JSON.parse(fs.readFileSync(configPath,'utf8')));
  for (const directory of ['server','web','bin']) {
    fs.mkdirSync(confined(target,directory),{recursive:true,mode:0o700});
    copyDirectory(path.join(source,directory),directory);
  }
  function copyDirectory(from, relative) {
    for (const entry of fs.readdirSync(from,{withFileTypes:true})) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const destination = confined(target,path.join(relative,entry.name));
      if (entry.isDirectory()) {
        fs.mkdirSync(destination,{recursive:true,mode:0o700});
        copyDirectory(path.join(from,entry.name),path.join(relative,entry.name));
      } else if (entry.isFile()) {
        fs.copyFileSync(path.join(from,entry.name),destination);
        fs.chmodSync(destination,entry.name.endsWith('.sh')?0o700:0o600);
      }
    }
  }
  fs.copyFileSync(path.join(source,'package.json'),confined(target,'package.json'));
  if (firstInstall) {
    if(fs.existsSync(legacy)) fs.copyFileSync(legacy,confined(target,'data/config.windows.backup.json'));
    fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  }
  if (userSsh) {
    for (const name of ['id_ed25519','id_ed25519.pub','known_hosts']) {
      const from = path.join(os.homedir(),'.ssh',name), to = confined(target,'data/ssh/'+name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
        fs.chmodSync(to,0o600);
      }
    }
  }
  const installMarker=confined(target,INSTALL_MARKER);
  fs.writeFileSync(installMarker,JSON.stringify({owner:INSTALL_OWNER,version:1,root:target})+'\n',{mode:0o600});
  const shortcut=new ApplicationShortcuts(target,shortcutOptions);
  const shortcutStatus=applicationShortcut===undefined?shortcut.status():shortcut.set(applicationShortcut);
  return {root:target,firstInstall,servers:config.servers.length,tunnels:config.tunnels.length,applicationShortcut:shortcutStatus};
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.includes('--application-shortcut')&&args.includes('--no-application-shortcut'))throw Error('请选择添加或移除快捷入口，不能同时指定。');
    const applicationShortcut=args.includes('--application-shortcut')?true:args.includes('--no-application-shortcut')?false:undefined;
    const result=install({userSsh:args.includes('--with-user-ssh'),applicationShortcut});
    console.log(`${result.firstInstall?'已安装':'已更新'}：${result.root}\n配置：${result.servers} 台服务器，${result.tunnels} 条隧道；已有配置和密钥保留。`);
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
