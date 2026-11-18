import { AccountLearningUnavailable } from "@/components/account-learning-unavailable";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({
	searchParams,
}: {
	searchParams: Promise<{ mode?: string }>;
}) {
	const { DEPLOYMENT_MODE } = await import("@/config");
	if (DEPLOYMENT_MODE === "multiuser-web") return <AccountLearningUnavailable />;
	const { NewSession } = await import("@/components/new-session");
	const { readSettingsRecord } = await import("@/src/server");
	const { slotsConfigured } = await import("@/src/core");
	const { mode } = await searchParams;
	return <NewSession initialConfigured={slotsConfigured(readSettingsRecord()?.models)} mode={mode === "practice" ? "practice" : "teach"} />;
}
