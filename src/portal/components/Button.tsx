import { Loader2 } from "lucide-react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "icon";
type ButtonSize = "default" | "compact";

type SharedButtonProps = {
  className?: string;
  iconAfter?: ReactNode;
  iconBefore?: ReactNode;
  isLoading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & SharedButtonProps;
export type ButtonLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & SharedButtonProps & {
  disabled?: boolean;
};

export function Button({
  children,
  className,
  disabled,
  iconAfter,
  iconBefore,
  isLoading = false,
  size = "default",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      data-ui="button"
      data-variant={variant}
      data-size={size}
      aria-busy={isLoading || undefined}
      className={buttonClassName({ className, size, variant })}
      disabled={disabled || isLoading}
      type={type}
    >
      {buttonContent({ children, iconAfter, iconBefore, isLoading })}
    </button>
  );
}

export function ButtonLink({
  children,
  className,
  disabled = false,
  iconAfter,
  iconBefore,
  isLoading = false,
  href,
  onClick,
  size = "default",
  variant = "secondary",
  ...props
}: ButtonLinkProps) {
  const isDisabled = disabled || isLoading;

  return (
    <a
      {...props}
      href={isDisabled ? undefined : href}
      data-ui="button"
      data-variant={variant}
      data-size={size}
      aria-busy={isLoading || undefined}
      aria-disabled={isDisabled || undefined}
      className={buttonClassName({ className: joinClassNames(className, isDisabled ? "disabled" : ""), size, variant })}
      onClick={(event) => {
        if (isDisabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      tabIndex={isDisabled ? -1 : props.tabIndex}
    >
      {buttonContent({ children, iconAfter, iconBefore, isLoading })}
    </a>
  );
}

function buttonContent({
  children,
  iconAfter,
  iconBefore,
  isLoading
}: Pick<SharedButtonProps, "iconAfter" | "iconBefore" | "isLoading"> & { children: ReactNode }) {
  return (
    <>
      {(isLoading || iconBefore) && <span aria-hidden="true" data-ui="button-icon">{isLoading ? <Loader2 className="spinIcon" size={15} /> : iconBefore}</span>}
      {children}
      {iconAfter && <span aria-hidden="true" data-ui="button-icon">{iconAfter}</span>}
    </>
  );
}

function buttonClassName({ className, size, variant }: { className?: string; size: ButtonSize; variant: ButtonVariant }) {
  const variantClassName = {
    danger: "dangerButton",
    icon: "iconButton",
    primary: "primaryButton",
    secondary: "secondaryButton"
  }[variant];

  return joinClassNames(variantClassName, size === "compact" ? "compact" : "", className);
}

function joinClassNames(...values: Array<string | undefined>) {
  return values
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" ");
}
