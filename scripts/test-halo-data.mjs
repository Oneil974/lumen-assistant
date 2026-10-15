import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHaloAgenda, loadHaloMemories } from '../src/lib/halo-data.js';

test('agenda combines saved reminders and visible cached calendars, excluding completed and past events', async () => {
  const now = new Date(2026, 9, 6, 12).getTime();
  const invoke = async cmd => cmd === 'reminders_load' ? JSON.stringify([
    { title: 'Done', done: true, due_at: now }, { title: 'Past', due_at: now - 86400000 },
    { title: 'Local', due_at: now + 2000 },
  ]) : JSON.stringify({ 'ext.sources': JSON.stringify([{id:'a',name:'Work'}, {id:'b',hidden:true}]),
    'ext.events.a': JSON.stringify([{title:'Remote',start:now + 1000,end:now + 3000}]),
    'ext.events.b': JSON.stringify([{title:'Hidden',start:now}]) });
  const result = await loadHaloAgenda(invoke, now);
  assert.deepEqual(result.items.map(r => r.title), ['Remote','Local']);
  assert.deepEqual(result.errors, []);
});

test('one unavailable source preserves accessible agenda data and reports the error', async () => {
  const now = Date.now();
  const result = await loadHaloAgenda(async cmd => {
    if (cmd === 'app_state_load') throw new Error('locked');
    return JSON.stringify([{title:'Reminder',due_at:now+60000}]);
  }, now);
  assert.equal(result.items[0].title, 'Reminder');
  assert.match(result.errors[0], /locked/);
});

test('memories unwrap recall results and include both legacy and structured profile entries', async () => {
  const result = await loadHaloMemories(async (cmd,args) => {
    if (cmd === 'mem_recall') {
      assert.equal(args.context,'app:memory');
      return [{item:{id:'1',text:'Fact',kind:'semantic'},score:1}];
    }
    return {value:['Legacy',{text:'Profile'}]};
  });
  assert.deepEqual(result.items.map(r=>r.text),['Legacy','Profile','Fact']);
});

test('memory errors are reported without hiding available profile data', async () => {
  const result = await loadHaloMemories(async cmd => {
    if(cmd === 'mem_recall') throw new Error('unavailable');
    return {value:['Profile']};
  });
  assert.equal(result.items[0].text,'Profile');
  assert.match(result.errors[0], /unavailable/);
});
