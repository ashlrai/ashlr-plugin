import {test, expect} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {ashlrRead} from '../servers/read-server';
test('range response has no explicit line limit and invalid end produces inverted header', async () => {
 const dir = mkdtempSync(join(process.cwd(), 'range-probe-'));
 try {
  const path = join(dir, 'input.txt');
  writeFileSync(path, Array.from({length: 3000}, (_,i) => `line ${i+1} ${'x'.repeat(40)}`).join('\n'));
  const large = await ashlrRead({path,startLine:1,endLine:3000});
  expect(large).toContain('L1-L3000 of 3000');
  expect(large).toContain('3000: line 3000');
  expect(large.length).toBeGreaterThan(120000);
  const inverted = await ashlrRead({path,startLine:1,endLine:0});
  expect(inverted).toContain('L1-L0 of 3000');
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
