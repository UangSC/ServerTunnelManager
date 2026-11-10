import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pairs=[
  ['shared/tunnel-workbench.js','Panel/web/assets/tunnel-workbench.js'],
  ['shared/tunnel-workbench.js','portable/TunnelStudio/web/assets/tunnel-workbench.js'],
  ['shared/sync.mjs','portable/TunnelStudio/server/sync.mjs'],
  ['shared/sync-ui.js','Panel/web/assets/sync-ui.js'],
  ['shared/sync-ui.js','portable/TunnelStudio/web/assets/sync-ui.js'],
  ['shared/application-shortcut-ui.js','Panel/web/assets/application-shortcut-ui.js'],
  ['shared/application-shortcut-ui.js','portable/TunnelStudio/web/assets/application-shortcut-ui.js'],
  ['shared/app.css','Panel/web/assets/app.css'],
  ['shared/app.css','portable/TunnelStudio/web/assets/app.css'],
];
const write=process.argv.includes('--write');let failed=false;
for(const [source,target] of pairs){
  const expected=fs.readFileSync(path.join(root,source));
  if(write)fs.writeFileSync(path.join(root,target),expected);
  else if(!expected.equals(fs.readFileSync(path.join(root,target)))){console.error(`Shared source differs: ${source} -> ${target}`);failed=true;}
}
if(failed)process.exitCode=1;
else console.log(write?'Shared assets updated for both platforms.':'Shared Windows/macOS assets match.');
