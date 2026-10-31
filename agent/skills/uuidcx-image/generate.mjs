#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const help = `Usage:
  node generate.mjs --prompt "<description>" [--output <file>]
  node generate.mjs --list-models

Options:
  --model <id>          Default: gpt-image-2
  --size <value>        Optional provider-supported size, e.g. 1024x1024
  --quality <value>     Optional provider-supported quality
  --output <file>       Default: ./uuidcx-image-<timestamp>.<format>
  --timeout <seconds>   Default: 300
  --list-models         List available image models without generating
  --help               Show help

Requires UUIDCX_API_KEY. Uses https://uuidcx.com/v1.
`;

async function main() {
  const { values } = parseArgs({ options: {
    prompt: { type: 'string' }, model: { type: 'string', default: 'gpt-image-2' },
    size: { type: 'string' }, quality: { type: 'string' }, output: { type: 'string' },
    timeout: { type: 'string', default: '300' },
    'list-models': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  if (!values['list-models'] && !values.prompt?.trim()) throw new Error('--prompt is required. Use --help for usage.');
  const seconds = Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error('--timeout must be between 0 and 3600 seconds.');
  const key = process.env.UUIDCX_API_KEY;
  if (!key) throw new Error('Set UUIDCX_API_KEY in the environment before running.');
  const signal = AbortSignal.timeout(seconds * 1000);
  const payload = { model: values.model, prompt: values.prompt, n: 1 };
  for (const name of ['size', 'quality']) if (values[name]) payload[name] = values[name];
  const listing = values['list-models'];
  const response = await fetch(`https://uuidcx.com/v1/${listing ? 'models' : 'images/generations'}`, {
    method: listing ? 'GET' : 'POST', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'uuidcx-image-skill/1.0' },
    ...(listing ? {} : { body: JSON.stringify(payload) }),
  });
  if (!response.ok) {
    // Do not echo arbitrary gateway bodies, which may contain credentials or huge HTML pages.
    throw new Error(`UUIDCX returned HTTP ${response.status}. Check model availability, account access and request options.`);
  }
  const result = await response.json();
  if (listing) {
    const models = (result.data ?? []).map(item => item.id).filter(id => typeof id === 'string' && /image|dall-e/i.test(id));
    console.log(JSON.stringify({ models }, null, 2));
    return;
  }
  const item = result.data?.[0];
  if (!item) throw new Error('No image returned in data[0].');
  let bytes;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const url = new URL(item.url);
    if (url.protocol !== 'https:') throw new Error('Image download URL must use HTTPS.');
    // Returned CDN URLs do not receive the gateway API key.
    const download = await fetch(url, { signal });
    if (!download.ok) throw new Error(`Image download returned HTTP ${download.status}.`);
    bytes = Buffer.from(await download.arrayBuffer());
  } else {
    throw new Error('Image response contains neither b64_json nor url.');
  }
  const format = imageFormat(bytes);
  if (!format) throw new Error('Returned content is not a supported PNG, JPEG, WebP or GIF image.');
  const output = resolve(values.output ?? `uuidcx-image-${Date.now()}.${format}`);
  const extension = extname(output).toLowerCase();
  const expected = format === 'jpg' ? ['.jpg', '.jpeg'] : [`.${format}`];
  if (!expected.includes(extension)) throw new Error(`Returned image is ${format}; choose an output path ending in ${expected.join(' or ')} (or omit --output).`);
  await mkdir(dirname(output), { recursive: true });
  // Never overwrite an existing user file.
  await writeFile(output, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ path: output, model: values.model, format, bytes: bytes.length }, null, 2));
}

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  return null;
}

main().catch(error => {
  const message = error.name === 'TimeoutError' ? 'Request timed out; generation may still have been processed. Check before retrying.' : error.message;
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
