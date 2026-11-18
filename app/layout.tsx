import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import type { WebAccountAccess } from "@/src/core";
import { LocalRequestRoot, MultiuserRequestRoot, readMultiuserAccess, readAccountThemeBoot } from "./_account/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { DEPLOYMENT_MODE, DEPLOYMENT_SELECTION } = await import("../config.ts");
	let access: WebAccountAccess | undefined;
	if (!DEPLOYMENT_SELECTION.ok) {
		return <html lang="en"><body><main><h1>Service unavailable</h1><p>The deployment configuration is invalid.</p></main></body></html>;
	}
	if (DEPLOYMENT_MODE === "multiuser-web") {
		access = await readMultiuserAccess();
	}
	const { appearance, theme, vars } = await readAccountThemeBoot(access);
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased">
			{access ? <MultiuserRequestRoot access={access}>{children}</MultiuserRequestRoot>
				: <LocalRequestRoot appearance={appearance} theme={theme}>{children}</LocalRequestRoot>}
		</body>
		</html>
	);
}
