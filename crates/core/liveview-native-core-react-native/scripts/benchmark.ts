import { performance } from 'node:perf_hooks';
import { applyDocumentPatch, parseDocument } from '../src/document';
const cases = [50, 500, 5000].map(count => {
  const json = JSON.stringify({ root: 0, nodes: [{ id: 0, kind: 'root', children: Array.from({ length: count }, (_, i) => i + 1) }, ...Array.from({ length: count }, (_, i) => ({ id: i + 1, kind: 'text', text: 'Fixture', children: [] }))] });
  const samples = Array.from({ length: 100 }, () => { const start = performance.now(); parseDocument(json); return performance.now() - start; }).sort((a,b) => a-b);
  const baseline = parseDocument(json);
  const patch = JSON.stringify({baseRevision:1,revision:2,root:0,upsert:[{id:count,kind:'text',text:'Updated fixture',children:[]}],remove:[]});
  const patchSamples = Array.from({length:100},()=>{const start=performance.now();applyDocumentPatch(baseline,patch,1,2);return performance.now()-start;}).sort((a,b)=>a-b);
  return { nodes: count + 1, bytes: Buffer.byteLength(json), medianMs: samples[50], p90Ms: samples[90], p99Ms: samples[99], patchBytes:Buffer.byteLength(patch), patchMedianMs:patchSamples[50], patchP90Ms:patchSamples[90], patchP99Ms:patchSamples[99] };
});
console.log(JSON.stringify({ kind: 'node-parse-only-not-device-rendering', node: process.version, cases }, null, 2));
