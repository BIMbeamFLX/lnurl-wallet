import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'

// Note images - a display-layer nicety, deliberately outside the protocol.
// An image is never part of the note URL, never sent anywhere, and does not
// travel with a handover; it lives only inside this wallet's encrypted
// bearer records (so backups carry it automatically). Two sources:
//   - the mint: a LUD-06 payRequest metadata image entry, adopted at mint
//     time (see payRequestImage)
//   - the holder: a local file attached by hand, downscaled in the browser
//     before storing (see fileToNoteImage)

// the two image entries LUD-06 defines - nothing else is ever rendered
const METADATA_IMAGE_TYPES: Record<string, string> = {
  'image/png;base64': 'image/png',
  'image/jpeg;base64': 'image/jpeg'
}

// localStorage is finite (~5 MB) and every byte here is stored again inside
// an encrypted record - cap what a mint can push into the wallet
const MAX_METADATA_IMAGE_B64 = 262_144 // 256 KiB of base64

const isBase64 = (value: string): boolean =>
  /^[A-Za-z0-9+/]+={0,2}$/.test(value)

// LUD-06 metadata is a JSON-encoded array of [type, content] pairs - return
// the first well-formed image entry as a data: URL, or null when there is
// none. A malformed or oversized entry is skipped, never fatal: minting
// works exactly as before, just without artwork.
export const payRequestImage = (metadata: string): string | null => {
  try {
    const entries = JSON.parse(metadata)
    if (!Array.isArray(entries)) return null
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const mime = METADATA_IMAGE_TYPES[entry[0]]
      if (!mime || typeof entry[1] !== 'string') continue
      const content = entry[1].trim()
      if (!content || content.length > MAX_METADATA_IMAGE_B64) continue
      if (!isBase64(content)) continue
      return `data:${mime};base64,${content}`
    }
    return null
  } catch {
    return null
  }
}

// ---- mint-declared artwork (NORD-02) ----

// a SERVICE may declare a note's artwork as [url, sha256] in its
// withdrawRequest. The hash is the authority and the URL only transport:
// bytes fetched from anywhere - the mint, a Blossom mirror, a .fips
// host - verify locally against the declared hash before they render.
const ARTWORK_MAX_BYTES = 1_048_576 // a card face, not a photo album

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  // chunked: String.fromCharCode(...whole) overflows the call stack
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// fetch + verify + encode as a data URL. Null on any failure, mismatch
// or oversize - a note without artwork is a note, never an error.
export const fetchDeclaredArtwork = async (
  url: string,
  sha256Hex: string
): Promise<string | null> => {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!bytes.length || bytes.length > ARTWORK_MAX_BYTES) return null
    if (bytesToHex(sha256(bytes)) !== sha256Hex.trim().toLowerCase()) {
      return null
    }
    // content-type is cosmetic (browsers sniff image bytes in <img>);
    // the hash check above is the real gate
    const declared = res.headers.get('content-type')?.split(';')[0] ?? ''
    const mime = declared.startsWith('image/') ? declared : 'image/png'
    return `data:${mime};base64,${bytesToBase64(bytes)}`
  } catch {
    return null
  }
}

// the withdrawRequest's optional artwork field, shape-checked - see
// WithdrawRequestInfo in lnurlcash.ts
export const declaredArtwork = (info: {
  artwork?: unknown
}): Promise<string | null> => {
  const pair = info.artwork
  if (
    !Array.isArray(pair) ||
    typeof pair[0] !== 'string' ||
    typeof pair[1] !== 'string'
  ) {
    return Promise.resolve(null)
  }
  return fetchDeclaredArtwork(pair[0], pair[1])
}

// attached files are downscaled to render size and re-encoded - notes are
// small cards, not a photo album, and the result has a predictable footprint
const ATTACH_MAX_EDGE = 512
const ATTACH_JPEG_QUALITY = 0.85

export const fileToNoteImage = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const scale = Math.min(
        1,
        ATTACH_MAX_EDGE / Math.max(img.width, img.height)
      )
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas is not available in this browser.'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', ATTACH_JPEG_QUALITY))
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Could not read that file as an image.'))
    }
    img.src = objectUrl
  })
