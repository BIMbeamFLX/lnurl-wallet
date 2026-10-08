import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {decodeCw1, outputKeyOfCw1} from '../../lib/recoverableNotes'
import {
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  nextState,
  planSealLock,
  redeemCurrentStateCw1,
  sealSpendCw1,
  sealSpendProblem,
  signCurrentState,
  type SealSpend,
  type SealState
} from './seals'

// A consignment's spends: the signature each previous owner spent with,
// which is all it takes to put a transition to the mint again.

const MINT = 'https://mint.example.com/w'
const AMOUNT_MSAT = 20_000_000
const LOCKED = {urlTemplate: MINT, amountMsat: AMOUNT_MSAT}

const keypair = () => {
  const secretKey = schnorr.utils.randomSecretKey()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}

// a seal handed from owner to owner, each signing its own note away at
// `mint` - what verbs.ts's seal.transition leaves behind, minus the mint
const history = (transfers: number, mint = MINT) => {
  const owners = Array.from({length: transfers + 1}, keypair)
  const states = [genesisState('Art #1', 'one of one', owners[0]!.pubkeyHex)]
  const spends: SealSpend[] = []
  for (let i = 1; i <= transfers; i++) {
    spends.push({
      stateIndex: i,
      signatureHex: signCurrentState(
        states[i - 1]!,
        owners[i - 1]!.secretKeyHex,
        mint
      )
    })
    states.push(nextState(states[i - 1]!, owners[i]!.pubkeyHex))
  }
  return {owners, states, spends}
}

// a consignment's length-prefixed parts, and the same parts put back
// together in another order - for layouts the encoder never writes
const partsOf = (consignment: string) => {
  const bytes = bech32m.fromWords(
    bech32m.decode(consignment as `${string}1${string}`, false).words
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8 + 2 + view.getUint16(8, false)
  const header = bytes.slice(0, offset)
  const parts: Uint8Array[] = []
  while (offset < bytes.length) {
    const length = view.getUint16(offset, false)
    parts.push(bytes.slice(offset + 2, offset + 2 + length))
    offset += 2 + length
  }
  return {header, parts}
}

const withParts = (header: Uint8Array, parts: Uint8Array[]): string => {
  const chunks = [header]
  for (const part of parts) {
    chunks.push(Uint8Array.of(part.length >> 8, part.length & 0xff), part)
  }
  const payload = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    payload.set(chunk, offset)
    offset += chunk.length
  }
  return bech32m.encode('seal', bech32m.toWords(payload), false)
}

describe('a seal spend', () => {
  it('is rebuilt from the state and its owner’s signature alone', () => {
    const {owners, states} = history(0)
    const state = states[0]!
    const signatureHex = signCurrentState(state, owners[0]!.secretKeyHex, MINT)
    expect(signatureHex).toMatch(/^[0-9a-f]{128}$/)

    const cw1 = sealSpendCw1(state, signatureHex)
    expect(outputKeyOfCw1(cw1)).toBe(planSealLock(state).outputKeyHex)
    // the very cw1 the owner's own redemption builds, signature aside
    const rebuilt = decodeCw1(cw1)!
    const own = decodeCw1(
      redeemCurrentStateCw1(state, owners[0]!.secretKeyHex, MINT)
    )!
    expect(bytesToHex(rebuilt.witness[0]!)).toBe(signatureHex)
    expect({...rebuilt, witness: rebuilt.witness.slice(1)}).toEqual({
      ...own,
      witness: own.witness.slice(1)
    })
  })

  it('takes nothing but a 64-byte signature', () => {
    const {states} = history(0)
    expect(() => sealSpendCw1(states[0]!, 'ab'.repeat(63))).toThrow(
      /64-byte signature/
    )
    expect(() => sealSpendCw1(states[0]!, undefined)).toThrow(
      /64-byte signature/
    )
  })

  it('is only ever signed by the state’s own owner', () => {
    const {states} = history(0)
    expect(() =>
      signCurrentState(states[0]!, keypair().secretKeyHex, MINT)
    ).toThrow(/does not match/)
  })
})

