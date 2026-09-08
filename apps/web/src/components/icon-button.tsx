import { Button } from "@blabla/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@blabla/ui/components/tooltip";
import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

/** Secondary actions share an accessible name and a hover/focus hint. */
export function IconButton({
	label,
	icon: Icon,
	size = "icon-sm",
	variant = "ghost",
	...props
}: Omit<ComponentProps<typeof Button>, "children" | "size"> & {
	label: string;
	icon: LucideIcon;
	size?: "icon" | "icon-xs" | "icon-sm" | "icon-lg";
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						type="button"
						size={size}
						variant={variant}
						aria-label={label}
						{...props}
					>
						<Icon aria-hidden="true" />
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
