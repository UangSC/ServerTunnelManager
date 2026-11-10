import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export function effectiveProbe(tunnel) {
  if (tunnel.probe !== 'auto') return tunnel.probe || 'tcp';
  return tunnel.openUrl ? 'http' : 'tcp';
}

// Always connect through the local forwarding socket, never to an arbitrary URL host.
export function probeTunnel(tunnel, timeout=1800) {
  const kind=effectiveProbe(tunnel), start=performance.now();
  if(kind==='none')return Promise.resolve({ok:true,ms:null,error:''});
  return new Promise(resolve=>{
    let done=false, socket, request;
    const finish=(error='',extra={})=>{
      if(done)return;done=true;clearTimeout(timer);socket?.destroy();request?.destroy();
      resolve({ok:!error,ms:error?null:Math.max(1,Math.round(performance.now()-start)),error,...extra});
    };
    // Absolute deadline, not just an inactivity timeout: slow responses cannot block the API queue.
    const timer=setTimeout(()=>finish('探测超时'),timeout);
    if(kind==='http'){
      let url;
      try{url=new URL(tunnel.openUrl||`http://127.0.0.1:${tunnel.localPort}/`);}catch{return finish('HTTP 探测地址无效');}
      const transport=url.protocol==='https:'?https:http;
      request=transport.request({hostname:'127.0.0.1',port:tunnel.localPort,path:url.pathname+url.search,method:'HEAD',agent:false,
        ...(url.protocol==='https:'?{servername:url.hostname}:{}),headers:{Host:url.host,Connection:'close'}},response=>{
        // Authentication/404 responses still prove the remote HTTP service responded.
        const status=response.statusCode;response.resume();
        finish(status>=500?`远端 HTTP ${status}`:'',{httpStatus:status});
      });
      request.on('error',error=>finish(error.code||error.message));request.end();
    }else{
      socket=net.createConnection({host:'127.0.0.1',port:tunnel.localPort});
      socket.on('error',error=>finish(error.code||error.message));
      socket.on('end',()=>finish('远端在响应前关闭连接'));
      if(kind==='socks5'){
        let data=Buffer.alloc(0);
        socket.once('connect',()=>socket.write(Buffer.from([5,1,0])));
        socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=2)finish(data[0]===5&&data[1]===0?'':'SOCKS5 不支持无认证握手');});
      }else socket.once('connect',()=>finish());
    }
  });
}
