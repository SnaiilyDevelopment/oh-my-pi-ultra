import { createHash } from "node:crypto";

const SECRET_KEY = /(api[-_]?key|access[-_]?token|token|auth(?:orization)?|cookie|credential|password|private[-_]?key|client[-_]?secret|secret)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g;

export function sanitizeString(value: string, maxChars = 12_000): string {
	const clipped = value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
	return clipped.replace(SECRET_VALUE, "[REDACTED]");
}

export function sanitizeObject<T>(value: T, depth = 0): T {
	if (depth > 6) return "[TRUNCATED]" as T;
	if (typeof value === "string") return sanitizeString(value) as T;
	if (Array.isArray(value)) return value.map(item => sanitizeObject(item, depth + 1)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeObject(child, depth + 1);
		}
		return out as T;
	}
	return value;
}

export function redactEnvironment(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_KEY.test(key)) out[key] = "[REDACTED]";
		else if (value !== undefined) out[key] = sanitizeString(value, 240);
	}
	return out;
}

export function hashCommand(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function fingerprintTask(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function safePath(value: string): string {
	return value.replace(/[^A-Za-z0-9._/-]/g, "_").slice(0, 240) || "item";
}
