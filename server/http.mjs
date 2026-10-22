// The Remote binding (§9.2): MCP streamable HTTP with one bearer token per client.
//
// - Every request is authenticated against clients.json (clients.mjs). The client's name
//   is handed to the tools, which bind every write to it (index.mjs).
// - Requests that carry a browser Origin header are refused.
// - Only POST: the server is stateless, with no sessions and no streams to resume.
// - Plain HTTP is served only on a loopback address (index.mjs refuses anything else).
//   A server reached from another machine needs TLS: --tls-cert and --tls-key, or a TLS
//   reverse proxy in front of a loopback server.
// Nothing that is said is logged.
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const PATH = '/mcp';

/** "8721", ":8721", "host:8721" or "[::1]:8721" as {host, port}; undefined when malformed. */
export function parseListen(value) {
  if (typeof value !== 'string' || !value) return undefined;
  let host = '127.0.0.1';
  let port = value;
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (bracketed) {
    [, host, port] = bracketed;
  } else if (value.includes(':')) {
    const index = value.lastIndexOf(':');
    host = value.slice(0, index) || host;
    port = value.slice(index + 1);
  }
  if (!/^\d+$/.test(port) || Number(port) > 65535) return undefined;
  return { host, port: Number(port) };
}

export const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

function refuse(res, status, message, headers = {}, code = -32000) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** The request body as text; past the limit, the rest is read and dropped, then refused. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(Object.assign(new Error('too large'), { tooLarge: true })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/**
 * Listens for MCP requests. createServer({client}) makes the MCP server for one request,
 * bound to the authenticated client. Resolves with the listening node:http(s) server.
 */
export function serveHttp({ listen, tls, clients, createServer, maxBody }) {
  const handle = async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
      if (path !== PATH) return refuse(res, 404, `Not found. The MCP endpoint is ${PATH}.`);
      if (req.headers.origin !== undefined) return refuse(res, 403, 'Refused: the request comes from a browser page (it carries an Origin header).');
      const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
      const client = bearer ? clients.verify(bearer[1]) : undefined;
      if (!client) {
        return refuse(res, 401, 'A bearer token issued by this server is required: Authorization: Bearer <token>.', { 'WWW-Authenticate': 'Bearer realm="protocol-chaos"' });
      }
      if (req.method !== 'POST') return refuse(res, 405, 'Only POST: this server keeps no sessions.', { Allow: 'POST' });
      let body;
      try {
        body = JSON.parse(await readBody(req, maxBody));
      } catch (error) {
        return error.tooLarge
          ? refuse(res, 413, `The request is larger than ${maxBody} bytes.`)
          : refuse(res, 400, 'The request body is not JSON.', {}, -32700);
      }
      const server = createServer({ client });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) refuse(res, 500, 'The server failed unexpectedly; nothing was changed.');
      else res.end();
    }
  };
  const server = tls
    ? createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handle)
    : createHttpServer(handle);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
