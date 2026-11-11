import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptPassword(password: string, keyHex: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    nonce,
  );
  const encrypted = Buffer.concat([
    cipher.update(password, 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    nonce.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

export function decryptPassword(value: string, keyHex: string): string {
  const [version, nonce, tag, encrypted] = value.split(':');
  if (
    version !== 'v1' ||
    !nonce ||
    !tag ||
    encrypted === undefined ||
    nonce.length !== 24 ||
    tag.length !== 32
  )
    throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(nonce, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
