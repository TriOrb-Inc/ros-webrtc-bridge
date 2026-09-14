import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { stringify } from 'yaml';
import { signalingOpenApi } from './openapi.js';

const require = createRequire(import.meta.url);
const specification = signalingOpenApi();
// Load only fixed asset names from the distributed dependency; source and colcon installs serve the same assets.
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

/** Serve public HTTP documentation only. Inputs: request/response; returns whether handled. GET /docs returns true; POST returns false. */
export function serveSignalingDocs(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET') return false;
  const resource = resources.get(request.url ?? '');
  if (!resource) return false;
  // Keep entered credentials only in browser memory; never contact external validators or CDNs.
  response.writeHead(200, { 'Content-Type': resource.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(resource.body);
  return true;
}
