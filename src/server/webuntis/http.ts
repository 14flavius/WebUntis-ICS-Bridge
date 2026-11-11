import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, Dispatcher1Wrapper } from 'undici';
import { AppError } from '../errors.js';

const privateNetworks = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateNetworks.addSubnet(ip, prefix);

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !privateNetworks.check(address);
  // Only global IPv6 unicast; reject mapped IPv4, local/link-local and documentation.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(db8|0):/i.test(address) &&
    !/^2002:/i.test(address)
  );
}

export function serverOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    throw new AppError('INVALID_SERVER');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['/', '/WebUntis', '/WebUntis/'].includes(url.pathname) ||
    !/^[a-z0-9-]+\.webuntis\.com$/i.test(url.hostname)
  )
    throw new AppError('INVALID_SERVER');
  return url.origin;
}

export function secureTransport() {
  // Validate the addresses in the actual socket lookup, preventing DNS rebinding.
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error, [], 4);
          if (
            !addresses.length ||
            addresses.some((entry) => !isPublicAddress(entry.address))
          )
            return callback(new Error('Blocked network target'), [], 4);
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    },
  });
  // Node 24's native fetch uses the v1 dispatcher contract; Undici 8 uses v2.
  // The official adapter preserves our guarded DNS lookup and per-client pool.
  const compatibleDispatcher = new Dispatcher1Wrapper(dispatcher);
  return {
    fetch: (url: string | URL, init?: RequestInit) => {
      const options: RequestInit & { dispatcher: Dispatcher1Wrapper } = {
        ...init,
        dispatcher: compatibleDispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      };
      return fetch(url, options);
    },
    close: () => dispatcher.close(),
  };
}
export type Transport = ReturnType<typeof secureTransport>;

export async function responseText(response: Response): Promise<string> {
  if (!response.body) throw new AppError('WEBUNTIS_INVALID', 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new AppError('WEBUNTIS_TOO_LARGE', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
