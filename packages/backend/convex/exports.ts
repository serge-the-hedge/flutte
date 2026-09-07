import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { requireViewer } from "./permissions";
// Historical export evidence only. Release Bundles are the sole artifact writer.

export const getJob = query({
	args: { jobId: v.id("exportJobs") },
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Export job not found.",
			});
		await requireViewer(ctx, job.projectId);
		return job;
	},
});
