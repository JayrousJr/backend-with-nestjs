import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  totp,
  verifyTotp,
} from './totp';

describe('totp', () => {
  // RFC 6238 Appendix B test vector (SHA1, secret "12345678901234567890").
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 test vectors (last 6 digits)', () => {
    expect(totp(rfcSecret, 59_000)).toBe('287082');
    expect(totp(rfcSecret, 1_111_111_109_000)).toBe('081804');
    expect(totp(rfcSecret, 1_234_567_890_000)).toBe('005924');
    expect(totp(rfcSecret, 2_000_000_000_000)).toBe('279037');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('hello AzamTV');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('accepts one step of drift, not two', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(s, totp(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now + 30_000), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 90_000), now)).toBe(false);
    expect(verifyTotp(s, 'abcdef', now)).toBe(false);
  });

  it('encrypts secrets with authentication', () => {
    const key = 'k'.repeat(40);
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(stored, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(stored, 'x'.repeat(40))).toThrow();
  });
});
