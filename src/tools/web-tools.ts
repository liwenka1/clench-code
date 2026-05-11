export async function executeWebFetch(input: Record<string, unknown>) {
  const started = Date.now();
  const url = normalizeFetchUrl(String(input.url ?? ""));
  const prompt = String(input.prompt ?? "");
  const response = await fetch(url, {
    headers: {
      "user-agent": "clench-code/0.1"
    },
    redirect: "follow"
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const normalized = normalizeFetchedContent(body, contentType);

  return {
    bytes: Buffer.byteLength(body, "utf8"),
    code: response.status,
    code_text: response.statusText || "Unknown",
    result: summarizeWebFetch(response.url, prompt, normalized, body, contentType),
    duration_ms: Date.now() - started,
    url: response.url
  };
}

export async function executeWebSearch(input: Record<string, unknown>) {
  const started = Date.now();
  const query = String(input.query ?? input.search_term ?? "").trim();
  if (!query) {
    throw new Error("WebSearch requires a query");
  }
  const response = await fetch(buildSearchUrl(query), {
    headers: {
      "user-agent": "clench-code/0.1"
    },
    redirect: "follow"
  });
  const html = await response.text();
  let hits = extractSearchHits(html);
  if (hits.length === 0) {
    hits = extractSearchHitsFromGenericLinks(html);
  }
  const allowedDomains = normalizeDomainList(input.allowed_domains);
  const blockedDomains = normalizeDomainList(input.blocked_domains);
  if (allowedDomains) {
    hits = hits.filter((hit) => hostMatchesList(hit.url, allowedDomains));
  }
  if (blockedDomains) {
    hits = hits.filter((hit) => !hostMatchesList(hit.url, blockedDomains));
  }
  hits = dedupeHits(hits).slice(0, 8);

  const summary =
    hits.length === 0
      ? `No web search results matched the query ${JSON.stringify(query)}.`
      : `Search results for ${JSON.stringify(query)}. Include a Sources section in the final answer.\n${hits
          .map((hit) => `- [${hit.title}](${hit.url})`)
          .join("\n")}`;

  return {
    query,
    results: [summary, { tool_use_id: "web_search_1", content: hits }],
    duration_seconds: (Date.now() - started) / 1000
  };
}

function normalizeFetchUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    parsed.protocol = "https:";
  }
  return parsed.toString();
}

function buildSearchUrl(query: string): string {
  const base = process.env.CLAWD_WEB_SEARCH_BASE_URL ?? "https://html.duckduckgo.com/html/";
  const url = new URL(base);
  url.searchParams.set("q", query);
  return url.toString();
}

function normalizeFetchedContent(body: string, contentType: string): string {
  return contentType.includes("html") ? htmlToText(body) : body.trim();
}

function summarizeWebFetch(
  url: string,
  prompt: string,
  content: string,
  rawBody: string,
  contentType: string
): string {
  const lowerPrompt = prompt.toLowerCase();
  const compact = collapseWhitespace(content);
  let detail: string;
  if (lowerPrompt.includes("title")) {
    detail = extractTitle(content, rawBody, contentType)
      ? `Title: ${extractTitle(content, rawBody, contentType)}`
      : previewText(compact, 600);
  } else if (lowerPrompt.includes("summary") || lowerPrompt.includes("summarize")) {
    detail = previewText(compact, 900);
  } else {
    detail = `Prompt: ${prompt}\nContent preview:\n${previewText(compact, 900)}`;
  }
  return `Fetched ${url}\n${detail}`;
}

function extractTitle(content: string, rawBody: string, contentType: string): string | undefined {
  if (contentType.includes("html")) {
    const match = rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = match ? collapseWhitespace(decodeHtmlEntities(stripTags(match[1] ?? ""))) : "";
    if (title) {
      return title;
    }
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function htmlToText(html: string): string {
  return collapseWhitespace(decodeHtmlEntities(stripTags(html.replace(/<\/(p|div|h\d|li|br|tr|section|article)>/gi, "\n"))));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function previewText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeDomainList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => String(entry));
}

function extractSearchHits(html: string): Array<{ title: string; url: string }> {
  const hits: Array<{ title: string; url: string }> = [];
  const regex = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    const url = decodeDuckDuckGoRedirect(decodeHtmlEntities(match[1] ?? "")) ?? decodeHtmlEntities(match[1] ?? "");
    const title = collapseWhitespace(decodeHtmlEntities(stripTags(match[2] ?? "")));
    if (title && isWebUrl(url)) {
      hits.push({ title, url });
    }
  }
  return hits;
}

function extractSearchHitsFromGenericLinks(html: string): Array<{ title: string; url: string }> {
  const hits: Array<{ title: string; url: string }> = [];
  const regex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    const url = decodeDuckDuckGoRedirect(decodeHtmlEntities(match[1] ?? "")) ?? decodeHtmlEntities(match[1] ?? "");
    const title = collapseWhitespace(decodeHtmlEntities(stripTags(match[2] ?? "")));
    if (title && isWebUrl(url)) {
      hits.push({ title, url });
    }
  }
  return hits;
}

function decodeDuckDuckGoRedirect(url: string): string | undefined {
  if (isWebUrl(url)) {
    return url;
  }
  try {
    const absolute = url.startsWith("//")
      ? new URL(`https:${url}`)
      : url.startsWith("/")
        ? new URL(url, "https://duckduckgo.com")
        : new URL(url);
    const uddg = absolute.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : undefined;
  } catch {
    return undefined;
  }
}

function hostMatchesList(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => {
    try {
      const parsed = new URL(domain);
      return parsed.hostname.toLowerCase() === host;
    } catch {
      return domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") === host;
    }
  });
}

function dedupeHits(hits: Array<{ title: string; url: string }>): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.url)) {
      return false;
    }
    seen.add(hit.url);
    return true;
  });
}

function isWebUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
