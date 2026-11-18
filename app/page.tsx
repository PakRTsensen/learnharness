import { AccountLearningUnavailable } from "@/components/account-learning-unavailable";

export const dynamic = "force-dynamic";

export default async function HomePage() {
	const { DEPLOYMENT_MODE } = await import("@/config");
	if (DEPLOYMENT_MODE === "multiuser-web") return <AccountLearningUnavailable />;
	// Local-only composition: multiuser-web must not import global stores.
	const { Home } = await import("@/components/home");
	const { readSettingsRecord } = await import("@/src/server");
	const { resolveSettings, slotsConfigured } = await import("@/src/core");
	const record = readSettingsRecord();
	const rendering = resolveSettings(record ?? null).graph.rendering;
	return <Home initialConfigured={slotsConfigured(record?.models)} rendering={rendering} />;
}
