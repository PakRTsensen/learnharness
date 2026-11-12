"use client";

import { useState } from "react";

type AuthMode = "sign-in" | "sign-up";

export interface AuthPanelProps {
	mode: AuthMode;
	provider: "local" | "clerk";
	clerkSignInUrl?: string;
	clerkSignUpUrl?: string;
}

interface AuthResponse {
	ok?: boolean;
	redirectTo?: string;
	error?: { message?: string };
}

async function readResponse(response: Response): Promise<AuthResponse | null> {
	try {
		return await response.json() as AuthResponse;
	} catch {
		return null;
	}
}

export function AuthPanel({ mode, provider, clerkSignInUrl, clerkSignUpUrl }: AuthPanelProps) {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [clerkToken, setClerkToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submitLocal(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email, name: name || undefined }),
			});
			const payload = await readResponse(response);
			if (!response.ok || !payload?.ok) {
				setError(payload?.error?.message ?? "Sign-in failed.");
				return;
			}
			window.location.assign(payload.redirectTo ?? "/account");
		} catch {
			setError("The server could not be reached.");
		} finally {
			setBusy(false);
		}
	}

	async function submitClerk(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/clerk", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: clerkToken.trim() }),
			});
			const payload = await readResponse(response);
			if (!response.ok || !payload?.ok) {
				setError(payload?.error?.message ?? "Clerk session exchange failed.");
				return;
			}
			window.location.assign(payload.redirectTo ?? "/account");
		} catch {
			setError("The server could not be reached.");
		} finally {
			setBusy(false);
		}
	}

	const isSignUp = mode === "sign-up";
	const clerkUrl = isSignUp ? clerkSignUpUrl ?? clerkSignInUrl : clerkSignInUrl;

	return (
		<section className="w-full rounded-md border border-border bg-card p-6 shadow-sm">
			<h1 className="font-title text-2xl tracking-tight">Learning Harness</h1>
			<p className="mt-1 font-ui text-sm text-muted-foreground">
				{isSignUp ? "Create an account for this installation." : "Sign in to your account."}
			</p>

			{provider === "local" ? (
				<form className="mt-6 flex flex-col gap-4" onSubmit={submitLocal}>
					<label className="flex flex-col gap-1 font-ui text-xs text-muted-foreground">
						Email
						<input
							className="rounded-sm border border-border bg-background px-3 py-2 font-ui text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1 font-ui text-xs text-muted-foreground">
						Display name (optional)
						<input
							className="rounded-sm border border-border bg-background px-3 py-2 font-ui text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
							type="text"
							autoComplete="name"
							maxLength={128}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<button
						className="rounded-sm bg-primary px-3 py-2 font-ui text-sm text-primary-foreground transition-opacity disabled:opacity-50"
						type="submit"
						disabled={busy}
					>
						{busy ? "Signing in…" : isSignUp ? "Create offline identity" : "Sign in offline"}
					</button>
					<p className="font-ui text-xs leading-relaxed text-muted-foreground">
						This installation uses the local identity simulation. No password is checked and no
						Clerk request is made; use it for local or offline development only.
					</p>
				</form>
			) : (
				<div className="mt-6 flex flex-col gap-5">
					{clerkUrl ? (
						<a
							className="rounded-sm bg-primary px-3 py-2 text-center font-ui text-sm text-primary-foreground transition-opacity hover:opacity-90"
							href={clerkUrl}
							rel="noreferrer"
						>
							{isSignUp ? "Continue to Clerk sign-up" : "Continue with Clerk"}
						</a>
					) : (
						<p className="font-ui text-sm leading-relaxed text-muted-foreground">
							Clerk is configured for this installation. Open your Clerk sign-in page, then
							exchange the resulting session token below.
						</p>
					)}
					<form className="flex flex-col gap-3 border-t border-border pt-5" onSubmit={submitClerk}>
						<label className="flex flex-col gap-1 font-ui text-xs text-muted-foreground">
							Clerk session token
							<textarea
								className="min-h-24 rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
								required
								spellCheck={false}
								value={clerkToken}
								onChange={(event) => setClerkToken(event.target.value)}
							/>
						</label>
						<button
							className="rounded-sm border border-border bg-surface px-3 py-2 font-ui text-sm transition-colors hover:bg-accent disabled:opacity-50"
							type="submit"
							disabled={busy}
						>
							{busy ? "Exchanging…" : "Exchange session token"}
						</button>
						<p className="font-ui text-xs leading-relaxed text-muted-foreground">
							The token is verified against the configured Clerk issuer and JWKS. It is never
							stored in the browser; only this installation&apos;s short-lived session cookie is set.
						</p>
					</form>
				</div>
			)}

			<p aria-live="polite" className="mt-4 min-h-5 font-ui text-sm text-[var(--lh-error)]">
				{error}
			</p>
		</section>
	);
}
