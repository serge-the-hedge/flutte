type ReviewActor = { kind: string; id: string };
type ReviewAuthority =
	| { kind: "projectPolicy"; policyRevision: number }
	| { kind: "candidateGrant" };

/** The reviewer is the agent credential. The human's permission is separate
 * provenance; it never changes agent authorship into a human review. */
export function AgentReviewEvidence({
	reviewer,
	authorization,
	tokens,
}: {
	reviewer: ReviewActor | undefined;
	authorization?: ReviewAuthority;
	tokens: readonly { _id: string; name: string }[] | undefined;
}) {
	if (reviewer?.kind !== "agent") return null;
	const name =
		tokens?.find((token) => token._id === reviewer.id)?.name ?? reviewer.id;
	return (
		<p className="text-muted-foreground text-xs">
			Reviewer agent: <span title={reviewer.id}>{name}</span>
			{authorization ? (
				<>
					{" "}
					·{" "}
					{authorization.kind === "projectPolicy"
						? `project setting (revision ${authorization.policyRevision})`
						: "human delegation for this revision"}
				</>
			) : null}
		</p>
	);
}
