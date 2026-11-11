// Synthetic token for the offline transport; never sent to WebUntis.
export function tokenFixture(tenantId: unknown = '123'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ tenant_id: tenantId })).toString(
    'base64url',
  );
  return `${header}.${payload}.fixture`;
}
