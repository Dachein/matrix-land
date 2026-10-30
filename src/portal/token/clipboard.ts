export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some embedded or policy-restricted browsers expose Clipboard API but reject it.
      // Fall through to the user-gesture-compatible textarea path.
    }
  }

  const element = document.createElement("textarea");
  element.value = value;
  element.setAttribute("readonly", "true");
  element.style.position = "fixed";
  element.style.inset = "0 auto auto 0";
  element.style.opacity = "0";
  document.body.appendChild(element);
  element.select();
  try {
    if (!document.execCommand("copy")) throw new Error("clipboard_copy_failed");
  } finally {
    document.body.removeChild(element);
  }
}
