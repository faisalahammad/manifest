import * as express from 'express';
import { finished } from 'node:stream';

export const API_BODY_LIMIT = '1mb';
export const API_BODY_LIMIT_BYTES = 1024 * 1024;
// Room for large inline images and long contexts: Anthropic caps a request at
// 32 MB and OpenAI its images at 50 MB.
export const PROXY_BODY_LIMIT = '64mb';
export const PROXY_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
/**
 * Bytes of large proxy bodies one process holds at once, across all callers.
 * shortcut: a body costs about six times its size while it is proxied, so a long
 * burst of near-limit bodies from key holders can still exhaust the 1 GB Compose
 * container. Cut that cost or raise `mem_limit` if it matters.
 */
export const PROXY_IN_FLIGHT_LIMIT_BYTES = 64 * 1024 * 1024;
/** Longest silence allowed while a body arrives. Node caps the total time. */
export const BODY_IDLE_TIMEOUT_MS = 30_000;

export interface ProxyBodyOptions {
  /** Resolves false once it has answered a caller it refuses. */
  authenticate: (req: express.Request, res: express.Response) => Promise<boolean>;
  inFlightLimitBytes?: number;
  idleTimeoutMs?: number;
}

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  if (!(err instanceof Error)) return false;
  const maybe = err as BodyParserError;
  return typeof maybe.type === 'string' || maybe.status === 413 || maybe.statusCode === 413;
}

function reject(res: express.Response, statusCode: number, error: string, message: string): void {
  res.status(statusCode).json({ message, error, statusCode });
}

/** Watches a body someone is reading, and drops the request when it stalls. */
function watchBody(req: express.Request, res: express.Response, idleTimeoutMs: number): void {
  // A `data` listener starts the stream flowing, so only join an existing reader.
  if (req.listenerCount('data') === 0) return;

  // Answer and hang up, so nothing downstream ever sees the half-read body.
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.set('Connection', 'close');
      reject(res, 408, 'Request Timeout', 'Timed out waiting for the request body');
    }
    req.destroy();
  }, idleTimeoutMs);
  const onData = () => timer.refresh();
  const stop = () => {
    clearTimeout(timer);
    req.off('data', onData);
  };
  req.on('data', onData);
  finished(req, stop);
  res.once('close', stop);
}

/**
 * Reads a refused body into the void. Answering mid-upload resets some clients
 * before they hear why.
 */
export function discardBody(
  req: express.Request,
  res: express.Response,
  idleTimeoutMs = BODY_IDLE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    finished(req, () => resolve());
    req.on('data', () => undefined);
    watchBody(req, res, idleTimeoutMs);
  });
}

/**
 * Parses `/v1` JSON bodies. A body above the regular API limit is read only
 * after its caller authenticates, and only while its declared size fits a shared
 * budget. Compressed bodies are refused: they hide their real size.
 */
export function createProxyBodyMiddleware({
  authenticate,
  inFlightLimitBytes = PROXY_IN_FLIGHT_LIMIT_BYTES,
  idleTimeoutMs = BODY_IDLE_TIMEOUT_MS,
}: ProxyBodyOptions): express.RequestHandler {
  let activeBytes = 0;
  // Two limits, so an unauthenticated read stays small whatever the headers claim.
  const parseSmall = express.json({ limit: API_BODY_LIMIT, inflate: false });
  const parseLarge = express.json({ limit: PROXY_BODY_LIMIT, inflate: false });

  return async (req, res, next) => {
    const contentLength = req.headers['content-length'];
    const transferEncoding = req.headers['transfer-encoding']?.toLowerCase();
    if (contentLength === undefined && transferEncoding?.includes('chunked')) {
      reject(res, 411, 'Length Required', 'Content-Length is required for proxy request bodies');
      return;
    }

    const declared = Number(contentLength ?? 0);
    if (!Number.isInteger(declared) || declared < 0) {
      reject(res, 400, 'Bad Request', 'Invalid Content-Length header');
      return;
    }
    if (declared > PROXY_BODY_LIMIT_BYTES) {
      reject(res, 413, 'Payload Too Large', `Request body exceeds ${PROXY_BODY_LIMIT}`);
      return;
    }

    // Small bodies are cheap, and the route's own guard checks them after parsing.
    if (declared <= API_BODY_LIMIT_BYTES) {
      parseSmall(req, res, next);
      watchBody(req, res, idleTimeoutMs);
      return;
    }

    if (!(await authenticate(req, res)) || res.destroyed) return;
    // Reserved before reading, and only for a caller with a key. Refusing an
    // upload midway leaves its bytes in memory until the next collection.
    if (activeBytes + declared > inFlightLimitBytes) {
      reject(res, 429, 'Too Many Requests', 'Too many large proxy requests in flight');
      return;
    }

    activeBytes += declared;
    res.once('close', () => {
      activeBytes -= declared;
    });
    parseLarge(req, res, next);
    watchBody(req, res, idleTimeoutMs);
  };
}

/**
 * Reads a Better Auth body under a byte cap, chunked bodies included: its Node
 * handler reads without one.
 */
export function createAuthBodyMiddleware(
  idleTimeoutMs = BODY_IDLE_TIMEOUT_MS,
): express.RequestHandler {
  // Text, not raw: Better Auth takes a string body as it is (Stripe signs it).
  const parse = express.text({ type: () => true, limit: API_BODY_LIMIT, inflate: false });

  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      // The Node handler expects no body, not an empty one.
      if (req.body === '') req.body = undefined;
      next(err);
    });
    watchBody(req, res, idleTimeoutMs);
  };
}

export function bodyParserErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!isBodyParserError(err)) {
    next(err);
    return;
  }

  // The idle timeout already answered; the parser is only reporting the hang-up.
  if (res.headersSent) return;

  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    reject(res, 413, 'Payload Too Large', 'Request body is too large');
    return;
  }

  if (err.status === 415) {
    reject(res, 415, 'Unsupported Media Type', 'Unsupported request body encoding');
    return;
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    reject(res, 400, 'Bad Request', 'Invalid JSON request body');
    return;
  }

  next(err);
}
