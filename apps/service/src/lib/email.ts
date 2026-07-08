export const maxEmailLength = 320;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const atIndex = value.indexOf("@");
  return (
    value.length > 0 &&
    value.length <= maxEmailLength &&
    atIndex > 0 &&
    atIndex === value.lastIndexOf("@") &&
    atIndex !== value.length - 1 &&
    !/\s/.test(value)
  );
}

export function normalizeValidEmail(value: string): string | null {
  const normalized = normalizeEmail(value);
  return isValidEmail(normalized) ? normalized : null;
}
