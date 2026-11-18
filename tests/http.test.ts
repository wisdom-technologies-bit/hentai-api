import { describe, expect, it } from 'bun:test'
import { looksLikeChallenge, proxyFor, unblockedUrl } from '../src/lib/http'

describe('cloudflare detection', () => {
  it('recognises the interstitial instead of parsing it', () => {
    expect(looksLikeChallenge(403, '<title>Just a moment...</title>')).toBe(true)
    expect(looksLikeChallenge(503, '<title>Attention Required! | Cloudflare</title>')).toBe(true)
    expect(looksLikeChallenge(403, '<html>__cf_chl_opt</html>')).toBe(true)
  })

  it('does not mistake a real page or a real 403 for a challenge', () => {
    expect(looksLikeChallenge(200, '<title>Hitori Tsuma 1</title>')).toBe(false)
    expect(looksLikeChallenge(403, '{"error":"forbidden"}')).toBe(false)
    expect(looksLikeChallenge(404, '<title>Just a moment...</title>')).toBe(false)
  })
})

describe('proxy and unblocker configuration', () => {
  it('accepts http and socks proxies, rejects junk', () => {
    expect(proxyFor({ SOURCE_PROXY_URL: 'http://user:pass@1.2.3.4:8080' })).toBe('http://user:pass@1.2.3.4:8080')
    expect(proxyFor({ SOURCE_PROXY_URL: 'socks5://1.2.3.4:1080' })).toBe('socks5://1.2.3.4:1080')
    expect(proxyFor({ SOURCE_PROXY_URL: '1.2.3.4:8080' })).toBeUndefined()
    expect(proxyFor({})).toBeUndefined()
  })

  it('url-encodes the target for an unblocker and keeps existing query params', () => {
    expect(unblockedUrl('https://hanime.tv/x', {})).toBe('https://hanime.tv/x')
    expect(unblockedUrl('https://hanime.tv/a?b=1', { UNBLOCKER_URL: 'https://u.example/api' }))
      .toBe('https://u.example/api?url=https%3A%2F%2Fhanime.tv%2Fa%3Fb%3D1')
    expect(unblockedUrl('https://hanime.tv/a', { UNBLOCKER_URL: 'https://u.example/api?key=k' }))
      .toBe('https://u.example/api?key=k&url=https%3A%2F%2Fhanime.tv%2Fa')
  })
})
