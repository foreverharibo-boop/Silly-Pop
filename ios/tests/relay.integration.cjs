// Optional cross-repository integration: node ios/tests/relay.integration.cjs /path/to/Silly-Relay
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const { observe } = require('../server/index.cjs');
const relayPath = process.argv[2];
if (!relayPath) throw new Error('Pass the local Silly-Relay repository path.');
const { createRelay } = require(path.resolve(relayPath, 'server/index.cjs'));
const PATH = '/api/backends/chat-completions/generate';
const id = () => randomBytes(16).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
 const { createTransport } = await import(pathToFileURL(path.resolve(relayPath, 'transport.mjs')));
 const { createMarkerFetch } = await import('../extension/marker.mjs');
 const routes = [], relay = createRelay({ pollMs: 20 }), completions = [], calls = [];
 const router = Object.fromEntries(['get','post'].map(method => [method, (route, fn) => routes.push({method:method.toUpperCase(),route,fn})]));
 relay.install(router);
 const restore = observe({ completed: async (_owner, marker) => completions.push(marker) });
 const server = http.createServer(async (req,res) => {
  res.status = code => { res.statusCode=code; return res; };
  res.json = data => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(data)); };
  req.user = { profile: { handle: 'fixture-user' } };
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  req.body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  const url=new URL(req.url,'http://localhost'); req.query=Object.fromEntries(url.searchParams);
  if(url.pathname===PATH){
   calls.push(req.body);
   if (!req.body.omitContentType) res.setHeader('content-type',req.body.stream?'text/event-stream':'application/json');
   if(req.body.stream) res.write('data: {"choices":[{"delta":{"content":"테스트 답장"}}]}\n\n');
   setTimeout(()=>res.end(req.body.stream?'data: [DONE]\n\n':JSON.stringify({choices:[{message:{content:'테스트 답장'}}]})),40);
   return;
  }
  for(const r of routes){
   const names=[]; const pattern=r.route.replace(/:([a-z]+)/g,(_,name)=>{names.push(name);return '([^/]+)';});
   const match=url.pathname.replace('/api/plugins/silly-relay','').match(new RegExp('^'+pattern+'$'));
   if(r.method===req.method&&match){req.params=Object.fromEntries(names.map((name,i)=>[name,match[i+1]]));return r.fn(req,res);}
  }
  res.status(404).json({error:'not found'});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const headers={'content-type':'application/json'};
 try {
  for(const order of ['before-relay','after-relay']) for(const mode of ['json','sse','headerless-sse']){
   const stream = mode !== 'json';
   let lost=false,armed=true;
   const marker={v:1,requestId:id(),clientId:id(),deviceId:id(),enabled:true,visible:false,backgroundOnly:true,ts:Date.now()};
   const wire=async(input,init)=>{
    const response=await fetch(input,init);
    if(String(input).endsWith('/jobs')&&init.method==='POST'&&!lost){lost=true;await response.text();throw new TypeError('fixture lost acknowledgement');}
    return response;
   };
   const markerFor=()=>{if(!armed)return null;armed=false;return marker;};
   let send;
   if(order==='before-relay') send=createTransport({fetchImpl:createMarkerFetch(wire,{origin,markerFor}),origin,enabled:()=>true,retryDelay:1}).fetch;
   else send=createMarkerFetch(createTransport({fetchImpl:wire,origin,enabled:()=>true,retryDelay:1}).fetch,{origin,markerFor});
   const before=calls.length, notified=completions.length;
   const response=await send(origin+PATH,{method:'POST',headers,body:JSON.stringify({type:'swipe',stream,omitContentType:mode==='headerless-sse',messages:[{role:'user',content:'unchanged'}]})});
   assert.equal(response.status,200); assert.match(await response.text(),/테스트 답장/);
   await pause(10);
   assert.equal(calls.length,before+1,order+' must not duplicate AI requests');
   assert.equal(completions.length,notified+1,order+' must notify exactly once');
   assert.equal(completions.at(-1).requestId,marker.requestId);
   assert.equal(calls.at(-1).messages[0].content,'unchanged');
  }
  const before=completions.length;
  await fetch(origin+'/api/plugins/silly-relay/jobs',{method:'POST',headers,body:JSON.stringify({id:id(),path:PATH,body:JSON.stringify({type:'normal',silly_pop_ios:{requestId:'detached'},stream:true})})});
  await pause(80); // No browser read or completion callback exists for this request.
  assert.equal(completions.length,before+1);
  assert.equal(completions.at(-1).requestId,'detached');
  console.log('Relay + iOS integration passed: JSON/SSE/headerless SSE, both wrapper orders, lost acknowledgement, one AI request/push, detached browser. Push delivery mocked.');
 } finally {restore();relay.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
