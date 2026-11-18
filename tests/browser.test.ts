import { describe, expect, it } from 'bun:test'
import { pickStreams } from '../src/lib/browser'

describe('stream selection', () => {
  it('prefers HLS and keeps the highest quality mp4 behind it', () => {
    const picked = pickStreams([
      'https://cdn.example/v/720p.mp4',
      'https://cdn.example/v/1080p.mp4',
      'https://cdn.example/hls/master.m3u8?token=abc',
      'https://cdn.example/hls/master.m3u8?token=abc',
      'https://cdn.example/poster.jpg',
    ])
    expect(picked[0].kind).toBe('hls')
    expect(picked[0].url).toContain('master.m3u8')
    expect(picked.filter((stream) => stream.kind === 'hls')).toHaveLength(1)
    expect(picked[1].quality).toBe('1080p')
    expect(picked.every((stream) => !stream.url.endsWith('.jpg'))).toBe(true)
  })

  it('ignores non-media and malformed entries', () => {
    expect(pickStreams(['', 'https://x/y.jpg', 'not a url'])).toHaveLength(0)
  })
})
