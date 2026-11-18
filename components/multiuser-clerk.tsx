"use client";

import { ClerkProvider, UserButton, SignIn, SignUp, useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/** Every Clerk rendering surface is in this thin client wrapper so local mode
 * neither mounts Provider nor executes a Clerk hook. Dynamic rendering is
 * required: the provider's documented static wrapper defers children. */
export function MultiuserClerkProvider({ children }: { children: React.ReactNode }) {
	return <ClerkProvider
		dynamic
		signInUrl="/sign-in"
		signUpUrl="/sign-up"
		signInFallbackRedirectUrl="/"
		signUpFallbackRedirectUrl="/"
		afterSignOutUrl="/sign-in"
	>{children}</ClerkProvider>;
}

export function MultiuserAuthForm({ operation }: { operation: "sign-in" | "sign-up" }) {
	return operation === "sign-in"
		? <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
		: <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />;
}

export function MultiuserUserButton() {
	return <UserButton userProfileMode="modal" afterSwitchSessionUrl="/" />;
}

/** A full navigation is authoritative on a session/account switch; no old SSE,
 * chat/settings DOM, in-memory plugin state, or local cache is reused. */
export function MultiuserSessionBoundary() {
	const { isLoaded, userId } = useAuth();
	const pathname = usePathname();
	const previous = useRef<{ initialized: boolean; userId: string | null }>({ initialized: false, userId: null });
	useEffect(() => {
		if (!isLoaded) return;
		const current = userId ?? null;
		const changed = previous.current.initialized && previous.current.userId !== current;
		const wrongAuthPage = current !== null && (pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up"));
		previous.current = { initialized: true, userId: current };
		// Navigate only on an account transition or a signed-in public page;
		// re-running this effect after navigation must never refresh the same URL.
		if (changed || wrongAuthPage) window.location.assign(multiuserLandingPath(pathname, current !== null));
	}, [isLoaded, userId, pathname]);
	return null;
}

export function multiuserLandingPath(pathname: string, signedIn: boolean): string {
	if (signedIn) return pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up") ? "/" : pathname;
	return "/sign-in";
}
