export const ED_TLDS = ["com", "net", "org", "xyz", "online", "site", "store", "shop", "top", "fun", "space", "club", "info", "biz", "icu", "lol", "website", "tech", "pw", "cc", "us", "io", "co", "me"] as const;

export function hasExpiredAccount(html: string) {
  return /href\s*=\s*["'][^"']*\/logout\/?(?:\?[^"']*)?["']/i.test(html);
}

export function expiredNextStart(html: string, current: number): number | null {
  const offsets = [...html.matchAll(/href=["']([^"']+)["']/gi)].flatMap((match) => {
    try {
      const url = new URL((match[1] ?? "").replace(/&amp;/g, "&"), "https://www.expireddomains.net");
      if (url.origin !== "https://www.expireddomains.net") return [];
      const raw = url.searchParams.get("start");
      const next = Number(raw);
      return raw !== null && Number.isSafeInteger(next) && next > current ? [next] : [];
    } catch { return []; }
  });
  return offsets.length ? Math.min(...offsets) : null;
}

export function requireExpiredCookie(cookie: string) {
  if (!cookie.trim()) throw new Error("Connect your ExpiredDomains account before scraping.");
  return cookie;
}