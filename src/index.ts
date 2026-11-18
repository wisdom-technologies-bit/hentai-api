import { Hono } from "hono";
import { HentaiHaven } from "./providers/hentai-haven";
import { Rule34 } from "./providers/rule34";
import { prettyJSON } from "hono/pretty-json";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import Redis from "ioredis";
import { MongoClient, Db, Collection } from "mongodb";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from 'zod';
import Hanime from "./providers/hanime";
import { SearchResultSchema, VideoSchema } from "./schema/hanime";
import { InfoSchema, SearchAutocompleteSchema } from "./schema/r34";
import { HentaiInfoSchema, HentaiSearchResultSchema, HentaiSourceSchema } from "./schema/hentai-haven";

/**
 * Redis is a cache and a rate-limit counter, not a hard dependency: a deployment
 * without it still resolves, it just recomputes and forgets. Requiring it (the
 * old behaviour, which exited) is what made this service impossible to run as a
 * single container.
 */
const redis = process.env.REDIS_HOST
  ? new Redis({
      host: process.env.REDIS_HOST,
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    })
  : undefined;

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

const kvGet = async (key: string): Promise<string | null> => {
  if (redis) return redis.get(key);
  const row = memoryStore.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) { memoryStore.delete(key); return null; }
  return row.value;
};
const kvSetEx = async (key: string, value: string, ttlSeconds: number): Promise<void> => {
  if (redis) { await redis.set(key, value, 'EX', ttlSeconds); return; }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
};
const kvDel = async (key: string): Promise<void> => {
  if (redis) { await kvDel(key); return; }
  memoryStore.delete(key);
};
const kvIncr = async (key: string): Promise<number> => {
  if (redis) return redis.incr(key);
  const row = memoryStore.get(key);
  const next = (row && row.expiresAt > Date.now() ? Number(row.value) : 0) + 1;
  memoryStore.set(key, { value: String(next), expiresAt: row && row.expiresAt > Date.now() ? row.expiresAt : Date.now() + 60_000 });
  return next;
};
const kvExpire = async (key: string, ttlSeconds: number): Promise<void> => {
  if (redis) { await redis.expire(key, ttlSeconds); return; }
  const row = memoryStore.get(key);
  if (row) row.expiresAt = Date.now() + ttlSeconds * 1000;
};
const mongoClient = process.env.MONGODB_URL ? new MongoClient(process.env.MONGODB_URL) : undefined;
let db: Db | undefined;
let apiKeyCollection: Collection | undefined;

const connectToDb = async () => {
  if(mongoClient) {
    await mongoClient.connect();
    db = mongoClient.db();
    apiKeyCollection = db.collection("apiKeys");
  }
};

const app = new Hono();

app.use(cors());
app.use(prettyJSON());
app.use(logger());

app.get("/", (c) => {
  return c.text("Welcome to Hentai API!");
});

const rateLimit = async (c: Context, key: string, limit: number, ttl: number): Promise<Response | void> => {
  const count = await kvIncr(key);
  if (count > limit) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await kvExpire(key, ttl);
};

const cache = async <T extends object>(c: Context, key: string, fetcher: () => Promise<T>): Promise<Response> => {
  const cached = await kvGet(key);
  if (cached) {
    try {
      const data = JSON.parse(cached) as T;
      if (data === null || data === undefined || Object.keys(data).length === 0 || (Array.isArray(data) && data.length === 0) || (typeof data === 'string' && (data as string).trim() === '')) {
        await kvDel(key);
        const freshData = await fetcher();
        await kvSetEx(key, JSON.stringify(freshData), 3600);
        return c.json(freshData);
      }
      return c.json(data);
    } catch (error) {
      await kvDel(key);
      const freshData = await fetcher();
      await kvSetEx(key, JSON.stringify(freshData), 3600);
      return c.json(freshData);
    }
  }
  const data = await fetcher();
  if (data === null || data === undefined || Object.keys(data).length === 0 || (Array.isArray(data) && data.length === 0) || (typeof data === 'string' && (data as string).trim() === '')) {
    return c.json(data);
  }
  await kvSetEx(key, JSON.stringify(data), 3600);
  return c.json(data);
};

const apiKeyAuth = async (c: Context): Promise<Response | void> => {
  const apiKey = c.req.header("x-api-key")||c.req.query("apiKey");
  if (!apiKey) {
    return undefined;
  }
  const key = await apiKeyCollection?.findOne({ key: apiKey });
  if (!key) {
    return c.json({ error: "Invalid API key" }, 401);
  }
  return undefined;
};

const handleRequest = async <T>(c: Context, provider: any, method: string, schema: z.ZodSchema<any>, ...args: any[]): Promise<Response> => {
  try {
    const apiKeyResult = await apiKeyAuth(c);
    const conninfo = await getConnInfo(c);
    const limit = apiKeyResult ? 1500 : 15;
    const ttl = 60;
    const rateLimitKey = `${provider.name}-${method}-${conninfo.remote.address}-${conninfo.remote.port}`;
    const rateLimited = await rateLimit(c, rateLimitKey, limit, ttl);
    if (rateLimited) return rateLimited;

    const key = `${provider.name}-${method}-${JSON.stringify(args)}`;
    return await cache(c, key, async () => {
      const instance = new provider();
      const result = await instance[method](...args);
      return schema.parse(result);
    });
  } catch (error) {
    console.error("Error handling request:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: error.issues }, 422);
    }
    return c.json({ error: "Internal server error" }, 500);
  }
};

