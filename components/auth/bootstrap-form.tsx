"use client";

import { useState } from "react";

export function BootstrapForm() {
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/account/bootstrap", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ secret }),
			});
			const payload = await response.json().catch(() => null) as { ok?: boolean; error?: { message?: string } } | null;
			if (!response.ok || !payload?.ok) {
				setError(payload?.error?.message ?? "First-administrator setup failed.");
				return;
			}
			window.location.assign("/account");
		} catch {
			setError("The server could not be reached.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="w-full rounded-md border border-border bg-card p-6 shadow-sm">
			<h1 className="font-title text-2xl tracking-tight">First administrator</h1>
			<p className="mt-2 font-ui text-sm leading-relaxed text-muted-foreground">
				Enter the single-commit bootstrap secret supplied by the host operator. Successful setup
				permanently consumes the secret and opens ordinary registration for this installation.
			</p>
			<form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
				<label className="flex flex-col gap-1 font-ui text-xs text-muted-foreground">
					Bootstrap secret
					<input
						className="rounded-sm border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
						type="password"
						autoComplete="off"
						required
						minLength={32}
						maxLength={512}
						value={secret}
						onChange={(event) => setSecret(event.target.value)}
					/>
				</label>
				<button
					className="rounded-sm bg-primary px-3 py-2 font-ui text-sm text-primary-foreground transition-opacity disabled:opacity-50"
					type="submit"
					disabled={busy}
				>
					{busy ? "Committing…" : "Become the first administrator"}
				</button>
				<p className="font-ui text-xs leading-relaxed text-muted-foreground">
					The secret is compared in constant time and is never stored or logged. A failed attempt
					commits no account or Linux identity and can be retried while no account exists.
				</p>
			</form>
			<p aria-live="polite" className="mt-4 min-h-5 font-ui text-sm text-[var(--lh-error)]">
				{error}
			</p>
		</section>
	);
}
