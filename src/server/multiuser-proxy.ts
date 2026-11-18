import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { apiRequestRefusal, browserAPIRefusal } from "./desktop-access.ts";
import { selectDeploymentMode } from "../runtime/deployment-mode.ts";
import { multiuserApiResponse } from "./multiuser-gate.ts";

/** Inject the Clerk adapter only for the explicit multiuser composition. */
export function createProxy(multiuser: (request: NextRequest, event: NextFetchEvent) => Promise<Response>) {
	return async function proxy(request: NextRequest, event?: NextFetchEvent): Promise<Response> {
		const selection = selectDeploymentMode(process.env);
		const api = request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/");
		if (!selection.ok) {
			return api ? multiuserApiResponse("The deployment configuration is invalid.", 503) : new NextResponse("The deployment configuration is invalid.", {
				status: 503,
				headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
			});
		}
		const isMultiuser = selection.mode === "multiuser-web";
		// Desktop capability is desktop/local-only and cannot gate multiuser. The
		// browser Host/write-origin policy still applies to multiuser pages and
		// APIs, before Clerk and before any account work.
		const hostOrOriginRefusal = isMultiuser
			? browserAPIRefusal(request)
			: api ? apiRequestRefusal(request) : undefined;
		if (hostOrOriginRefusal) {
			return NextResponse.json({ error: hostOrOriginRefusal }, { status: 403, headers: { "Cache-Control": "no-store" } });
		}
		if (!multiuser) return NextResponse.next();
		return multiuser(request, event as NextFetchEvent);
	};
}
