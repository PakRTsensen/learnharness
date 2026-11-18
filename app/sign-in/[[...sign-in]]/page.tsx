import { MultiuserAuthForm } from "@/components/multiuser-clerk";

export const dynamic = "force-dynamic";

export default function SignInPage() {
	return <main className="flex min-h-dvh items-center justify-center p-6"><MultiuserAuthForm operation="sign-in" /></main>;
}
