const SECRET = /\b(?:api[_ -]?key|access[_ -]?token|auth(?:entication)?[_ -]?token|password|passwd|secret|private[_ -]?key|cookie|session(?:id|token)?|bearer)\s*[=:]\s*[^\s,;]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const KEYLIKE = /\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g;
const PRIVATE_URL = /\b(?:https?:\/\/|ssh:\/\/)[^\s/]+(?::[^\s/@]+)?@[^\s]+/gi;
const PRIVATE_PATH = /(?:^|\s)(?:~\/|\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\s)]+/g;

export function sanitizeExternalText(value: string, maxLength = 2000): string {
	return value.replace(SECRET, "[REDACTED_SECRET]").replace(BEARER, "[REDACTED_BEARER]").replace(KEYLIKE, "[REDACTED_TOKEN]").replace(PRIVATE_URL, "[REDACTED_PRIVATE_URL]").replace(PRIVATE_PATH, " [REDACTED_PRIVATE_PATH]").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function sanitizeResearchQuery(value: string): string {
	const sanitized = sanitizeExternalText(value, 500);
	return sanitized.replace(/[`{}<>]/g, " ").replace(/\s+/g, " ").trim();
}

export function isExternalContentUntrusted(_content: string): true {
	return true;
}

export function wrapUntrustedExternalContent(content: string): string {
	return `[UNTRUSTED EXTERNAL CONTENT]\n${sanitizeExternalText(content, 5000)}\n[/UNTRUSTED EXTERNAL CONTENT]`;
}
