/** Return the single HTTP signaling specification. No input; returns an OpenAPI document. Topic traffic follows the DataChannel contract. */
export function signalingOpenApi() {
  // Use the current HTTPS origin without embedding credentials or deployment hosts.
  return {
    openapi: '3.0.3',
    info: { title: 'ROS WebRTC Bridge Signaling API', version: '1.0.0', description:
      'HTTPS signaling only. ROS Topic publish/subscribe uses the versioned WebRTC DataChannel protocol, not REST. Create the three required DataChannels and complete ICE gathering before submitting an offer.' },
    // Relative URLs send requests to the HTTPS origin serving Swagger.
    servers: [{ url: '/' }],
    paths: {
      // Ready indicates HTTP request readiness only; it does not guarantee ROS connection health.
      '/health': { get: { operationId: 'getHealth', summary: 'Check signaling readiness', security: [], responses: {
        '200': { description: 'Signaling HTTP handler is ready; this does not certify ROS peer availability.', content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['ready'] } }
        } } } }
      // Public health checks require no Bearer credential and are separate from offer authentication.
      } } },
      '/offer': { post: { operationId: 'exchangeOffer', summary: 'Exchange a WebRTC SDP offer for an answer', security: [{ bearerAuth: [] }],
        description: 'Requires Content-Type exactly application/json. Body bytes, read timeout and concurrent negotiations are bounded by deployment settings. Invalid SDP or negotiation failure is rejected. An SDP answer alone does not establish the DataChannel ready handshake.',
        // Accept only type and sdp, matching the handler; reject unknown fields.
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
          required: ['type', 'sdp'], properties: { type: { type: 'string', enum: ['offer'] }, sdp: { type: 'string' } }
        } } } },
        responses: {
          // Return the answer without wrapping. DataChannel readiness is checked in a separate exchange.
          '200': { description: 'SDP answer; complete the WebRTC and DataChannel handshake on the client.', content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false, required: ['type', 'sdp'], properties: { type: { type: 'string', enum: ['answer'] }, sdp: { type: 'string' } }
          } } } },
          // Use fixed classifications for negotiation and authentication failures; do not expose internal exceptions.
          '400': errorResponse('Malformed JSON, invalid offer fields or rejected negotiation.', 'offer_rejected'),
          '401': errorResponse('Missing or incorrect Bearer credential.', 'unauthorized'),
          '408': errorResponse('Request body read deadline exceeded.', 'request_timeout'),
          // Distinguish resource-limit rejections so clients can adjust request size or frequency.
          '413': errorResponse('Request body exceeds the configured byte limit.', 'body_too_large'),
          '415': errorResponse('Content-Type is not exactly application/json.', 'content_type'),
          '503': errorResponse('Concurrent pending negotiation limit reached.', 'busy')
        }
      // Define closed HTTP response schemas and collect the shared authentication scheme in components.
      } }
    },
    // Expose only the scheme; never embed actual credentials in the specification.
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Runtime-issued credential; never commit or persist it.' } } }
  };
}

/** Create a fixed-classification error response schema. Inputs: description/classification; returns a Response Object, e.g. unauthorized for 401. */
function errorResponse(description: string, error: string) {
  // Enumerate only fixed error values; arbitrary detail fields are outside the response contract.
  return { description, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['error'], properties: { error: { type: 'string', enum: [error] } }
  } } } };
}
