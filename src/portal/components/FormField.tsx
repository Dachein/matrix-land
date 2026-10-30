import { createContext, useContext, useId, forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

const FieldContext = createContext<{ id?: string; describedBy?: string; invalid?: boolean; required?: boolean }>({});

type FieldStatus = "default" | "error" | "success";

type FormFieldProps = {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  error?: ReactNode;
  full?: boolean;
  hideLabel?: boolean;
  htmlFor?: string;
  label: ReactNode;
  required?: boolean;
  status?: FieldStatus;
};

export function FormField({
  children,
  className = "",
  description,
  error,
  full = false,
  hideLabel = false,
  htmlFor,
  label,
  required = false,
  status = "default"
}: FormFieldProps) {
  const fieldStatus = error ? "error" : status;
  const generatedId = useId();
  const id = htmlFor ?? generatedId;
  const describedBy = [description ? `${id}-description` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: fieldStatus === "error", required }}>
    <label data-ui="field" data-status={fieldStatus} className={joinClassNames("formField", full ? "full" : "", fieldStatus !== "default" ? `is-${fieldStatus}` : "", className)} htmlFor={htmlFor}>
      <span className={joinClassNames("formFieldLabel", hideLabel ? "visuallyHidden" : "")}>
        {label}
        {required && <span className="formFieldRequired" aria-hidden="true">*</span>}
      </span>
      {children}
      {description && <small id={`${id}-description`} className="formFieldDescription">{description}</small>}
      {error && (
        <small id={`${id}-error`} className="formFieldMessage" role="alert">
          {error}
        </small>
      )}
    </label>
    </FieldContext.Provider>
  );
}

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({ className = "", ...props }, ref) {
  const field = useContext(FieldContext);
  return <input data-ui="input" className={joinClassNames("textInput", className)} ref={ref} {...props} id={props.id ?? field.id} required={props.required ?? field.required}
    aria-invalid={props["aria-invalid"] ?? (field.invalid || undefined)}
    aria-describedby={[props["aria-describedby"], field.describedBy].filter(Boolean).join(" ") || undefined} />;
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ className = "", ...props }, ref) {
  const field = useContext(FieldContext);
  return <textarea data-ui="textarea" className={joinClassNames("textArea", className)} ref={ref} {...props} id={props.id ?? field.id} required={props.required ?? field.required}
    aria-invalid={props["aria-invalid"] ?? (field.invalid || undefined)}
    aria-describedby={[props["aria-describedby"], field.describedBy].filter(Boolean).join(" ") || undefined} />;
});

export type SelectInputProps = SelectHTMLAttributes<HTMLSelectElement> & { appearance?: "default" | "line" };

export const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput({ className = "", appearance = "default", ...props }, ref) {
  const field = useContext(FieldContext);
  const select = <select data-ui="select" data-appearance={appearance} className={joinClassNames("selectInput", className)} ref={ref} {...props} id={props.id ?? field.id} required={props.required ?? field.required}
    aria-invalid={props["aria-invalid"] ?? (field.invalid || undefined)}
    aria-describedby={[props["aria-describedby"], field.describedBy].filter(Boolean).join(" ") || undefined} />;
  return appearance === "line" && !props.multiple && (!props.size || props.size === 1)
    ? <span data-ui="select-shell">{select}<ChevronDown data-ui="select-chevron" aria-hidden="true" strokeWidth={1} /></span>
    : select;
});

function joinClassNames(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}
