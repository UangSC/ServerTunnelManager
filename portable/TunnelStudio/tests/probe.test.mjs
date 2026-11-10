import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {probeTunnel,effectiveProbe} from '../server/probe.mjs';

async function listening(server, work) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await work(server.address().port);}finally{await new Promise(resolve=>server.close(resolve));}
}

test('HTTP 探测穿过本地转发，保留路径，401/403 是可达，503 为异常', async()=>{
  const received=[];
  const server=http.createServer((req,res)=>{received.push([req.method,req.url]);res.writeHead(Number(req.url.slice(1)));res.end();});
  await listening(server,async port=>{
    for(const code of [200,401,403,404,503]){
      // The URL's host is intentionally unreachable; it must never be the socket destination.
      const result=await probeTunnel({probe:'http',localPort:port,openUrl:`http://unreachable.invalid/${code}`});
      assert.equal(result.ok,code<500);assert.equal(result.httpStatus,code);
    }
    assert.deepEqual(received,[200,401,403,404,503].map(code=>['HEAD','/'+code]));
  });
});

test('SSH 本地监听接受连接但远端没有 HTTP 响应，不能误报健康',async()=>{
  const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await listening(server,async port=>{
    const result=await probeTunnel({probe:'http',localPort:port},100);
    assert.equal(result.ok,false);assert.match(result.error,/超时/);
    for(const socket of sockets)socket.destroy();
  });
});

test('SOCKS5 处理分片握手并拒绝不可用的认证方式',async()=>{
  for(const method of [0,255]){
    await listening(net.createServer(socket=>socket.once('data',greeting=>{
      assert.deepEqual([...greeting],[5,1,0]);socket.write(Buffer.from([5]));setTimeout(()=>socket.end(Buffer.from([method])),10);
    })),async port=>assert.equal((await probeTunnel({probe:'socks5',localPort:port})).ok,method===0));
  }
});

test('auto 按页面地址选择 HTTP；显式 tcp 和 none 保留语义',async()=>{
  assert.equal(effectiveProbe({probe:'auto',openUrl:'http://localhost/'}),'http');
  assert.equal(effectiveProbe({probe:'auto'}),'tcp');
  assert.equal((await probeTunnel({probe:'none',localPort:1})).ms,null);
  await listening(net.createServer(socket=>socket.end()),async port=>assert.equal((await probeTunnel({probe:'tcp',localPort:port})).ok,true));
});
