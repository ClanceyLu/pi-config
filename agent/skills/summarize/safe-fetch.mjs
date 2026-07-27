import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
	["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96]]) {
	blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function assertPublicAddress(address, family) {
	const type = family === 6 ? "ipv6" : "ipv4";
	if (blockedAddresses.check(address, type)) throw new Error(`Refusing non-public destination address: ${address}`);
}

function safeLookup(hostname, options, callback) {
	dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
		if (error) return callback(error);
		try {
			if (addresses.length === 0) throw new Error(`No addresses resolved for ${hostname}`);
			for (const entry of addresses) assertPublicAddress(entry.address, entry.family);
			const requestedFamily = typeof options === "object" ? options.family : 0;
			const candidates = requestedFamily ? addresses.filter((entry) => entry.family === requestedFamily) : addresses;
			if (candidates.length === 0) throw new Error(`No matching public address resolved for ${hostname}`);
			if (typeof options === "object" && options.all) callback(null, candidates);
			else callback(null, candidates[0].address, candidates[0].family);
		} catch (validationError) {
			callback(validationError);
		}
	});
}

function requestOnce(url, { timeoutMs, maxBytes }) {
	return new Promise((resolve, reject) => {
		const literalHost = url.hostname.replace(/^\[|\]$/g, "");
		const literalFamily = isIP(literalHost);
		if (literalFamily) {
			try {
				assertPublicAddress(literalHost, literalFamily);
			} catch (error) {
				return reject(error);
			}
		}
		const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : undefined;
		if (!transport) return reject(new Error(`Unsupported URL protocol: ${url.protocol}`));
		const request = transport.request(url, {
			method: "GET",
			lookup: safeLookup,
			headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": "pi-summarize-skill/1" },
		}, (response) => {
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					request.destroy(new Error(`Downloaded document exceeds ${maxBytes} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => {
				clearTimeout(deadlineTimer);
				resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
			});
		});
		const deadlineTimer = setTimeout(
			() => request.destroy(new Error(`Document download timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		request.on("error", (error) => {
			clearTimeout(deadlineTimer);
			reject(error);
		});
		request.end();
	});
}

export async function fetchPublicDocument(input, options = {}) {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
	const maxRedirects = options.maxRedirects ?? 5;
	let current = new URL(input);
	const deadline = Date.now() + timeoutMs;
	for (let redirect = 0; redirect <= maxRedirects; redirect++) {
		if (!current.username && !current.password) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw new Error(`Document download timed out after ${timeoutMs}ms`);
			const response = await requestOnce(current, { timeoutMs: remainingMs, maxBytes });
			if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
				const location = response.headers.location;
				if (!location) throw new Error(`Redirect from ${current} omitted Location`);
				current = new URL(location, current);
				continue;
			}
			if (response.statusCode < 200 || response.statusCode >= 300) {
				throw new Error(`Document request failed (${response.statusCode}) for ${current}`);
			}
			return { body: response.body, finalUrl: current, contentType: response.headers["content-type"] };
		}
		throw new Error("Credentials in document URLs are not allowed");
	}
	throw new Error(`Document URL exceeded ${maxRedirects} redirects`);
}
