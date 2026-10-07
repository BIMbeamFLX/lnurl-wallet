import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {VERBS, type VerbContext} from '../verbs'
import {
  decodeCp1,
  encodeCr1WithAmount,
  encodeCs1WithAmount,
  outputKeyOfCw1
} from '../../lnurlcash'
import {
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  planSealLock,
  sealCertificateProblem,
  type SealCertificate,
  type SealState
} from './seals'

const BASE = 'https://mock-mint.test'
const URL_TEMPLATE = `${BASE}/w`
const AMOUNT_MSAT = 20_000_000

const keypair = () => {
  const secretKey = schnorr.utils.randomSecretKey()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}

const mintKeypair = () => {
  const priv = secp256k1.utils.randomSecretKey()
  return {priv, pub: bytesToHex(secp256k1.getPublicKey(priv, true))}
}

const signAsMint = (priv: Uint8Array, message: string): Uint8Array => {
  const digest = sha256(
    sha256(
      new Uint8Array([
        ...utf8ToBytes('Lightning Signed Message:'),
        ...utf8ToBytes(message)
      ])
    )
  )
  const sig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return new Uint8Array([...sig.subarray(1), sig[0]!])
}

type MockMint = {
  pub: string
  // hex Q -> msat, for every note that is still unspent
  live: Map<string, number>
  spent: Set<string>
  // what a rotate answers with, besides its cs1 - overridden per test
  rotation: (spent: string, note: string, amountMsat: number) => unknown
}

// A mint that holds notes by their output key, rotates one into another on
// a cw1 it does not check (signatures are the kernel's business, not this
// test's), and certifies each rotate the way lnurl-mint does.
const mockMint = (): MockMint => {
  const {priv, pub} = mintKeypair()
  const mint: MockMint = {
    pub,
    live: new Map(),
    spent: new Set(),
    rotation: (spent, note, amountMsat) =>
      encodeCr1WithAmount(
        amountMsat,
        signAsMint(priv, `LNURLcash:rotate:${amountMsat}:${spent}:${note}`)
      )
  }
  const keyOfCp1 = (cp1: string | null): string =>
    bytesToHex(decodeCp1(cp1 ?? '')!)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString())
      const body = (): Record<string, unknown> => {
        if (url.pathname === '/w') {
          const key = keyOfCp1(url.searchParams.get('p'))
          if (mint.spent.has(key)) {
            return {status: 'ERROR', reason: 'Note already spent.'}
          }
          const amountMsat = mint.live.get(key)
          if (amountMsat === undefined) {
            return {status: 'ERROR', reason: 'Unknown note.'}
          }
          return {
            tag: 'withdrawRequest',
            callback: `${BASE}/w/cb`,
            minWithdrawable: amountMsat,
            maxWithdrawable: amountMsat,
            defaultDescription: 'lnurlcash bearer note',
            mintPubkey: mint.pub
          }
        }
        const spentKey = outputKeyOfCw1(url.searchParams.get('k1') ?? '')!
        const noteKey = keyOfCp1(url.searchParams.get('p1'))
        const amountMsat = mint.live.get(spentKey)
        if (amountMsat === undefined) {
          return {status: 'ERROR', reason: 'Note already spent.'}
        }
        mint.live.delete(spentKey)
        mint.spent.add(spentKey)
        mint.live.set(noteKey, amountMsat)
        const r = mint.rotation(spentKey, noteKey, amountMsat)
        return {
          status: 'OK',
          c: encodeCs1WithAmount(
            amountMsat,
            signAsMint(priv, `LNURLcash:${amountMsat}:${noteKey}`)
          ),
          ...(r === undefined ? {} : {r})
        }
      }
      return {json: async () => body()} as Response
    })
  )
  return mint
}

const ctx = {} as VerbContext

type TransitionResult = {
  urlTemplate: string
  amountMsat: number
  state: SealState
  certificate: string | null
}

