import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demonstrate } from '../lib/d7.mjs';

test('D7: which interleavings lose the other assistant\'s change, in each arm', async () => {
  const rows = await demonstrate();
  const lost = Object.fromEntries(rows.map((row) => [row.scenario, row.cells.map((cell) => !cell.kept)]));
  // Columns: P with the version of the first read, P with the version of the receipt, T1, T2.
  assert.deepEqual(lost, {
    'other-part': [false, false, false, false],
    'same-part-stale': [false, true, false, false],
    'same-part-passage': [false, false, false, false],
    'whole-matter': [false, true, true, false],
  });
  const told = rows.map((row) => row.cells[0].told);
  assert.deepEqual(told, [true, true, true, true], 'a version from the first read is always refused, and A is told');
});
