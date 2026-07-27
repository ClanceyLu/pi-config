import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicDocument } from "./safe-fetch.mjs";

for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
	test(`blocks non-public URL ${url}`, async () => {
		await assert.rejects(fetchPublicDocument(url, { timeoutMs: 100 }), /Refusing non-public destination address/);
	});
}

test("rejects credentials embedded in URLs", async () => {
	await assert.rejects(fetchPublicDocument("https://user:pass@example.com/"), /Credentials in document URLs are not allowed/);
});
