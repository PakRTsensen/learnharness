import { notFound } from "next/navigation";
import { AccountLearningUnavailable } from "@/components/account-learning-unavailable";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const { DEPLOYMENT_MODE } = await import("@/config");
	// Check the composition before params or any shared chat/plugin store.
	if (DEPLOYMENT_MODE === "multiuser-web") return <AccountLearningUnavailable />;
	const { Chat } = await import("@/components/chat");
	const { slotsConfigured } = await import("@/src/core");
	const { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, turnFailure } = await import("@/src/server");
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	const record = readSettingsRecord();
	return <Chat key={chat.id} chatId={chat.id} title={chat.title} kind={chat.kind ?? "teach"}
		initialMessages={chat.messages} initialError={turnFailure(chat.id)}
		initialConfigured={slotsConfigured(record?.models)} initialPrompt={prompt}
		initiallyInFlight={isTurnRunning(chat.id)} initiallyCompacting={compactionInFlight(chat.id)} />;
}