const transition = (
  state: SealState,
  ownerSecretKeyHex: string,
  nextOwnerPubkeyHex: string
) =>
  VERBS['seal.transition']!(
    {
      urlTemplate: URL_TEMPLATE,
      currentState: state,
      ownerSecretKeyHex,
      nextOwnerPubkeyHex,
      amountMsat: AMOUNT_MSAT
    },
    ctx
  ) as Promise<TransitionResult>

// a seal issued to `owners[0]` and handed on to each next owner in turn,
// with whatever certificates the mint really answered with
const issueAndTransfer = async (
  mint: MockMint,
  owners: ReturnType<typeof keypair>[]
) => {
  const states = [genesisState('Art #1', 'one of one', owners[0]!.pubkeyHex)]
  mint.live.set(planSealLock(states[0]!).outputKeyHex, AMOUNT_MSAT)
  const certificates: SealCertificate[] = []
  for (let i = 1; i < owners.length; i++) {
    const result = await transition(
      states[i - 1]!,
      owners[i - 1]!.secretKeyHex,
      owners[i]!.pubkeyHex
    )
    states.push(result.state)
    if (result.certificate) {
      certificates.push({stateIndex: i, cr1: result.certificate})
    }
  }
  return {
    states,
    certificates,
    consignment: encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      states,
      certificates
    )!
  }
}

afterEach(() => vi.unstubAllGlobals())

describe("VERBS['seal.transition']: the mint's certificate", () => {
  it('hands back the certificate the mint answered the rotate with', async () => {
    const mint = mockMint()
    const [alice, bob] = [keypair(), keypair()]
    const genesis = genesisState('Art #1', '', alice.pubkeyHex)
    mint.live.set(planSealLock(genesis).outputKeyHex, AMOUNT_MSAT)

    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(result.state.stateIndex).toBe(1)
    expect(result.state.ownerPubkeyHex).toBe(bob.pubkeyHex)
    expect(result.amountMsat).toBe(AMOUNT_MSAT)
    expect(result.certificate).toMatch(/^cr/)

    // the consignment built from it is certified, start to end
    const consignment = encodeSealConsignment(
      {urlTemplate: result.urlTemplate, amountMsat: result.amountMsat},
      [genesis, result.state],
      [{stateIndex: 1, cr1: result.certificate!}]
    )
    expect(sealCertificateProblem(consignment, mint.pub)).toBe('')
    // and the mint really moved the note
    expect(mint.live.has(planSealLock(result.state).outputKeyHex)).toBe(true)
    expect(mint.spent.has(planSealLock(genesis).outputKeyHex)).toBe(true)
  })

  it('still transitions at a mint that issues no certificates', async () => {
    const mint = mockMint()
    mint.rotation = () => undefined
    const [alice, bob] = [keypair(), keypair()]
    const genesis = genesisState('Art #1', '', alice.pubkeyHex)
    mint.live.set(planSealLock(genesis).outputKeyHex, AMOUNT_MSAT)

    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(result.certificate).toBeNull()
    expect(result.state.ownerPubkeyHex).toBe(bob.pubkeyHex)
    expect(mint.live.has(planSealLock(result.state).outputKeyHex)).toBe(true)
  })

  it('never hands on a certificate that is not this mint’s for this very step', async () => {
    const impostor = mintKeypair()
    const answers: MockMint['rotation'][] = [
      // signed by some other key
      (spent, note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAsMint(
            impostor.priv,
            `LNURLcash:rotate:${amountMsat}:${spent}:${note}`
          )
        ),
      // a note certificate's bytes dressed up as a rotation certificate
      (_spent, note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAsMint(impostor.priv, `LNURLcash:${amountMsat}:${note}`)
        ),
      // not a certificate at all
      () => 'nope'
    ]
    for (const rotation of answers) {
      const mint = mockMint()
      mint.rotation = rotation
      const [alice, bob] = [keypair(), keypair()]
      const genesis = genesisState('Art #1', '', alice.pubkeyHex)
      mint.live.set(planSealLock(genesis).outputKeyHex, AMOUNT_MSAT)
      const result = await transition(
        genesis,
        alice.secretKeyHex,
        bob.pubkeyHex
      )
      expect(result.certificate).toBeNull()
      vi.unstubAllGlobals()
    }
  })
})

