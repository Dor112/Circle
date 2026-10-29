// Reconcile a history snapshot with changes received while it was in flight.
export function mergeHistory(current, incoming, {before=false, preserveOlder=false, changes=new Map()}={}) {
  const oldest=incoming.length?Math.min(...incoming.map(m=>m.id)):Infinity;
  const retained=before?current:preserveOlder&&incoming.length?current.filter(m=>m.id<oldest):[];
  const merged=new Map(retained.map(m=>[m.id,m]));
  for(const m of incoming)merged.set(m.id,m);
  for(const [id,m] of changes){if(m===null)merged.delete(id);else merged.set(id,m);}
  return [...merged.values()].sort((a,b)=>a.id-b.id);
}
