"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiuserUserButton } from "@/components/multiuser-clerk";

export function FirstAdminSetup() {
	const [secret, setSecret] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return <section className="w-full max-w-md rounded-lg border border-border bg-card p-6">
		<div className="flex items-start justify-between gap-4"><h1 className="font-title text-2xl">Set up the host administrator</h1><MultiuserUserButton /></div>
		<p className="mt-3 text-sm text-muted-foreground">The host secret is sent only to the account controller. It is not stored in this browser or compared by the web application.</p>
		<form className="mt-5 flex flex-col gap-3" onSubmit={async event => {
			event.preventDefault(); setBusy(true); setError("");
			try {
				const response = await fetch("/api/account/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostSecret: secret }) });
				if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status})`);
				setSecret(""); window.location.assign("/");
			} catch (reason) { setError(reason instanceof Error ? reason.message : "Setup is unavailable."); }
			finally { setBusy(false); }
		}}>
			<Input type="password" name="hostSecret" autoComplete="off" aria-label="Host bootstrap secret" value={secret} onChange={event => setSecret(event.target.value)} />
			{error && <p role="alert" className="text-sm text-error">{error}</p>}
			<Button type="submit" disabled={busy || !secret}>Set up administrator</Button>
		</form>
	</section>;
}

export function FinishRegistration() {
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return <section className="w-full max-w-md rounded-lg border border-border bg-card p-6">
		<div className="flex items-start justify-between gap-4"><h1 className="font-title text-2xl">Finish registration</h1><MultiuserUserButton /></div>
		<p className="mt-3 text-sm text-muted-foreground">Your sign-in is complete. Register a LearnHarness account for this identity.</p>
		{error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
		<Button className="mt-5" disabled={busy} onClick={async () => {
			setBusy(true); setError("");
			try {
				const response = await fetch("/api/account/register", { method: "POST" });
				if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status})`);
				window.location.assign("/");
			} catch (reason) { setError(reason instanceof Error ? reason.message : "Registration is unavailable."); }
			finally { setBusy(false); }
		}}>Register</Button>
	</section>;
}

export function AccountUnavailable({ lifecycle, recoveringUntil }: { lifecycle: string; recoveringUntil: string | null }) {
	return <main className="flex min-h-dvh items-center justify-center p-6">
		<section className="w-full max-w-md rounded-lg border border-border bg-card p-6">
			<h1 className="font-title text-2xl">Account unavailable</h1>
			<p className="mt-3 text-sm text-muted-foreground">{lifecycle === "pending-deletion" ? "This account is pending deletion." : lifecycle === "disabled" ? "This account is disabled." : "Account service is unavailable. This page cannot access account data."}</p>
			{recoveringUntil && <p className="mt-2 text-sm">Recovery available until {recoveringUntil}.</p>}
		</section>
	</main>;
}
