import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {downloadLivekitSdk,cachedLivekitSdk} from '../public/livekit-loader.js';
test('SDK chunks retry truncation and reassemble the exact official SDK despite out-of-order responses',async()=>{
  let retries=0,finished=0;const progress=[];
  const bytes=await downloadLivekitSdk(async url=>{
    const index=Number(url.match(/-(\d+)\.bin$/)[1]);
    await new Promise(resolve=>setTimeout(resolve,index%3));
    if(index===1&&retries++===0)return new Response(new Uint8Array(7));
    finished++;return new Response(readFileSync(new URL(`../public/vendor/livekit-2.23.0-${index}.bin`,import.meta.url)));
  },value=>progress.push(value));
  assert.equal(finished,19);assert.equal(retries,2);assert.equal(progress.at(-1),100);
  assert.deepEqual(Buffer.from(bytes),readFileSync(new URL('../public/vendor/livekit-client-2.23.0.js',import.meta.url)));
});
test('SDK download failures are bounded and do not return executable content',async()=>{
  let attempts=0;
  await assert.rejects(downloadLivekitSdk(async()=>{attempts++;return new Response('missing',{status:404});}),/Не удалось загрузить часть/);
  assert.ok(attempts<=9);
});

test('verified SDK survives page reload without network access and corrupted cache is replaced',async()=>{
  const entries=new Map();let requests=0;
  const cache={match:async key=>entries.get(key)?.clone(),put:async(key,response)=>entries.set(key,response.clone()),delete:async key=>entries.delete(key)};
  const storage={open:async()=>cache};
  const fetcher=async url=>{requests++;const index=Number(url.match(/-(\d+)\.bin$/)[1]);return new Response(readFileSync(new URL(`../public/vendor/livekit-2.23.0-${index}.bin`,import.meta.url)));};
  const first=await cachedLivekitSdk({storage,fetcher});assert.equal(requests,19);
  const second=await cachedLivekitSdk({storage,fetcher:async()=>{throw new Error('Network must not be used');}});assert.deepEqual(second,first);
  await cache.put('/vendor/verified-livekit-2.23.0',new Response('corrupted'));
  const restored=await cachedLivekitSdk({storage,fetcher});assert.equal(requests,38);assert.deepEqual(restored,first);
});
test('blocked browser cache does not prevent SDK loading',async()=>{
  const bytes=await cachedLivekitSdk({storage:{open:async()=>{throw new Error('storage blocked');}},fetcher:async url=>{
    const index=Number(url.match(/-(\d+)\.bin$/)[1]);return new Response(readFileSync(new URL(`../public/vendor/livekit-2.23.0-${index}.bin`,import.meta.url)));
  }});
  assert.deepEqual(Buffer.from(bytes),readFileSync(new URL('../public/vendor/livekit-client-2.23.0.js',import.meta.url)));
});
