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
/** Memory the bodies still arriving may hold between them. */
export const ARRIVING_LIMIT_BYTES = 32 * 1024 * 1024;
/** Bodies still arriving at once: each also holds tens of KB of connection state. */
export const ARRIVING_LIMIT_BODIES = 1024;
// What a chunk costs beyond its bytes: the parser keeps one string piece for each.
const CHUNK_OVERHEAD_BYTES = 64;

/**
 * `buffered` bytes stay in memory, `discarded` ones are thrown away, and
 * `reserved` ones are already counted by the caller's own budget.
 */
export type BodyUse = 'buffered' | 'discarded' | 'reserved';
export type BodyWatcher = (
  req: express.Request,
  res: express.Response,
  use?: BodyUse,
  /** Once this resolves true, the body is dropped only after all the others. */
  vouched?: Promise<boolean>,
) => void;

/** A `/v1` body above this may take a while, so its key is checked as it arrives. */
export const VOUCH_ABOVE_BYTES = 16 * 1024;

export interface BodyWatcherLimits {
  idleTimeoutMs?: number;
  maxBytes?: number;
  maxBodies?: number;
}

export interface ProxyBodyOptions {
  watch: BodyWatcher;
  /** Resolves null for a caller allowed a large body, else how to refuse them. */
  authenticate: (req: express.Request, res: express.Response) => Promise<(() => void) | null>;
  inFlightLimitBytes?: number;
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

function carriesBody(req: express.Request): boolean {
  const { 'content-length': length, 'transfer-encoding': encoding } = req.headers;
  return encoding !== undefined || Number(length) > 0;
}

/**
 * Watches the request bodies still arriving, all routes together. A silent one is
 * dropped. When they hold too much, or are too many, the quietest goes first,
 * callers with a key last: refusing newcomers instead would let one caller lock
 * everybody else out.
 */
export function createBodyWatcher({
  idleTimeoutMs = BODY_IDLE_TIMEOUT_MS,
  maxBytes = ARRIVING_LIMIT_BYTES,
  maxBodies = ARRIVING_LIMIT_BODIES,
}: BodyWatcherLimits = {}): BodyWatcher {
  // A Map keeps insertion order, and every chunk moves its body to the end.
  const arriving = new Map<
    express.Request,
    { bytes: number; vouched: boolean; drop: (why: string) => void }
  >();
  const watched = new WeakSet<express.Request>();
  let heldBytes = 0;

  const makeRoom = (newest: express.Request) => {
    for (const spared of [true, false]) {
      for (const [req, body] of arriving) {
        const tooMany = arriving.size > maxBodies;
        if (!tooMany && heldBytes <= maxBytes) return;
        if (req === newest || (spared && body.vouched)) continue;
        // Over on bytes alone, dropping a body that holds none frees nothing.
        if (tooMany || body.bytes > 0) {
          body.drop('Too many unfinished request bodies, and this one was the quietest');
        }
      }
    }
  };

  return (req, res, use = 'buffered', vouched) => {
    if (watched.has(req) || req.complete || !carriesBody(req)) return;
    watched.add(req);

    const { socket } = req;
    const body = { bytes: 0, vouched: false, drop };
    void vouched?.then((ok) => (body.vouched = ok));
    const timer = setTimeout(() => drop('Timed out waiting for the request body'), idleTimeoutMs);
    const onData = (chunk: Buffer) => {
      timer.refresh();
      if (!arriving.delete(req)) return;
      if (use === 'buffered') {
        const cost = chunk.length + CHUNK_OVERHEAD_BYTES;
        body.bytes += cost;
        heldBytes += cost;
      }
      arriving.set(req, body);
      makeRoom(req);
    };
    function stop(): void {
      clearTimeout(timer);
      req.off('data', onData);
      socket.off('close', stop);
      if (arriving.delete(req)) heldBytes -= body.bytes;
    }
    // Answers and hangs up, so nothing downstream ever sees the half-read body.
    function drop(why: string): void {
      stop();
      // Everything has arrived: it is only waiting to be handled.
      if (req.complete) return;
      if (!res.headersSent) {
        res.set('Connection', 'close');
        reject(res, 408, 'Request Timeout', why);
      }
      req.destroy();
    }

    // A `data` listener starts a stream flowing, so only join an existing reader.
    if (req.listenerCount('data') > 0 || req.readableFlowing) req.on('data', onData);
    finished(req, stop);
    // Once answered, a request no longer hears that its connection closed.
    socket.once('close', stop);
    if (use === 'reserved') return;
    arriving.set(req, body);
    makeRoom(req);
  };
}

/**
 * Mount ahead of everything. A body can be answered before it has arrived (rate
 * limit, unknown route, wrong content type) and still holds its connection.
 */
export function watchLeftoverBodies(watch: BodyWatcher): express.RequestHandler {
  return (req, res, next) => {
    res.once('finish', () => watch(req, res, 'discarded'));
    next();
  };
}

/**
 * Reads a refused body into the void. Answering mid-upload resets some clients
 * before they hear why.
 */
function discardBody(req: express.Request, res: express.Response, watch: BodyWatcher) {
  return new Promise<void>((resolve) => {
    finished(req, () => resolve());
    req.on('data', () => undefined);
    watch(req, res, 'discarded');
  });
}

/**
 * Parses `/v1` JSON bodies. A body above the regular API limit is read only
 * after its caller authenticates, and only while its declared size fits a shared
 * budget. Compressed bodies are refused: they hide their real size.
 */
export function createProxyBodyMiddleware({
  watch,
  authenticate,
  inFlightLimitBytes = PROXY_IN_FLIGHT_LIMIT_BYTES,
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
      // Checked beside the upload, so a slow agent keeps its place under a flood.
      const vouched =
        declared > VOUCH_ABOVE_BYTES && req.headers.authorization
          ? authenticate(req, res).then(
              (refuse) => !refuse,
              () => false,
            )
          : undefined;
      watch(req, res, 'buffered', vouched);
      return;
    }

    const refuse = await authenticate(req, res);
    if (refuse) {
      await discardBody(req, res, watch);
      // A body that stalled was already answered with 408.
      if (!res.headersSent) refuse();
      return;
    }
    if (res.destroyed) return;
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
    watch(req, res, 'reserved');
  };
}

/**
 * Reads a Better Auth body under a byte cap, chunked bodies included: its Node
 * handler reads without one.
 */
export function createAuthBodyMiddleware(watch: BodyWatcher): express.RequestHandler {
  // Text, not raw: Better Auth takes a string body as it is (Stripe signs it).
  const parse = express.text({ type: () => true, limit: API_BODY_LIMIT, inflate: false });

  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      // The Node handler expects no body, not an empty one.
      if (req.body === '') req.body = undefined;
      next(err);
    });
    watch(req, res);
  };
}

/** Parses the JSON and form bodies of every other route. */
export function createApiBodyMiddleware(watch: BodyWatcher): express.RequestHandler {
  const options = { limit: API_BODY_LIMIT, inflate: false };
  const parseJson = express.json(options);
  const parseForm = express.urlencoded({ ...options, extended: true });

  return (req, res, next) => {
    parseJson(req, res, (err?: unknown) => (err ? next(err) : parseForm(req, res, next)));
    watch(req, res);
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
