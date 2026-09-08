import { Button } from "@blabla/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@blabla/ui/components/field";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@blabla/ui/components/select";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useState } from "react";

import { api, convexId } from "@/lib/convex-api";
import { convexApplicationErrorMessage } from "@/lib/translation-task-review";

type ReviewAuthorization = FunctionReturnType<
	typeof api.agentTranslationProposals.candidateReviewAuthorization
>;

type DelegationProps = {
	revisionId: string;
	reviewUrl: string;
	disabled?: boolean;
};

/** Human review stays compact. Authorization reads start only when someone
 * opens this exact revision's independent-review controls. */
export function CandidateReviewDelegation(props: DelegationProps) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	return (
		<div className="flex flex-col gap-2">
			<Button
				variant="ghost"
				size="sm"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((current) => !current)}
			>
				Independent agent review
			</Button>
			{open ? (
				<div id={panelId}>
					<CandidateReviewData {...props} />
				</div>
			) : null}
		</div>
	);
}

function CandidateReviewData({
	revisionId,
	reviewUrl,
	disabled = false,
}: DelegationProps) {
	const authorization = useQuery(
		api.agentTranslationProposals.candidateReviewAuthorization,
		{
			candidateRevisionId:
				convexId<"agentTranslationCandidateRevisions">(revisionId),
		},
	);
	const grant = useMutation(api.agentTranslationProposals.grantCandidateReview);
	const revoke = useMutation(
		api.agentTranslationProposals.revokeCandidateReviewGrant,
	);
	if (!authorization)
		return (
			<p role="status" className="text-muted-foreground text-xs">
				Loading reviewer permissions…
			</p>
		);
	return (
		<CandidateReviewControls
			key={revisionId}
			authorization={authorization}
			disabled={disabled}
			reviewUrl={reviewUrl}
			onGrant={(tokenId) =>
				grant({
					candidateRevisionId:
						convexId<"agentTranslationCandidateRevisions">(revisionId),
					reviewerTokenId: convexId<"apiTokens">(tokenId),
				})
			}
			onRevoke={(grantId) =>
				revoke({ grantId: convexId<"agentReviewGrants">(grantId) })
			}
		/>
	);
}

export function CandidateReviewControls({
	authorization,
	disabled,
	reviewUrl,
	onGrant,
	onRevoke,
}: {
	authorization: ReviewAuthorization;
	disabled: boolean;
	reviewUrl: string;
	onGrant: (tokenId: string) => Promise<unknown>;
	onRevoke: (grantId: string) => Promise<unknown>;
}) {
	const [reviewerId, setReviewerId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const fieldId = useId();
	const reviewer = authorization.reviewers.find(
		(item) => item.tokenId === reviewerId,
	);
	const authorized =
		authorization.policy.enabled || authorization.grants.length > 0;
	const alreadyGranted = authorization.grants.some(
		(grant) => grant.reviewerTokenId === reviewerId,
	);
	async function change(action: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(
				convexApplicationErrorMessage(
					cause,
					"Could not change reviewer delegation.",
				),
			);
		} finally {
			setBusy(false);
		}
	}
	async function copyUrl() {
		try {
			await navigator.clipboard.writeText(reviewUrl);
			setCopied(true);
		} catch {
			setError("Could not copy the review URL. Select and copy it below.");
		}
	}
	return (
		<div className="flex flex-col gap-2 border-t pt-3 text-xs">
			<p className="text-muted-foreground">
				{authorization.policy.enabled
					? "Project settings allow a separate agent to review this candidate."
					: "Allow a separate agent to review this revision only. Later revisions need new permission."}
			</p>
			{authorization.canGrant && !authorization.policy.enabled ? (
				authorization.reviewers.length > 0 ? (
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={fieldId}>Reviewer credential</FieldLabel>
							<Select
								value={reviewerId}
								onValueChange={setReviewerId}
								disabled={disabled || busy}
								items={authorization.reviewers.map((item) => ({
									value: item.tokenId,
									label: item.name,
								}))}
							>
								<SelectTrigger id={fieldId}>
									<SelectValue placeholder="Choose a separate reviewer" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{authorization.reviewers.map((item) => (
											<SelectItem key={item.tokenId} value={item.tokenId}>
												{item.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</Field>
						<Button
							variant="outline"
							size="sm"
							disabled={disabled || busy || !reviewer || alreadyGranted}
							onClick={() => {
								if (reviewer) void change(() => onGrant(reviewer.tokenId));
							}}
						>
							Delegate this revision
						</Button>
					</FieldGroup>
				) : (
					<p className="text-muted-foreground">
						An owner must create a separate reviewer token in API tokens first.
					</p>
				)
			) : null}
			{authorization.grants.map((grant) => (
				<div
					key={grant.grantId}
					className="flex items-center justify-between gap-2"
				>
					<span>
						Delegated to{" "}
						{authorization.reviewers.find(
							(item) => item.tokenId === grant.reviewerTokenId,
						)?.name ?? grant.reviewerTokenId}
					</span>
					{authorization.canGrant ? (
						<Button
							variant="ghost"
							size="xs"
							disabled={busy}
							onClick={() => void change(() => onRevoke(grant.grantId))}
						>
							Revoke delegation
						</Button>
					) : null}
				</div>
			))}
			{authorization.policy.enabled && authorization.grants.length > 0 ? (
				<p className="text-muted-foreground">
					Revoking a delegation does not disable the project setting.
				</p>
			) : null}
			{authorized ? (
				<>
					<p className="text-muted-foreground">
						Give this URL and a separate reviewer token to an agent other than
						the translator.
					</p>
					<code className="break-all">{reviewUrl}</code>
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
						onClick={() => void copyUrl()}
					>
						{copied ? "Review URL copied" : "Copy review URL"}
					</Button>
				</>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}

export function candidateReviewUrl(serverUrl: string, revisionId: string) {
	return new URL(
		`/api/agent/v1/candidate-reviews/${encodeURIComponent(revisionId)}`,
		serverUrl,
	).href;
}
