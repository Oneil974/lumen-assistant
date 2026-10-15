import test from 'node:test';
import assert from 'node:assert/strict';
import { LUMEN_DEFS,LUMEN_ACTIONS,runLumenTool,validateActionArgs } from '../src/nodal/graph/lumen-nodes.js';
import { agentTurn } from '../src/nodal/graph/ai-nodes.js';
import { executeAssistant } from '../src/nodal/embed/runtime.js';
const defaults=d=>Object.fromEntries(d.widgets.map(w=>[w.name,w.default]));
test('all Lumen blocks dispatch their allowlisted action and expose JSON and text',async()=>{
 for(const d of LUMEN_DEFS){const w=defaults(d);let seen;const output=await d.run({},w,{lumen:async(action,args)=>{seen={action,args};return '{"ok":true}';}});assert.equal(seen.action,d.type.slice(6));assert.deepEqual(output[0],{ok:true});assert.equal(output[1],'{"ok":true}');assert.equal(output[2],null);}
 assert.equal(LUMEN_DEFS.length,32);
 for(const action of ["vault_overview","vault_sources","vault_source_get"])assert.ok(LUMEN_ACTIONS[action]);
});
test('tool mode never performs writes before the model requests them; resources cannot be overridden',async()=>{
 const d=LUMEN_DEFS.find(d=>d.type==='lumen_table_row_insert');const w={...defaults(d),asTool:true,table_id:'allowed'};
 const [, ,tool]=await d.run({},w,{lumen:()=>assert.fail('premature write')});
 assert.equal(tool.fixed.table_id,'allowed');assert.equal(tool.parameters.properties.table_id,undefined);
 await assert.rejects(runLumenTool(tool,{table_id:'other',values:{}},{lumen:()=>assert.fail('override')}),/non autorisés/);
 let seen;await runLumenTool(tool,{values:{col_name:'Bonjour'}},{lumen:async(a,args)=>{seen=args;return 'ok';}});assert.equal(seen.table_id,'allowed');
});
test('Lumen tool calling handles model JSON arguments and feeds results back',async()=>{
 const d=LUMEN_DEFS.find(d=>d.type==='lumen_weather_now');const [, ,tool]=await d.run({}, {...defaults(d),asTool:true},{});let turns=0;let action;
 const result=await agentTurn({message:'météo',outil:tool},{},{chat:async(messages,c,specs)=>{
  assert.equal(specs[0].function.parameters.properties.place.type,'string');
  return ++turns===1?{tool_calls:[{id:'c',function:{name:'weather_now',arguments:'{"place":"Saint-Denis"}'}}]}:{content:messages.at(-1).content};
 },lumen:async(name,args)=>{action=name;assert.equal(args.place,'Saint-Denis');return '25 °C';}});
 assert.equal(action,'weather_now');assert.equal(result[0],'25 °C');
 assert.throws(()=>validateActionArgs('shell_exec',{}),/non autorisée/);
 assert.throws(()=>validateActionArgs('table_row_insert',{values:'bad'}),/invalide/);
});
test('portable assistant connects retrieved documents to agent context',async()=>{
 const g={nodes:[{id:'i',type:'chat_input'},{id:'r',type:'lumen_search_documents'},{id:'a',type:'ai_agent'},{id:'o',type:'chat_output'}],links:[{from:'i',out:0,to:'r',in:0},{from:'i',out:0,to:'a',in:0},{from:'r',out:1,to:'a',in:4},{from:'a',out:0,to:'o',in:0}]};
 const result=await executeAssistant(g,{message:'Question',lumen:async(a,args)=>{assert.equal(args.query,'Question');return 'Document pertinent';},chat:async(messages)=>{assert.match(messages[0].content,/Document pertinent/);return {content:'Réponse sourcée'};}});
 assert.equal(result,'Réponse sourcée');
});
