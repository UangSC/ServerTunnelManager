#!/usr/bin/env node
// Review Git's index only: never crawl untracked user data/keys/logs.
import { execFileSync } from 'node:child_process';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});
const entries=git('ls-files','--stage','-z').split('\0').filter(Boolean);
const findings=[];
const forbidden=/(^|\/)(?:\._[^/]*|\.DS_Store|node_modules|backups|reports|screenshots|logs|data|\.ssh|run-[^/]+)(?:\/|$)|(?:^|\/)(?:ServerTunnels\.json(?:\.bak)?|test\.yaml|mac_patch\.py|\.env(?:\..+)?|id_rsa[^/]*|id_ed25519[^/]*|known_hosts[^/]*|config\.json(?:\..+)?|runtime\.json(?:\..+)?|panel\.pid\.json)$|\.(?:pem|key|log|png|jpe?g|webp|zip|dmg|exe|dll|app)(?:\/|$)/i;
const secretPatterns=[
  ['private-key',/-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP|ENCRYPTED) PRIVATE KEY/],
  ['GitHub-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS-key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential-in-URL',/https?:\/\/[A-Za-z0-9_.%+-]+:[^\s/@]{4,}@/],
];
function exampleIP(ip){
  const [a,b,c,d]=ip.split('.').map(Number);
  return [a,b,c,d].every(v=>v>=0&&v<=255)&&(
    a===0||a===127||(a===192&&b===0&&c===2)||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113)||
    // Generic bind/loopback literals are infrastructure, not production targets.
    (a===255&&b===255&&c===255&&d===255));
}
for(const entry of entries){
  const match=entry.match(/^(\d+) [0-9a-f]+ \d\t([\s\S]+)$/);if(!match)throw new Error('Unrecognized Git index entry');
  const [,mode,file]=match;
  if(mode==='120000'){findings.push(`${file}: symlink is not permitted in release source`);continue;}
  if(forbidden.test(file)){findings.push(`${file}: runtime/private/generated path`);continue;}
  const buffer=execFileSync('git',['show',':'+file],{maxBuffer:8*1024*1024});
  if(buffer.includes(0)){findings.push(`${file}: unexpected binary file`);continue;}
  const text=buffer.toString('utf8'),lines=text.split('\n');
  for(let n=0;n<lines.length;n++){
    const line=lines[n];
    for(const [label,pattern] of secretPatterns)if(pattern.test(line))findings.push(`${file}:${n+1}: ${label}`);
    for(const m of line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)){
      if(!exampleIP(m[0]))findings.push(`${file}:${n+1}: non-documentation IPv4; review/remove before publishing`);
    }
    // Test fixtures deliberately exercise rejection/redaction of fake passwords.
    if(!/(?:^|\/)(?:tests|scripts)\//.test(file)&&/\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{8,}["']/i.test(line))
      findings.push(`${file}:${n+1}: literal credential-like value`);
  }
}
if(findings.length){console.error(findings.join('\n'));process.exitCode=1;}
else console.log(`Reviewed ${entries.length} indexed source files: no blocked paths, private keys, known tokens, literal credentials or production IPv4 found. Manual review is still required.`);
