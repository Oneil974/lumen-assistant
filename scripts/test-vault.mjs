import test from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {normalizeKey,parseField,validateFields,scopeEntries,filterEntries,folderTree,toCsv,importRecords,COLLECTION_TEMPLATES} from '../src/vault/model.js';
import {collectDependencies} from './frontend-dependencies.mjs';
const fields=[{name:'nom',label:'Nom',type:'text',required:true},{name:'quantite',label:'Quantité',type:'number'},{name:'disponible',label:'Disponible',type:'bool'}];
test('coffre preserves typed values, empty optional booleans and rejects malformed data',()=>{
 assert.equal(normalizeKey(' Maison/Objets/ '),'maison/objets');assert.throws(()=>normalizeKey('a//b'));
 assert.equal(parseField('12,5','number'),12.5);assert.equal(parseField('false','bool'),false);assert.equal(parseField('','bool'),null);
 assert.deepEqual(parseField('[1,2]','list'),[1,2]);assert.throws(()=>parseField('NaN','number'));assert.throws(()=>parseField('[]','dict'));
 assert.deepEqual(validateFields({nom:'Café',quantite:2,disponible:false},fields),{nom:'Café',quantite:2,disponible:false});
 assert.throws(()=>validateFields({nom:''},fields),/requis/);assert.throws(()=>validateFields({nom:'Café',quantite:'2'},fields),/Type/);assert.throws(()=>validateFields({nom:'Café',unknown:1},fields),/absent/);
});
test('folder browsing respects boundaries and searches nested values without accent sensitivity',()=>{
 const entries=[{key:'maison/cuisine/cafe',type:'dict',value:{nom:'Café'},updated_ms:2},{key:'maison2/cafe',type:'dict',value:{nom:'Café'},updated_ms:1},{key:'maison/bureau',type:'text',value:'Carnet',updated_ms:3}];
 assert.equal(scopeEntries(entries,'maison').length,2);assert.equal(filterEntries(entries,{query:'cafe',type:'dict'}).length,2);
 const tree=folderTree(entries,[{id:'maison',name:'Maison'}]);assert.equal(tree.find(f=>f.id==='maison').count,2);assert.equal(tree.find(f=>f.id==='maison/cuisine').count,1);
});
test('imports validate every record, preserve types and never overwrite existing keys',()=>{
 const c={id:'maison',fields};const imported=importRecords([{nom:'Lampe',quantite:1,disponible:true}],c);assert.equal(imported[0].value.disponible,true);assert.equal(imported[0].expected_updated,0);
 assert.throws(()=>importRecords([{nom:'Lampe'},{quantite:2}],c),/requis/);
 const exported={records:[{key:'maison/lampe',value:{nom:'Lampe'}}]};assert.throws(()=>importRecords(exported,c,[{key:'maison/lampe'}]),/existe/);
 assert.throws(()=>importRecords(Array(501).fill({nom:'Lampe'}),c),/500/);
 assert.equal(toCsv([{value:{nom:'Texte, avec "guillemets"',quantite:2}}],fields),'nom,quantite,disponible\n"Texte, avec ""guillemets""",2,');
});
test('all collection templates and coffre runtime dependencies are valid',()=>{
 for(const c of COLLECTION_TEMPLATES){assert.ok(c.fields.length);assert.equal(new Set(c.fields.map(f=>f.name)).size,c.fields.length);}
 const graph=collectDependencies(fileURLToPath(new URL('../src',import.meta.url)),['vault/vault.html']);assert.ok(graph.files.has('vault/main.js'));assert.ok(graph.files.has('nodal/graph/lumen-nodes.js'));assert.ok(graph.files.has('llm.js'));
});
