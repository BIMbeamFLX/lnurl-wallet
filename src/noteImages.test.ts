import {afterEach, describe, expect, it, vi} from 'vitest'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'

import {
  payRequestImage,
  fetchDeclaredArtwork,
  declaredArtwork
} from './noteImages'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='
const JPEG_B64 = '/9j/4AAQSkZJRg=='

const metadata = (entries: unknown): string => JSON.stringify(entries)

describe('payRequestImage', () => {
  it('returns a data URL for a png metadata entry', () => {
    const result = payRequestImage(
      metadata([
        ['text/plain', 'mint me'],
        ['image/png;base64', PNG_B64]
      ])
    )
    expect(result).toBe(`data:image/png;base64,${PNG_B64}`)
  })

  it('returns a data URL for a jpeg metadata entry', () => {
    const result = payRequestImage(metadata([['image/jpeg;base64', JPEG_B64]]))
    expect(result).toBe(`data:image/jpeg;base64,${JPEG_B64}`)
  })

  it('returns null when metadata has no image entry', () => {
    expect(payRequestImage(metadata([['text/plain', 'mint me']]))).toBeNull()
  })

  it('returns null for malformed metadata', () => {
    expect(payRequestImage('not json')).toBeNull()
    expect(payRequestImage(metadata({}))).toBeNull()
    expect(payRequestImage(metadata('just a string'))).toBeNull()
  })

  it('ignores unknown image types', () => {
    expect(
      payRequestImage(metadata([['image/svg+xml;base64', PNG_B64]]))
    ).toBeNull()
  })

  it('skips entries that are not valid base64', () => {
    const result = payRequestImage(
      metadata([
        ['image/png;base64', 'not base64!!!'],
        ['image/jpeg;base64', JPEG_B64]
      ])
    )
    expect(result).toBe(`data:image/jpeg;base64,${JPEG_B64}`)
  })

  it('skips oversized entries', () => {
    const huge = 'A'.repeat(262_148)
    expect(payRequestImage(metadata([['image/png;base64', huge]]))).toBeNull()
  })
})

const ART_BYTES = new TextEncoder().encode('600B card art bytes')
const ART_HASH = bytesToHex(sha256(ART_BYTES))

const artResponse = (contentType = 'image/webp') => ({
  ok: true,
  headers: {get: () => contentType},
  arrayBuffer: async () => ART_BYTES.slice().buffer
})

afterEach(() => vi.unstubAllGlobals())

describe('fetchDeclaredArtwork', () => {
  it('returns a data URL when the bytes match the declared hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => artResponse())
    )
    const result = await fetchDeclaredArtwork(
      'https://blossom.example/blob',
      ART_HASH
    )
    expect(result).toMatch(/^data:image\/webp;base64,/)
  })

  it('rejects bytes that do not match the hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => artResponse())
    )
    const wrong = 'ab'.repeat(32)
    expect(
      await fetchDeclaredArtwork('https://blossom.example/blob', wrong)
    ).toBeNull()
  })

  it('is null on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect(
      await fetchDeclaredArtwork('https://blossom.example/blob', ART_HASH)
    ).toBeNull()
  })
})

describe('declaredArtwork', () => {
  it('ignores missing or malformed artwork fields without fetching', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect(await declaredArtwork({})).toBeNull()
    expect(await declaredArtwork({artwork: ['url-only']})).toBeNull()
    expect(await declaredArtwork({artwork: 'nope'})).toBeNull()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('fetches when the field is a [url, hash] pair', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => artResponse('image/png'))
    )
    const result = await declaredArtwork({
      artwork: ['https://blossom.example/blob', ART_HASH]
    })
    expect(result).toMatch(/^data:image\/png;base64,/)
  })
})
