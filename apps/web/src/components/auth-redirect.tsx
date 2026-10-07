import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const DEFAULT_AUTH_REDIRECT = "/projects";

function hasControlCharacter(value: string) {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

export function safeAuthRedirect(redirect: string | undefined) {
	if (
		!redirect?.startsWith("/") ||
		redirect.startsWith("//") ||
		redirect.startsWith("/sign-in") ||
		redirect.includes("\\") ||
		hasControlCharacter(redirect)
	) {
		return DEFAULT_AUTH_REDIRECT;
	}
	return redirect;
}

export default function AuthRedirect() {
	const router = useRouter();
	const navigate = useNavigate();
	// Navigation changes the location before this component unmounts. Keep the
	// protected URL fixed so it cannot become a recursively nested sign-in URL.
	const [redirect] = useState(() => router.state.location.href);

	useEffect(() => {
		void navigate({
			to: "/sign-in",
			search: { mode: "sign-in", redirect },
			replace: true,
		});
	}, [navigate, redirect]);

	return null;
}
