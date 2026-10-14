import { isIP } from 'node:net';

// Treat an IPv6 /64 as one source; rotating interface addresses must not bypass limits.
export function oauthSourceBucket(value) {
  if (typeof value !== 'string' || value.length > 128) return 'unidentified';
  let address = value.toLowerCase().split('%')[0];
  if (isIP(address) === 4) return `ipv4:${address}`;
  if (isIP(address) !== 6) return 'unidentified';
  if (address.includes('.')) {
    const split = address.lastIndexOf(':'), octets = address.slice(split + 1).split('.').map(Number);
    address = address.slice(0, split + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = address.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const words = (halves.length === 2 ? [...left, ...Array(8-left.length-right.length).fill('0'), ...right] : left).map(part=>parseInt(part,16));
  if (words.slice(0,5).every(word=>word===0) && words[5]===0xffff) return `ipv4:${[words[6]>>8,words[6]&255,words[7]>>8,words[7]&255].join('.')}`;
  return `ipv6:${words.slice(0,4).map(word=>word.toString(16)).join(':')}/64`;
}
