import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { requireViewer } from "./permissions";
// Historical import evidence only. Source Snapshot ingestion owns all catalog writes.

export const getJob = query({
	args: { jobId: v.id("importJobs") },
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job)
			throw new ConvexError({
				code: "NOT_FOUND",
				message: "Import job not found.",
			});
		await requireViewer(ctx, job.projectId);
		return job;
	},
});
