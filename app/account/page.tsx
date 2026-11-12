import { redirect } from "next/navigation";
import { AccountPanel } from "@/components/account/account-panel";
import { parseDeploymentMode } from "@/src/multiuser";

export const dynamic = "force-dynamic";

export default function AccountPage() {
	const parsed = parseDeploymentMode();
	if (!parsed.ok || parsed.selection.mode !== "multiuser-web") redirect("/");
	return <AccountPanel />;
}
