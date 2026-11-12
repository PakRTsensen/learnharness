import { redirect } from "next/navigation";
import { BootstrapForm } from "@/components/auth/bootstrap-form";
import { parseDeploymentMode } from "@/src/multiuser";

export const dynamic = "force-dynamic";

export default function FirstAdminPage() {
	const parsed = parseDeploymentMode();
	if (!parsed.ok || parsed.selection.mode !== "multiuser-web") redirect("/");
	return <BootstrapForm />;
}
