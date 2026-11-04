import { Search } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";

/** Search is named independently of its placeholder and stays controlled by its caller. */
export const SearchField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;
  className?: string;
}>(function SearchField({ label, className = "", ...props }, ref) {
  return <label data-ui="search-field" className={className}>
    <span className="visuallyHidden">{label}</span>
    <Search aria-hidden="true" size={16} />
    <input {...props} ref={ref} type="search" aria-label={props["aria-label"] ?? label} />
  </label>;
});
