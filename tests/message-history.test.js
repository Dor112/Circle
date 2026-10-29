import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeHistory} from '../public/message-history.js';
const m=(id,body=String(id))=>({id,body});
test('reconnection keeps older pages and reconciles the current snapshot',()=>{
  const current=Array.from({length:100},(_,i)=>m(i+1));
  const latest=current.slice(50).map(x=>x.id===75?m(75,'updated'):x).filter(x=>x.id!==80);
  const result=mergeHistory(current,latest,{preserveOlder:true});
  assert.equal(result.length,99);assert.equal(result[0].id,1);
  assert.equal(result.find(x=>x.id===75).body,'updated');assert.ok(!result.some(x=>x.id===80));
});
test('delayed snapshots cannot remove live messages or resurrect deletions',()=>{
  const changes=new Map([[3,m(3,'live')],[2,null],[1,m(1,'edited')]]);
  assert.deepEqual(mergeHistory([m(1),m(3)], [m(1),m(2)],{changes}),[m(1,'edited'),m(3,'live')]);
});
test('older pagination merges without duplicate or out of order messages',()=>{
  assert.deepEqual(mergeHistory([m(3),m(4)],[m(1),m(3)],{before:true}),[m(1),m(3),m(4)]);
});
test('new searches and an empty authoritative snapshot clear obsolete results',()=>{
  assert.deepEqual(mergeHistory([m(1),m(2)],[m(3)]),[m(3)]);
  assert.deepEqual(mergeHistory([m(1)],[],{preserveOlder:true}),[]);
});
