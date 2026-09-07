import aggregate from "@convex-dev/aggregate/convex.config";
import betterAuth from "@convex-dev/better-auth/convex.config";
import migrations from "@convex-dev/migrations/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import resend from "@convex-dev/resend/convex.config";
import workflow from "@convex-dev/workflow/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(betterAuth);
// Retain historical component mounts until deployed data can be audited.
// Application code no longer uses the old migrations/aggregate/workflow scaffolding.
app.use(migrations);
app.use(rateLimiter);
app.use(resend);
app.use(aggregate);
app.use(workflow);

export default app;
