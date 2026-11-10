#!/usr/bin/env node
import { run } from '../portable/TunnelStudio/bin/tunnel.mjs';
try {
  const result=await run(process.argv.slice(2));
  console.log(result.help||JSON.stringify(result,null,2));
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error.message,...(error.result?{result:error.result}:{})}));
  process.exitCode=1;
}
