/** HTTP signalingの単一仕様を返す。入力なし、出力OpenAPI文書。Topic通信はDataChannel契約を参照する。 */
export function signalingOpenApi() {
  // 認証値や配備先hostを含めず、閲覧中のHTTPS originを実行先とする。
  return {
    openapi: '3.0.3',
    info: { title: 'ROS WebRTC Bridge Signaling API', version: '1.0.0', description:
      'HTTPS signaling only. ROS Topic publish/subscribe uses the versioned WebRTC DataChannel protocol, not REST. Create the three required DataChannels and complete ICE gathering before submitting an offer.' },
    // 相対URLにより、Swaggerを開いたHTTPS originへ送信する。
    servers: [{ url: '/' }],
    paths: {
      // readyはHTTP受付の準備だけを示し、ROS接続の健全性は保証しない。
      '/health': { get: { operationId: 'getHealth', summary: 'Check signaling readiness', security: [], responses: {
        '200': { description: 'Signaling HTTP handler is ready; this does not certify ROS peer availability.', content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['ready'] } }
        } } } }
      // 公開healthにはBearerを要求せず、offerの認証と分離する。
      } } },
      '/offer': { post: { operationId: 'exchangeOffer', summary: 'Exchange a WebRTC SDP offer for an answer', security: [{ bearerAuth: [] }],
        description: 'Requires Content-Type exactly application/json. Body bytes, read timeout and concurrent negotiations are bounded by deployment settings. Invalid SDP or negotiation failure is rejected. An SDP answer alone does not establish the DataChannel ready handshake.',
        // handlerと同じくtype/sdpのみを受理し、未知fieldを禁止する。
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
          required: ['type', 'sdp'], properties: { type: { type: 'string', enum: ['offer'] }, sdp: { type: 'string' } }
        } } } },
        responses: {
          // answerはラップせず返す。DataChannelのreadyは別の交換で確認する。
          '200': { description: 'SDP answer; complete the WebRTC and DataChannel handshake on the client.', content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false, required: ['type', 'sdp'], properties: { type: { type: 'string', enum: ['answer'] }, sdp: { type: 'string' } }
          } } } },
          // 交渉失敗と認証失敗を固定分類で示し、内部例外は公開しない。
          '400': errorResponse('Malformed JSON, invalid offer fields or rejected negotiation.', 'offer_rejected'),
          '401': errorResponse('Missing or incorrect Bearer credential.', 'unauthorized'),
          '408': errorResponse('Request body read deadline exceeded.', 'request_timeout'),
          // 資源制限の拒否を区別し、利用者が要求サイズや頻度を調整できるようにする。
          '413': errorResponse('Request body exceeds the configured byte limit.', 'body_too_large'),
          '415': errorResponse('Content-Type is not exactly application/json.', 'content_type'),
          '503': errorResponse('Concurrent pending negotiation limit reached.', 'busy')
        }
      // HTTP応答の定義を閉じ、共通の認証方式はcomponentsへまとめる。
      } }
    },
    // schemeのみを公開し、実際のcredentialは仕様へ埋め込まない。
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Runtime-issued credential; never commit or persist it.' } } }
  };
}

/** 固定分類のerror応答schemaを作る。入力説明/分類、出力Response Object。例: unauthorized → 401用schema。 */
function errorResponse(description: string, error: string) {
  // errorは固定値だけを列挙し、任意の詳細fieldを応答契約に含めない。
  return { description, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['error'], properties: { error: { type: 'string', enum: [error] } }
  } } } };
}
