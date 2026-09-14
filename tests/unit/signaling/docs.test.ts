import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { parse } from 'yaml';
import { serveSignalingDocs } from '../../../packages/bridge/src/signaling/docs.js';
import { createSignalingHandler } from '../../../packages/bridge/src/signaling/handler.js';

test('HTTP文書は同origin assetと一致するJSON/YAMLを公開し、offer認証を維持する', async () => {
  const credential = randomBytes(32).toString('hex');
  const server = createServer(createSignalingHandler({ credential, maxBodyBytes: 1024, requestTimeoutMs: 100,
    maxPending: 1, accept: async () => assert.fail('Documentation must not negotiate a peer') }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const jsonResponse = await fetch(`${base}/openapi.json`);
    assert.equal(jsonResponse.status, 200);
    const jsonText = await jsonResponse.text();
    assert.equal(jsonText.includes(credential), false);
    const spec = JSON.parse(jsonText);
    assert.deepEqual(Object.keys(spec.paths).sort(), ['/health', '/offer']);
    assert.deepEqual(spec.servers, [{ url: '/' }]);
    assert.deepEqual(spec.paths['/health'].get.security, []);
    const offer = spec.paths['/offer'].post;
    assert.deepEqual(offer.security, [{ bearerAuth: [] }]);
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.deepEqual(offer.requestBody.content['application/json'].schema.required, ['type', 'sdp']);
    assert.equal(offer.requestBody.content['application/json'].schema.additionalProperties, false);
    assert.deepEqual(Object.keys(offer.responses), ['200', '400', '401', '408', '413', '415', '503']);
    const yamlResponse = await fetch(`${base}/openapi.yaml`);
    assert.equal(yamlResponse.headers.get('content-type'), 'application/yaml');
    assert.deepEqual(parse(await yamlResponse.text()), spec);
    // HTMLは固定の同origin参照のみ。任意asset pathやcredentialは配信しない。
    for (const path of ['/docs', '/docs/']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      assert.match(html, /src="\/docs\/swagger-ui-bundle.js"/);
      assert.match(html, /src="\/docs\/init.js"/);
      assert.doesNotMatch(html, /https?:\/\//);
    }
    for (const [path, contentType] of [
      ['/docs/swagger-ui.css', 'text/css'], ['/docs/swagger-ui-bundle.js', 'application/javascript'],
      ['/docs/init.js', 'application/javascript']
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = await response.text();
      assert.ok(body.length > 0);
      assert.equal(body.includes(credential), false);
    }
    const initializer = await (await fetch(`${base}/docs/init.js`)).text();
    assert.match(initializer, /validatorUrl:null/);
    assert.match(initializer, /persistAuthorization:false/);
    assert.match(initializer, /queryConfigEnabled:false/);
    assert.doesNotMatch(initializer, /https?:\/\/|localStorage|sessionStorage/);
    assert.equal((await fetch(`${base}/docs/unknown.js`)).status, 404);
    assert.equal((await fetch(`${base}/docs`, { method: 'POST' })).status, 404);
    const unauthorized = await fetch(`${base}/offer`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('HTTP文書handlerはURL未指定を処理せず通常routingへ戻す', () => {
  assert.equal(serveSignalingDocs({ method: 'GET' } as IncomingMessage, {} as ServerResponse), false);
});
