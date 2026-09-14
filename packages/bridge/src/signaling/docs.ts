import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { stringify } from 'yaml';
import { signalingOpenApi } from './openapi.js';

const require = createRequire(import.meta.url);
const specification = signalingOpenApi();
// 配布済み依存から固定名だけを読み、sourceとcolcon installの両方で同じassetを配信する。
const resources = new Map<string, { contentType: string; body: string | Buffer }>([
  ['/openapi.json', { contentType: 'application/json', body: JSON.stringify(specification) }],
  ['/openapi.yaml', { contentType: 'application/yaml', body: stringify(specification) }],
  ['/docs/swagger-ui.css', { contentType: 'text/css', body: readFileSync(require.resolve('swagger-ui-dist/swagger-ui.css')) }],
  ['/docs/swagger-ui-bundle.js', { contentType: 'application/javascript', body: readFileSync(require.resolve('swagger-ui-dist/swagger-ui-bundle.js')) }],
  ['/docs/init.js', { contentType: 'application/javascript', body:
    'SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",validatorUrl:null,persistAuthorization:false,queryConfigEnabled:false});' }]
]);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ROS WebRTC Bridge API</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>`;
resources.set('/docs', { contentType: 'text/html', body: html });
resources.set('/docs/', { contentType: 'text/html', body: html });

/** 公開HTTP文書だけを返す。入力request/response、出力処理済みboolean。例: GET /docs → true、POST → false。 */
export function serveSignalingDocs(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET') return false;
  const resource = resources.get(request.url ?? '');
  if (!resource) return false;
  // credential入力はbrowser memoryだけに保持し、外部validatorやCDNへ通信しない。
  response.writeHead(200, { 'Content-Type': resource.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(resource.body);
  return true;
}
