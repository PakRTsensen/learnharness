"use client";

import { useCallback, useEffect, useState } from "react";

interface PublicAccount {
	accountId: string;
	role: "administrator" | "user";
	lifecycle: "active" | "disabled" | "pending-deletion";
	createdAt: string;
	deletionScheduledFor?: string;
	legacyClaimEligible: boolean;
}

interface AccountStatus {
	bootstrapRequired: boolean;
	account: PublicAccount | null;
	provider: "local" | "clerk";
	learningAvailable: boolean;
}

interface ApiError {
	error?: { code?: string; message?: string };
}

export function AccountPanel() {
	const [status, setStatus] = useState<AccountStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		setError(null);
		try {
			const response = await fetch("/api/account", { cache: "no-store" });
			if (response.status === 401) {
				window.location.assign("/sign-in");
				return;
			}
			if (!response.ok) {
				const payload = await response.json().catch(() => null) as ApiError | null;
				setError(payload?.error?.message ?? "Account status could not be loaded.");
				return;
			}
			setStatus(await response.json() as AccountStatus);
		} catch {
			setError("The server could not be reached.");
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	async function mutate(path: string, body: unknown, method = "POST"): Promise<boolean> {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(path, {
				method,
				headers: { "content-type": "application/json" },
				body: method === "DELETE" ? undefined : JSON.stringify(body),
			});
			const payload = await response.json().catch(() => null) as ApiError | null;
			if (!response.ok) {
				setError(payload?.error?.message ?? "The operation failed.");
				return false;
			}
			await load();
			return true;
		} catch {
			setError("The server could not be reached.");
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function signOut() {
		setBusy(true);
		try {
			await fetch("/api/auth/session", { method: "DELETE" });
			window.location.assign("/sign-in");
		} finally {
			setBusy(false);
		}
	}

	async function requestDeletion() {
		if (!window.confirm("Delete this account? Content is retained for a seven-day recovery window, then removed.")) return;
		await mutate("/api/account/deletion", { confirm: "delete" });
	}

	return (
		<section className="w-full rounded-md border border-border bg-card p-6 shadow-sm">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="font-title text-2xl tracking-tight">Account</h1>
					<p className="mt-1 font-ui text-sm text-muted-foreground">
						This installation is running the explicit multiuser-web composition.
					</p>
				</div>
				<button
					className="shrink-0 rounded-sm border border-border bg-surface px-3 py-1.5 font-ui text-sm transition-colors hover:bg-accent disabled:opacity-50"
					type="button"
					onClick={signOut}
					disabled={busy}
				>
					Sign out
				</button>
			</div>

			<div className="mt-6 flex flex-col gap-4">
				{!status && !error ? <p className="font-ui text-sm text-muted-foreground">Loading account status…</p> : null}

				{status?.bootstrapRequired ? (
					<div className="rounded-sm border border-border bg-background p-4">
						<p className="font-ui text-sm text-foreground">First-administrator setup is not complete.</p>
						<p className="mt-1 font-ui text-xs leading-relaxed text-muted-foreground">
							Host-authorized setup is required before ordinary registration opens.
						</p>
						<a
							className="mt-3 inline-block rounded-sm bg-primary px-3 py-1.5 font-ui text-sm text-primary-foreground"
							href="/first-admin"
						>
							Enter bootstrap secret
						</a>
					</div>
				) : null}

				{status?.account ? (
					<div className="grid gap-3 rounded-sm border border-border bg-background p-4 font-ui text-sm sm:grid-cols-2">
						<div>
							<p className="text-xs text-muted-foreground">Role</p>
							<p className="mt-0.5">{status.account.role}</p>
						</div>
						<div>
							<p className="text-xs text-muted-foreground">Lifecycle</p>
							<p className="mt-0.5">{status.account.lifecycle}</p>
						</div>
						<div>
							<p className="text-xs text-muted-foreground">Account ID</p>
							<p className="mt-0.5 break-all font-mono text-xs">{status.account.accountId}</p>
						</div>
						<div>
							<p className="text-xs text-muted-foreground">Identity provider</p>
							<p className="mt-0.5">{status?.provider ?? "—"}</p>
						</div>
						{status.account.deletionScheduledFor ? (
							<div className="sm:col-span-2">
								<p className="text-xs text-muted-foreground">Deletion scheduled</p>
								<p className="mt-0.5">{new Date(status.account.deletionScheduledFor).toLocaleString()}</p>
							</div>
						) : null}
					</div>
				) : null}

				<div className="rounded-sm border border-border bg-background p-4">
					<p className="font-ui text-sm text-foreground">Learning runtime pending</p>
					<p className="mt-1 font-ui text-xs leading-relaxed text-muted-foreground">
						Authentication, bootstrap, and account lifecycle are active. Chats, graph, files, and
						plugins stay disabled until the per-account worker isolation phase lands; this build
						never falls back to shared account storage.
					</p>
				</div>

				{status?.account?.lifecycle === "pending-deletion" ? (
					<button
						className="self-start rounded-sm bg-primary px-3 py-1.5 font-ui text-sm text-primary-foreground disabled:opacity-50"
						type="button"
						onClick={() => void mutate("/api/account/recovery", {})}
						disabled={busy}
					>
						Recover account
					</button>
				) : null}

				{status?.account?.lifecycle === "active" && status.account.role === "user" ? (
					<button
						className="self-start rounded-sm border border-[var(--lh-error)] px-3 py-1.5 font-ui text-sm text-[var(--lh-error)] transition-opacity hover:opacity-80 disabled:opacity-50"
						type="button"
						onClick={() => void requestDeletion()}
						disabled={busy}
					>
						Delete account…
					</button>
				) : null}

				{status?.account?.role === "administrator" ? (
					<p className="font-ui text-xs leading-relaxed text-muted-foreground">
						The administrator role must be transferred to another active account before this
						account can be deleted. Host recovery remains available if the sole administrator is
						disabled by Clerk.
					</p>
				) : null}
			</div>

			<p aria-live="polite" className="mt-4 min-h-5 font-ui text-sm text-[var(--lh-error)]">
				{error}
			</p>
		</section>
	);
}
