import { describe, it, expect } from 'vitest';
import {
  MIND_BUNDLE_MAGIC,
  MIND_BUNDLE_PASSPHRASE_MIN_CHARS,
  openMindBundle,
  readMindBundleHeader,
  sealMindBundle,
} from './mindBundleCrypto.js';

// Obviously-fake fixture. Never a record read out of a live install.
const PASSPHRASE = 'correct horse battery staple';
const ENTRIES = [
  { name: 'profile.json', data: JSON.stringify({ chosenName: 'Example Mind', soul: { identity: 'I am an example.' } }) },
  { name: 'memories.json', data: JSON.stringify({ memories: [{ type: 'fact', content: 'The example user prefers mornings.' }] }) },
];

const seal = (overrides = {}) => sealMindBundle({
  entries: ENTRIES, scopes: ['profile', 'memories'], passphrase: PASSPHRASE, ...overrides,
});

describe('mindBundleCrypto', () => {
  it('round-trips entries through seal and open', async () => {
    const opened = await openMindBundle({ text: await seal(), passphrase: PASSPHRASE });
    expect(opened.header.scopes).toEqual(['profile', 'memories']);
    expect(opened.entries.map((entry) => entry.name)).toEqual(['profile.json', 'memories.json']);
    expect(JSON.parse(opened.entries[0].data.toString('utf8')).chosenName).toBe('Example Mind');
  });

  it('preserves arbitrary bytes, so a future image entry needs no second path', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const text = await sealMindBundle({ entries: [{ name: 'avatar.png', data }], scopes: ['avatar'], passphrase: PASSPHRASE });
    const opened = await openMindBundle({ text, passphrase: PASSPHRASE });
    expect(opened.entries[0].data.equals(data)).toBe(true);
  });

  it('refuses a wrong passphrase', async () => {
    const text = await seal();
    await expect(openMindBundle({ text, passphrase: 'a different passphrase' })).rejects.toThrow();
  });

  it('refuses a passphrase shorter than the floor, at seal and at open', async () => {
    await expect(seal({ passphrase: 'short' })).rejects.toThrow(/at least 12 characters/);
    const text = await seal();
    await expect(openMindBundle({ text, passphrase: 'short' })).rejects.toThrow(/at least 12 characters/);
    expect(MIND_BUNDLE_PASSPHRASE_MIN_CHARS).toBe(12);
  });

  it('fails GCM authentication when a single ciphertext byte is mutated', async () => {
    const lines = (await seal()).split('\n');
    const ciphertext = Buffer.from(lines[2], 'base64');
    ciphertext[0] ^= 0x01;
    lines[2] = ciphertext.toString('base64');
    await expect(openMindBundle({ text: lines.join('\n'), passphrase: PASSPHRASE })).rejects.toThrow();
  });

  it('fails authentication when the CLEARTEXT header is edited', async () => {
    // The header is the AAD, so lying about the declared scopes is detected
    // rather than silently believed.
    const lines = (await seal()).split('\n');
    const header = JSON.parse(lines[1]);
    header.scopes = ['profile'];
    lines[1] = JSON.stringify(header);
    await expect(openMindBundle({ text: lines.join('\n'), passphrase: PASSPHRASE })).rejects.toThrow();
  });

  it('exposes versions, KDF params, scopes and entry names WITHOUT a passphrase', async () => {
    const { header } = readMindBundleHeader(await seal());
    expect(header.magic).toBe(MIND_BUNDLE_MAGIC);
    expect(header.containerVersion).toBe(1);
    expect(header.kdf.name).toBe('scrypt');
    expect(header.kdf.saltB64).toEqual(expect.any(String));
    expect(header.manifest.map((entry) => entry.name)).toEqual(['profile.json', 'memories.json']);
  });

  it('never puts a plaintext entry digest in the cleartext header', async () => {
    // A SHA-256 over profile.json would be a confirmation oracle over a small
    // guess space (a chosen name, a provider id) for anyone holding the file.
    const text = await seal();
    const { header } = readMindBundleHeader(text);
    expect(JSON.stringify(header)).not.toMatch(/sha256/i);
    const opened = await openMindBundle({ text, passphrase: PASSPHRASE });
    // …but the digests DO exist inside, as the post-open integrity check.
    const tampered = text.split('\n');
    expect(opened.entries).toHaveLength(2);
    expect(tampered[1]).not.toMatch(/[0-9a-f]{64}/);
  });

  it('refuses an unknown container version by name, before asking for a passphrase', async () => {
    const lines = (await seal()).split('\n');
    lines[0] = `${MIND_BUNDLE_MAGIC}/99`;
    expect(() => readMindBundleHeader(lines.join('\n'))).toThrow(/container version 99 is not supported/);
  });

  it('refuses an unknown payload version rather than applying what it recognizes', async () => {
    const lines = (await seal()).split('\n');
    const header = JSON.parse(lines[1]);
    header.payloadVersion = 99;
    lines[1] = JSON.stringify(header);
    expect(() => readMindBundleHeader(lines.join('\n'))).toThrow(/payload version 99 is not supported/);
  });

  it('refuses a scope vocabulary this install does not understand', async () => {
    const lines = (await seal()).split('\n');
    const header = JSON.parse(lines[1]);
    header.scopes = ['profile', 'brain-dump'];
    lines[1] = JSON.stringify(header);
    expect(() => readMindBundleHeader(lines.join('\n'))).toThrow(/scope this install does not understand/);
  });

  it('refuses a file that is not a Mind bundle, and a truncated one', () => {
    expect(() => readMindBundleHeader('{"hello":"world"}')).toThrow(/not a PortOS Mind bundle/);
    expect(() => readMindBundleHeader('')).toThrow(/empty/);
    expect(() => readMindBundleHeader(`${MIND_BUNDLE_MAGIC}/1\n{}\n`)).toThrow(/truncated or damaged/);
  });

  it('refuses key-derivation parameters it will not run', async () => {
    const lines = (await seal()).split('\n');
    const header = JSON.parse(lines[1]);
    header.kdf = { ...header.kdf, N: 1_073_741_824 };
    lines[1] = JSON.stringify(header);
    await expect(openMindBundle({ text: lines.join('\n'), passphrase: PASSPHRASE }))
      .rejects.toThrow(/key-derivation parameters this install will not run/);
  });

  it('uses a fresh salt and IV per bundle, so two seals of one Mind never match', async () => {
    const [a, b] = await Promise.all([seal(), seal()]);
    const headerA = JSON.parse(a.split('\n')[1]);
    const headerB = JSON.parse(b.split('\n')[1]);
    expect(headerA.kdf.saltB64).not.toBe(headerB.kdf.saltB64);
    expect(headerA.cipher.ivB64).not.toBe(headerB.cipher.ivB64);
    expect(a.split('\n')[2]).not.toBe(b.split('\n')[2]);
  });

  it('refuses duplicate entry names and an empty bundle', async () => {
    await expect(sealMindBundle({ entries: [], scopes: ['profile'], passphrase: PASSPHRASE })).rejects.toThrow(/at least one entry/);
    await expect(sealMindBundle({
      entries: [{ name: 'profile.json', data: '{}' }, { name: 'profile.json', data: '{}' }],
      scopes: ['profile'], passphrase: PASSPHRASE,
    })).rejects.toThrow(/unique/);
  });
});
