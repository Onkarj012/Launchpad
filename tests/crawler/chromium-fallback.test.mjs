import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromiumFallbackTransport } from '../../crawler/chromium-fallback.mjs';

test('Chromium fallback remains inert unless explicitly enabled for a host', async () => {
  const calls = [];
  const transport = createChromiumFallbackTransport({
    baseTransport: async (url) => {
      calls.push(url);
      return { status: 200, headers: {}, body: '<html>direct</html>' };
    },
    enabled: false,
    renderHosts: ['careers.example'],
  });
  const result = await transport('https://careers.example/jobs');
  assert.equal(result.body, '<html>direct</html>');
  assert.deepEqual(calls, ['https://careers.example/jobs']);
});