type CheckResult = {
  consignment: string
  live: boolean
  reason?: string
  amountMsat?: number
  mintPubkey?: string
  mintPubkeyPinned?: boolean
  transitions?: number
  certified?: boolean
  certificateProblem?: string
}

const check = (consignment: unknown) =>
  VERBS['seal.check']!({consignment}, ctx) as Promise<CheckResult>

describe("VERBS['seal.check']", () => {
  it('reports a seal that is live and certified at every transition', async () => {
    const mint = mockMint()
    const {consignment} = await issueAndTransfer(mint, [
      keypair(),
      keypair(),
      keypair()
    ])
    expect(await check(`  ${consignment}\n`)).toEqual({
      consignment,
      live: true,
      amountMsat: AMOUNT_MSAT,
      mintPubkey: mint.pub,
      mintPubkeyPinned: false,
      transitions: 2,
      certified: true,
      certificateProblem: ''
    })
  })

  it('reports a never-transferred seal as live, with nothing to certify', async () => {
    const mint = mockMint()
    const {consignment} = await issueAndTransfer(mint, [keypair()])
    const result = await check(consignment)
    expect(result.live).toBe(true)
    expect(result.transitions).toBe(0)
    expect(result.certified).toBe(true)
  })

  it('reports which transition the mint did not certify', async () => {
    const mint = mockMint()
    mint.rotation = () => undefined
    const {consignment} = await issueAndTransfer(mint, [keypair(), keypair()])
    const result = await check(consignment)
    expect(result.live).toBe(true)
    expect(result.certified).toBe(false)
    expect(result.certificateProblem).toMatch(/State 1: the mint did not/)
  })

  it('a look-alike on a note of its own is live, but not certified', async () => {
    // someone who knows the history mints their own note onto a made-up
    // next state: the mint holds it, the chain checks out - and no
    // certificate says the real note ever became it
    const mint = mockMint()
    const owners = [keypair(), keypair()]
    const real = await issueAndTransfer(mint, owners)
    const forgedState: SealState = {
      ...real.states[1]!,
      ownerPubkeyHex: keypair().pubkeyHex
    }
    mint.live.set(planSealLock(forgedState).outputKeyHex, AMOUNT_MSAT)
    const forged = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      [real.states[0]!, forgedState],
      real.certificates
    )!
    const result = await check(forged)
    expect(result.live).toBe(true)
    expect(result.certified).toBe(false)
    expect(result.certificateProblem).toMatch(/State 1: its certificate is not/)
    // the real one, side by side
    expect((await check(real.consignment)).certified).toBe(true)
  })

  it('says so when the history is out of date: its last note is spent', async () => {
    const mint = mockMint()
    const owners = [keypair(), keypair(), keypair()]
    const {states, certificates} = await issueAndTransfer(mint, owners)
    const stale = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      states.slice(0, 2),
      certificates.slice(0, 1)
    )!
    const result = await check(stale)
    expect(result).toMatchObject({consignment: stale, live: false})
    expect(result.reason).toMatch(/already spent/)
  })

  it('says so when the mint knows no such note', async () => {
    mockMint()
    const consignment = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      [genesisState('Art #1', '', keypair().pubkeyHex)]
    )!
    const result = await check(consignment)
    expect(result.live).toBe(false)
    expect(result.reason).toMatch(/knows no note/)
  })

  it('says so when the note is worth something else than the consignment claims', async () => {
    const mint = mockMint()
    const {states} = await issueAndTransfer(mint, [keypair()])
    const inflated = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT * 2},
      states
    )!
    const result = await check(inflated)
    expect(result.live).toBe(false)
    expect(result.reason).toMatch(/20000000 msat/)
  })

  it('refuses anything that is not a self-consistent consignment, before asking the mint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(check('nope')).rejects.toThrow(/consignment/)
    const a = genesisState('Art #1', '', keypair().pubkeyHex)
    const broken = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      [a, {...a, stateIndex: 1}]
    )!
    expect(decodeSealConsignment(broken)).not.toBeNull()
    await expect(check(broken)).rejects.toThrow(/chain/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
