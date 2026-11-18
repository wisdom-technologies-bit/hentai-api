/**
 * A browser for the sources a plain request cannot reach.
 *
 * hanime.tv removed the JSON endpoints this project was written against
 * (`/rapi/v7/videos_manifests`, `/rapi/v8`, `/api/v8/video` all answer 404 now)
 * and rebuilt the site as Astro with a client-side player. Nothing about the
 * stream URL is in the HTML, so the only stable way to learn it is to let a real
 * browser start the player and watch what it requests.
 *
 * That is what this does: load the page, wait for a media response, keep it.
 * If the egress IP is unacceptable to Cloudflare the page never gets past the
 * interstitial, which is reported as CLOUDFLARE_CHALLENGE rather than an empty
 * result.
 */
import { UpstreamError } from './http'

export type ResolvedStream = {
  url: string
  kind: 'hls' | 'mp4'
  quality: string | null
}

export type BrowserPage = {
  title: string
  poster: string | null
  streams: ResolvedStream[]
}

type LaunchOptions = {
  proxyUrl?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 45_000

function isMediaUrl(url: string): 'hls' | 'mp4' | null {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls'
  if (/\.mp4(\?|$)/i.test(url)) return 'mp4'
  return null
}

function qualityOf(url: string): string | null {
  const match = url.match(/(\d{3,4})p/i) ?? url.match(/\/(\d{3,4})\//)
  return match ? `${match[1]}p` : null
}

/**
 * Pick the best stream out of everything the player asked for: HLS first, then
 * the largest mp4, with duplicates collapsed by URL.
 */
export function pickStreams(urls: string[]): ResolvedStream[] {
  const seen = new Set<string>()
  const streams: ResolvedStream[] = []
  for (const raw of urls) {
    if (typeof raw !== 'string') continue
    const kind = isMediaUrl(raw)
    if (!kind || seen.has(raw)) continue
    seen.add(raw)
    streams.push({ url: raw, kind, quality: qualityOf(raw) })
  }
  const rank = (stream: ResolvedStream) =>
    stream.kind === 'hls' ? 100_000 : Number.parseInt(stream.quality ?? '0', 10) || 0
  return streams.sort((a, b) => rank(b) - rank(a))
}

export async function loadWithBrowser(
  url: string,
  options: LaunchOptions = {},
): Promise<BrowserPage> {
  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new UpstreamError(
      'BROWSER_UNAVAILABLE',
      'playwright is not installed; run `bunx playwright install chromium` (the Dockerfile does this).',
      503,
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const browser = await chromium.launch({
    headless: true,
    proxy: options.proxyUrl ? { server: options.proxyUrl } : undefined,
  })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const media: string[] = []
    page.on('response', (response) => {
      const target = response.url()
      if (isMediaUrl(target)) media.push(target)
    })

    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const title = await page.title()
    if (/just a moment|attention required|checking your browser/i.test(title)) {
      throw new UpstreamError(
        'CLOUDFLARE_CHALLENGE',
        'The browser was challenged. Point SOURCE_PROXY_URL at a residential egress.',
        502,
      )
    }
    if (navigation && navigation.status() >= 400) {
      throw new UpstreamError('UPSTREAM_HTTP', `Source responded ${navigation.status()}`, 502)
    }

    // Give the player a chance to negotiate; most sources fire within a few seconds.
    const deadline = Date.now() + 20_000
    while (media.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(500)
      const play = page.locator('video, .player, [class*="player"]').first()
      if (await play.count()) await play.click({ timeout: 1_000 }).catch(() => {})
    }

    const poster = (await page.getAttribute('meta[property="og:image"]', 'content').catch(() => null)) ?? null
    return { title: title.replace(/\s*\|\s*hanime\.tv.*$/i, '').trim(), poster, streams: pickStreams(media) }
  } finally {
    await browser.close()
  }
}
