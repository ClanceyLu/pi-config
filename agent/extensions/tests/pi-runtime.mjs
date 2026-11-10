import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = process.env.PI_MANAGED_INSTALL_ROOT
	? pathToFileURL(`${resolve(process.env.PI_MANAGED_INSTALL_ROOT)}/`)
	: new URL("../../install/", import.meta.url);
const current = new URL("current-version", install);
if (existsSync(current)) {
	const version = readFileSync(current, "utf8").trim();
	if (!/^[\w.+-]+$/.test(version) || version === "." || version === "..") {
		throw new Error(`Invalid managed Pi version in ${current.pathname}`);
	}
	const parentURL = new URL(`releases/${version}/package.json`, install).href;
	// Use the active release for SDK dependencies, including imports inside extension modules.
	registerHooks({ resolve(specifier, context, next) {
		const piDependency = specifier.startsWith("@earendil-works/") || specifier === "typebox";
		return next(specifier, piDependency ? { ...context, parentURL } : context);
	} });
}
