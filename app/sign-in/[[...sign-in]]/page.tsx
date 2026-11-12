import { redirect } from "next/navigation";
import { AuthPanel } from "@/components/auth/auth-panel";
import { loadMultiuserConfig, parseDeploymentMode } from "@/src/multiuser";

export const dynamic = "force-dynamic";

export default function SignInPage() {
	const parsed = parseDeploymentMode();
	if (!parsed.ok || parsed.selection.mode !== "multiuser-web") redirect("/");
	const loaded = loadMultiuserConfig();
	if (!loaded.ok) redirect("/");
	const auth = loaded.config.auth;
	return (
		<AuthPanel
			mode="sign-in"
			provider={auth.provider}
			{...(auth.provider === "clerk" && auth.signInUrl ? { clerkSignInUrl: auth.signInUrl } : {})}
		/>
	);
}
