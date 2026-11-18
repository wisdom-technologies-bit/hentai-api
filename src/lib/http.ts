/**
 * Fetching the adult sources through one door.
 *
 * Both scraped sites (hanime.tv, hentaihaven.xxx) sit behind a Cloudflare
 * interstitial that answers a plain `fetch` with `403 Just a moment...` and no
 * data. That is not a parse bug and never will be, so it is detected here and
 * reported as its own error instead of surfacing as a mysterious empty result.
 *
 * Two escape hatches, both off by default:
 *  - `SOURCE_PROXY_URL` routes the request through an HTTP/SOCKS proxy, which is
 *    what a residential or mobile egress looks like to Cloudflare;
 *  - `UNBLOCKER_URL` prefixes the target through a hosted unblocker (ScraperAPI,
 *    ZenRows, Bright Data) that does the challenge for us.
 *
 * Rule34 is deliberately not proxied: its own API is reachable directly and now
 * wants an api key, which is a different problem with a different fix.
 */

export class UpstreamError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.status = status
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const CHALLENGE_TITLES = ['just a moment', 'attention required', 'checking your browser']

/** A Cloudflare (or similar) interstitial, not the page we asked for. */
export function looksLikeChallenge(status: number, body: string): boolean {
  if (status !== 403 && status !== 503) return false
  const sample = body.slice(0, 4000).toLowerCase()
  if (CHALLENGE_TITLES.some((title) => sample.includes(title))) return true
  return sample.includes('cf-browser-verification') || sample.includes('__cf_chl_')
}

export function unblockedUrl(target: string, env: Record<string, string | undefined> = process.env): string {
  const base = (env.UNBLOCKER_URL ?? '').trim()
  if (!base) return target
  const joiner = base.includes('?') ? '&' : '?'
  return `${base}${joiner}url=${encodeURIComponent(target)}`
}

/** `SOURCE_PROXY_URL` parsed for Bun's fetch, or undefined when unset/invalid. */
export function proxyFor(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = (env.SOURCE_PROXY_URL ?? '').trim()
  if (!raw) return undefined
  return /^(https?|socks5h?):\/\//i.test(raw) ? raw : undefined
}

export async function fetchSource(
  target: string,
  init: RequestInit = {},
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  const url = unblockedUrl(target, env)
  const proxy = proxyFor(env)
  const response = await fetch(url, {
    ...init,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      ...(init.headers ?? {}),
    },
    // Bun understands `proxy`; other runtimes simply ignore it.
    ...(proxy ? ({ proxy } as RequestInit) : {}),
  } as RequestInit)
  return response
}

/** Fetch HTML and refuse a challenge instead of parsing it into nothing. */
export async function fetchSourceHtml(target: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const response = await fetchSource(target, {}, env)
  const body = await response.text()
  if (looksLikeChallenge(response.status, body)) {
    throw new UpstreamError(
      'CLOUDFLARE_CHALLENGE',
      'The source answered with a Cloudflare challenge. Set SOURCE_PROXY_URL (residential egress) or UNBLOCKER_URL, or use the browser resolver.',
      502,
    )
  }
  if (!response.ok) {
    throw new UpstreamError('UPSTREAM_HTTP', `Source responded ${response.status}`, 502)
  }
  return body
}
