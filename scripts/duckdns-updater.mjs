import { setTimeout as delay } from 'node:timers/promises';

const domain = process.env.DUCKDNS_DOMAIN;
const token = process.env.DUCKDNS_TOKEN;
const intervalSeconds = Number(process.env.DUCKDNS_INTERVAL_SECONDS);
if (!domain || !/^[a-z0-9-]+$/.test(domain) || !token ||
    !Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
  throw new Error('DuckDNS updater configuration is invalid');
}

const endpoint = new URL('https://www.duckdns.org/update');
endpoint.searchParams.set('domains', domain);
endpoint.searchParams.set('token', token);

const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok || (await response.text()).trim() !== 'OK') {
      throw new Error('DuckDNS rejected the update');
    }
    console.log('DuckDNS IPv4 update accepted');
  } catch {
    console.error('DuckDNS IPv4 update failed');
  }
  try {
    await delay(intervalSeconds * 1000, undefined, { signal: stop.signal });
  } catch {
    break;
  }
}
