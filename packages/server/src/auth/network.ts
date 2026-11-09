/** Фильтр по подсетям (IPv4 и IPv6, включая IPv4-mapped адреса). */

export interface Cidr {
  version: 4 | 6;
  /** Адрес как BigInt. */
  base: bigint;
  mask: bigint;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip;
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  // Хвост в виде IPv4: ::ffff:10.0.0.1
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    const hi = (v4 >> 16n).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Приводит адрес к виду {version, value}. IPv4-mapped IPv6 превращается в IPv4. */
export function parseIp(ip: string): { version: 4 | 6; value: bigint } | null {
  if (ip.includes(':')) {
    const v6 = ipv6ToBigInt(ip);
    if (v6 === null) return null;
    if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
    return { version: 6, value: v6 };
  }
  const v4 = ipv4ToBigInt(ip);
  return v4 === null ? null : { version: 4, value: v4 };
}

export function parseCidr(cidr: string): Cidr | null {
  const [addr, bitsStr] = cidr.split('/');
  if (!addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const maxBits = ip.version === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? maxBits : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;
  const all = (1n << BigInt(maxBits)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(maxBits - bits)) & all;
  return { version: ip.version, base: ip.value & mask, mask };
}

const LOOPBACK = [parseCidr('127.0.0.0/8')!, parseCidr('::1/128')!];

export function createNetworkFilter(cidrs: string[]): (ip: string) => boolean {
  const nets = [...LOOPBACK, ...cidrs.map((c) => parseCidr(c)).filter((c): c is Cidr => c !== null)];
  return (ip: string) => {
    const parsed = parseIp(ip);
    if (!parsed) return false;
    return nets.some((n) => n.version === parsed.version && (parsed.value & n.mask) === n.base);
  };
}
