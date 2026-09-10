/** Throwaway UI runner: no credentials, hosted queries or mutations. */
console.log(
	"Strings prototype: http://localhost:3015/projects/prototype/strings?variant=A",
);
const child = Bun.spawn(
	[
		"bun",
		"run",
		"--cwd",
		"apps/web",
		"dev",
		"--host",
		"127.0.0.1",
		"--port",
		"3015",
		"--strictPort",
	],
	{
		env: {
			...Bun.env,
			VITE_STRINGS_PROTOTYPE: "1",
			VITE_CONVEX_URL: "https://prototype-unused.convex.cloud",
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
process.exit(await child.exited);
