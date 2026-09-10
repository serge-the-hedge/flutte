import { env } from "@blabla/env/web";
import {
	type AuthClient,
	ConvexBetterAuthProvider,
} from "@convex-dev/better-auth/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import ReactDOM from "react-dom/client";

import { authClient } from "@/lib/auth-client";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(env.VITE_CONVEX_URL, {
	expectAuth: true,
});

const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	scrollRestoration: true,
	defaultPendingComponent: () => <Loader />,
	context: {},
	Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
		return (
			// Cast works around an upstream type regression where the provider's
			// `AuthClient` type rejects `createAuthClient` results on
			// better-auth >= 1.6.20. Runtime behavior is unaffected.
			// https://github.com/get-convex/better-auth/issues/393
			<ConvexBetterAuthProvider
				client={convex}
				authClient={authClient as unknown as AuthClient}
			>
				{children}
			</ConvexBetterAuthProvider>
		);
	},
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (import.meta.env.DEV && import.meta.env.VITE_STRINGS_PROTOTYPE === "1") {
	void import("./components/localization/strings.prototype-entry").then(
		({ startStringsPrototype }) => startStringsPrototype(rootElement),
	);
} else if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(<RouterProvider router={router} />);
}
