import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateServe, serverEnv } from '../scripts/tailscale-config.mjs';
const host='pc.example.ts.net';
test('private launcher sets exact HTTPS origin and binds to loopback',()=>{
  const env=serverEnv({HOST:'0.0.0.0',PUBLIC_URL:'http://old',DATA_DIR:'./my-data'},host);
  assert.equal(env.PUBLIC_URL,'https://'+host);assert.equal(env.HOST,'127.0.0.1');assert.equal(env.COOKIE_SECURE,'1');assert.equal(env.TRUST_PROXY,'1');assert.equal(env.DATA_DIR,'./my-data');
  assert.throws(()=>serverEnv({},'evil.example'));
});
test('private launcher preserves unrelated Serve services and rejects Funnel',()=>{
  assert.doesNotThrow(()=>validateServe({},host));
  const config={TCP:{443:{HTTPS:true}},Web:{[host+':443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:3000'}}}}};
  assert.doesNotThrow(()=>validateServe(config,host));
  assert.throws(()=>validateServe({...config,AllowFunnel:{[host+':443']:true}},host));
  assert.throws(()=>validateServe({...config,TCP:{443:{HTTPS:true},8443:{HTTPS:true}}},host));
  assert.throws(()=>validateServe({...config,Web:{[host+':443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:8080'}}}}},host));
});
