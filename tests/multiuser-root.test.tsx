import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountStateProvider } from "../components/account-state.tsx";
import { AccountSection } from "../components/settings/account-section.tsx";

it("Account settings exposes only controller-derived public role/lifecycle/recovery and no delete action", () => {
	const html = renderToStaticMarkup(<AccountStateProvider account={{ role: "admin", lifecycle: "active", recoveringUntil: "2030-01-01T00:00:00Z" }}><AccountSection /></AccountStateProvider>);
	assert.match(html, /Administrator/);
	assert.match(html, /active/);
	assert.match(html, /2030-01-01T00:00:00Z/);
	assert.doesNotMatch(html, /delete|accountId|sessionToken|clerkUserId|privateMetadata|unsafeMetadata/i);
	assert.equal(renderToStaticMarkup(<AccountSection />), "");
});

it("all gate surfaces are reached, while public and error shells have no ambient providers", () => {
	for (const file of ["components/multiuser-root.tsx", "app/layout.tsx", "app/_account/server.tsx"]) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		assert.match(source, /MultiuserRoot|MultiuserRequestRoot/);
	}
	const root = readFileSync(new URL("../components/multiuser-root.tsx", import.meta.url), "utf8");
	assert.match(root, /publicRoute \? children/);
	assert.match(root, /bootstrap-required/);
	assert.match(root, /registration-required/);
	assert.match(root, /AccountUnavailable/);
	const settings = readFileSync(new URL("../components/settings/settings-dialog.tsx", import.meta.url), "utf8");
	assert.match(settings, /account \? \[/);
	assert.match(settings, /<AccountSection/);
	assert.doesNotMatch(readFileSync(new URL("../src/server/theme-boot-request.ts", import.meta.url), "utf8"), /themeStore|readSettings/);
	assert.doesNotMatch(readFileSync(new URL("../src/core/web-account-access.ts", import.meta.url), "utf8"), /sessionToken|clerkUserId|accountId/);
});