describe('seal consignment: spends', () => {
  it('is byte for byte what it was without any', () => {
    const {states} = history(2)
    const plain = encodeSealConsignment(LOCKED, states)
    expect(encodeSealConsignment(LOCKED, states, [], [])).toBe(plain)
    expect(decodeSealConsignment(plain)!.spends).toEqual([])
  })

  it('round-trips one spend per transition, after every state', () => {
    const {states, spends} = history(3)
    const consignment = encodeSealConsignment(LOCKED, states, [], spends)!
    const parsed = decodeSealConsignment(consignment)!
    expect(parsed.states).toEqual(states)
    expect(parsed.certificates).toEqual([])
    expect(parsed.spends).toEqual(spends)
    // 4 states, then 3 spends of tag + index + signature each
    const {parts} = partsOf(consignment)
    expect(parts).toHaveLength(7)
    for (const part of parts.slice(4)) {
      expect(part).toHaveLength(23 + 4 + 64)
      expect(new TextDecoder().decode(part.slice(0, 23))).toBe(
        'LNURLcash/seal/spend/v0'
      )
    }
  })

  it('carries them in whatever order they were handed in', () => {
    const {states, spends} = history(3)
    const reversed = [...spends].reverse()
    expect(
      decodeSealConsignment(
        encodeSealConsignment(LOCKED, states, [], reversed)
      )!.spends
    ).toEqual(reversed)
  })

  it('is not encoded around a spend this history has no place for', () => {
    const {states, spends} = history(2)
    const encode = (bad: unknown[]) =>
      encodeSealConsignment(LOCKED, states, [], bad)
    // for the genesis, past the last state, twice for one transition,
    expect(encode([{...spends[0]!, stateIndex: 0}])).toBeNull()
    expect(encode([{...spends[0]!, stateIndex: 3}])).toBeNull()
    expect(encode([spends[0]!, spends[0]!])).toBeNull()
    // or one that is no signature
    expect(encode([{stateIndex: 1, signatureHex: 'ab'.repeat(63)}])).toBeNull()
    expect(encode([{stateIndex: 1, signatureHex: 'zz'.repeat(64)}])).toBeNull()
  })

  it('is not decoded from a layout the encoder never writes', () => {
    const {states, spends} = history(2)
    const {header, parts} = partsOf(
      encodeSealConsignment(LOCKED, states, [], spends)!
    )
    const [genesis, first, second, spendOne, spendTwo] = parts as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array
    ]
    // as written, it reads back
    expect(decodeSealConsignment(withParts(header, parts))).not.toBeNull()
    // a state after a spend,
    expect(
      decodeSealConsignment(
        withParts(header, [genesis, first, spendOne, second, spendTwo])
      )
    ).toBeNull()
    // the same transition's spend twice,
    expect(
      decodeSealConsignment(
        withParts(header, [genesis, first, second, spendOne, spendOne])
      )
    ).toBeNull()
    // or a spend for a transition past the last state
    expect(
      decodeSealConsignment(withParts(header, [genesis, first, spendTwo]))
    ).toBeNull()
  })
})

describe('sealSpendProblem', () => {
  const consignmentOf = (
    states: SealState[],
    spends: SealSpend[],
    urlTemplate = MINT
  ) =>
    encodeSealConsignment(
      {urlTemplate, amountMsat: AMOUNT_MSAT},
      states,
      [],
      spends
    )!

  it('passes a history every owner signed away at this mint', () => {
    const {states, spends} = history(3)
    expect(sealSpendProblem(consignmentOf(states, spends))).toBe('')
    // decoded or not
    expect(
      sealSpendProblem(decodeSealConsignment(consignmentOf(states, spends)))
    ).toBe('')
    // and a seal that never moved has nothing to carry
    expect(sealSpendProblem(consignmentOf(history(0).states, []))).toBe('')
  })

  it('names the first transition without its owner’s signature', () => {
    const {states, spends} = history(3)
    expect(
      sealSpendProblem(consignmentOf(states, [spends[0]!, spends[2]!]))
    ).toMatch(/^State 2: the consignment carries no signature/)
    expect(sealSpendProblem(consignmentOf(states, []))).toMatch(/^State 1: /)
  })

  it('refuses a signature that is not the previous owner’s for that note', () => {
    const {states, spends} = history(2)
    // each a real signature - of the other step's owner, over the other note
    const swapped = [
      {stateIndex: 1, signatureHex: spends[1]!.signatureHex},
      {stateIndex: 2, signatureHex: spends[0]!.signatureHex}
    ]
    expect(sealSpendProblem(consignmentOf(states, swapped))).toMatch(
      /^State 1: that is not the signature its previous owner spent with/
    )
    // or no signature at all
    const junk = [spends[0]!, {stateIndex: 2, signatureHex: '00'.repeat(64)}]
    expect(sealSpendProblem(consignmentOf(states, junk))).toMatch(/^State 2: /)
  })

  it('refuses a history that names another mint than its owners signed for', () => {
    // a spend is bound to its mint's domain: re-pointed at another host, not
    // one of these signatures is worth sending there
    const {states, spends} = history(2)
    expect(
      sealSpendProblem(consignmentOf(states, spends, 'https://other.example/w'))
    ).toMatch(/^State 1: that is not the signature .* at this mint/)
    // the domain is the bare host: another path or port is the same mint
    expect(
      sealSpendProblem(
        consignmentOf(states, spends, 'https://mint.example.com:8443/else')
      )
    ).toBe('')
  })

  it('fits a look-alike just as well - only the mint tells the two apart', () => {
    // A spend commits to no destination, so the real owner's real signature
    // sits just as well under a made-up next state. That is why this check
    // is a precondition for asking the mint and never an answer by itself.
    const {states, spends} = history(1)
    const lookAlike: SealState = {
      ...states[1]!,
      ownerPubkeyHex: keypair().pubkeyHex
    }
    expect(
      sealSpendProblem(consignmentOf([states[0]!, lookAlike], spends))
    ).toBe('')
  })

  it('is the chain’s own problem first, and says so for anything else', () => {
    const {states, spends} = history(1)
    const broken = [states[0]!, {...states[1]!, stateIndex: 5}]
    expect(sealSpendProblem(consignmentOf(broken, spends))).toMatch(
      /state index must increase/
    )
    expect(sealSpendProblem('nope')).toMatch(/valid seal consignment/)
  })
})