const querySchema = z.string().min(1);
const idSchema = z.string().min(1);

app.get("/api/hh/search/:query", async (c) => {
  const query = querySchema.parse(c.req.param("query"));
  return await handleRequest(c, HentaiHaven, "fetchSearchResult", HentaiSearchResultSchema, query);
});

app.get("/api/hh/:id", async (c) => {
  const id = idSchema.parse(c.req.param("id"));
  return await handleRequest(c, HentaiHaven, "fetchInfo", HentaiInfoSchema, id);
});

app.get("/api/hh/sources/:id", async (c) => {
  const id = idSchema.parse(c.req.param("id"));
  return await handleRequest(c, HentaiHaven, "fetchSources", HentaiSourceSchema, id);
});

app.get("/api/r34/autocomplete/:query", async (c) => {
  const keyCheck = requireRule34Key(c);
  if (keyCheck) return keyCheck;
  const query = querySchema.parse(c.req.param("query"));
  console.log(query)
  return await handleRequest(c, Rule34, "fetchSearchAutocomplete", SearchAutocompleteSchema, query);
});

app.get("/api/r34/search/:query", async (c) => {
  const keyCheck = requireRule34Key(c);
  if (keyCheck) return keyCheck;
  const query = querySchema.parse(c.req.param("query"));
  return await handleRequest(c, Rule34, "fetchSearchResult", SearchResultSchema, query);
});

app.get("/api/r34/:id", async (c) => {
  const keyCheck = requireRule34Key(c);
  if (keyCheck) return keyCheck;
  const id = idSchema.parse(c.req.param("id"));
  return await handleRequest(c, Rule34, "fetchInfo", InfoSchema, id);
});

app.get("/api/hanime/search/:query", async (c) => {
    const query = querySchema.parse(c.req.param("query"));

    return await handleRequest(c, Hanime, "search", SearchResultSchema, query);
});

app.get("/api/hanime/:id", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    return await handleRequest(c, Hanime, "getInfo", VideoSchema, id);
});

app.get("/api/hanime/streams/:id", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    return await handleRequest(c, Hanime, "getEpisode", z.any(), id);
});

/**
 * Liveness and configuration, without touching an upstream. Every degraded
 * capability is named, so a deploy can be checked with one curl.
 */
app.get("/health", (c) => c.json({
  ok: true,
  cache: redis ? "redis" : "memory",
  apiKeys: apiKeyCollection ? "mongo" : "open",
  proxy: Boolean(process.env.SOURCE_PROXY_URL),
  unblocker: Boolean(process.env.UNBLOCKER_URL),
  rule34Key: Boolean(process.env.R34_API_KEY),
}));

/**
 * Rule34's API now answers `Missing authentication` to every dapi query, so the
 * r34 routes only work with a key. Say so instead of returning an empty list.
 */
const requireRule34Key = (c: Context): Response | undefined => {
  if (process.env.R34_API_KEY) return undefined;
  return c.json({
    error: "RULE34_API_KEY_REQUIRED",
    message: "api.rule34.xxx now requires an api_key on every dapi request. Set R34_API_KEY.",
  }, 502);
};

/**
 * The resolver KumoriTV uses for an adult title.
 *
 * `hanime.tv` deleted the JSON endpoints this project was built on and now hides
 * the stream behind a client-side player, so the browser is the only reliable
 * reader. Title mode takes a slug or a title (slugified, which is how hanime
 * names its videos) and returns the streams the player requested.
 */
app.get("/api/resolve", async (c) => {
  const slug = (c.req.query("slug") || "").trim();
  const title = (c.req.query("title") || "").trim();
  const candidate = slug || (title ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "");
  if (!candidate) return c.json({ error: "MISSING_QUERY", message: "Pass ?slug= or ?title=" }, 400);

  try {
    const { loadWithBrowser } = await import("./lib/browser");
    const page = await loadWithBrowser(`https://hanime.tv/videos/hentai/${candidate}`, {
      proxyUrl: process.env.SOURCE_PROXY_URL,
      timeoutMs: Number(process.env.BROWSER_TIMEOUT_MS ?? 45_000),
    });
    if (page.streams.length === 0) {
      return c.json({ error: "NO_STREAM_FOUND", slug: candidate, title: page.title }, 404);
    }
    return c.json({ provider: "hanime", slug: candidate, title: page.title, poster: page.poster, streams: page.streams });
  } catch (error: any) {
    const status = typeof error?.status === "number" ? error.status : 502;
    return c.json({ error: error?.code ?? "RESOLVE_FAILED", message: String(error?.message ?? error).slice(0, 240) }, status);
  }
});

const port = process.env.PORT || 3000;

export default {
  fetch: app.fetch,
  port: port,
};

connectToDb();