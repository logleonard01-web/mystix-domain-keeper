import { createServerFn } from "@tanstack/react-start";

const API = "https://lllogan.com/api/public/v1";
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;

export type RdapInfo = {
  domain: string;
  registered: boolean;
  registrar?: string;
  created?: string;
};

async function rdap(domain: string): Promise<RdapInfo> {
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { accept: "application/rdap+json" },
    });
    if (r.status === 404) return { domain, registered: false };
    if (!r.ok) return { domain, registered: true };
    const j: any = await r.json();
    const reg = (j.entities ?? []).find((e: any) => e.roles?.includes("registrar"));
    const name = reg?.vcardArray?.[1]?.find((v: any) => v[0] === "fn")?.[3];
    const created = (j.events ?? []).find((e: any) => e.eventAction === "registration")?.eventDate;
    return { domain, registered: true, registrar: name, created };
  } catch {
    return { domain, registered: true };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx] as T);
      }
    }),
  );
  return out;
}

const TLDS = ["com", "net", "org", "io", "xyz", "app", "dev", "me", "co", "site", "online", "lol", "fun", "space", "club"];

export const scrapeDomains = createServerFn({ method: "POST" })
  .inputValidator((d: { mode: "keyword" | "url"; value: string }) => {
    if (!d || typeof d.value !== "string" || d.value.length > 300) throw new Error("Invalid input");
    return { mode: d.mode === "url" ? "url" : "keyword", value: d.value.trim() } as const;
  })
  .handler(async ({ data }) => {
    let candidates: string[] = [];
    if (data.mode === "keyword") {
      const words = data.value.toLowerCase().split(/[\s,]+/).map((w) => w.replace(/[^a-z0-9-]/g, "")).filter(Boolean).slice(0, 3);
      for (const w of words) {
        for (const v of [w, `${w}s`, `my${w}`, `${w}hub`, `${w}x`]) for (const t of TLDS) candidates.push(`${v}.${t}`);
      }
      candidates = candidates.slice(0, 60);
    } else {
      let url = data.value;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 MystixScraper" } });
      const html = (await res.text()).slice(0, 2_000_000);
      const set = new Set<string>();
      for (const m of html.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,24})/gi)) {
        const h = (m[1] ?? "").toLowerCase().replace(/^www\./, "");
        if (DOMAIN_RE.test(h)) set.add(h);
      }
      for (const m of html.matchAll(/\b([a-z0-9-]+\.)+(?:com|net|org|io|xyz|app|dev|me|co|site|online|lol|fun|space|club|gg|tk|ml|ga|cf)\b/gi)) {
        const h = m[0].toLowerCase().replace(/^www\./, "");
        if (DOMAIN_RE.test(h)) set.add(h);
      }
      candidates = [...set].slice(0, 50);
    }
    const infos = await pool(candidates, 8, rdap);
    return { domains: infos.filter((i) => i.registered) };
  });

export type FilterResult = { site: string; filter: string; status: string; category: string | null };

export const checkFilters = createServerFn({ method: "POST" })
  .inputValidator((d: { links: string[]; filters: string[] }) => {
    const links = (d?.links ?? []).map((l) => String(l).toLowerCase().trim()).filter((l) => DOMAIN_RE.test(l)).slice(0, 50);
    const filters = (d?.filters ?? []).map(String).filter((f) => /^[a-z0-9]+$/.test(f)).slice(0, 3);
    if (!links.length || !filters.length) throw new Error("Pick at least one domain and one filter");
    return { links, filters };
  })
  .handler(async ({ data }) => {
    const r = await fetch(`${API}/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env["LLLOGAN_API_KEY"]}`, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`Checker error (${r.status})`);
    const j: any = await r.json();
    return { results: (j.results ?? []) as FilterResult[] };
  });

export const listFilters = createServerFn({ method: "GET" }).handler(async () => {
  const r = await fetch(`${API}/filters`, { headers: { Authorization: `Bearer ${process.env["LLLOGAN_API_KEY"]}` } });
  if (!r.ok) return { filters: [] as { id: string; name: string; kind: string }[] };
  return (await r.json()) as { filters: { id: string; name: string; kind: string }[] };
});

async function isAvailable(domain: string): Promise<boolean> {
  const tld = domain.split(".").pop();
  const url = tld === "org"
    ? `https://rdap.publicinterestregistry.org/rdap/domain/${domain}`
    : `https://rdap.verisign.com/${tld}/v1/domain/${domain}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/rdap+json" } });
    return r.status !== 200; // 404 = unregistered; on errors keep it (it is on a deleted list)
  } catch {
    return true;
  }
}

const ED_TLDS = ["com", "net", "org"] as const;

const ORDERS = ["domain", "abirth", "bl", "aentries", "whois", "changes", "domainpop", "statusnet", "statusorg", "statuscom", "statustld_registered", "related_cnobi", "dmoz"];

export const scrapeExpiredPage = createServerFn({ method: "POST" })
  .inputValidator((d: { list: string; order: string; dir: string; start: number; tlds: string[] }) => {
    const list = d?.list === "com" ? "com" : "all";
    const order = ORDERS.includes(d?.order) ? d.order : "";
    const dir = d?.dir === "d" ? "d" : "a";
    const start = Math.max(0, Math.min(100000, Math.floor(Number(d?.start) || 0)));
    const tlds = (d?.tlds ?? []).filter((t) => ED_TLDS.includes(t as any));
    return { list, order, dir, start: start - (start % 25), tlds };
  })
  .handler(async ({ data }) => {
    const path = data.list === "com" ? "deleted-com-domains" : "deleted-domains";
    const qs = new URLSearchParams({ start: String(data.start) });
    if (data.order) { qs.set("o", data.order); qs.set("r", data.dir); }
    const r = await fetch(`https://www.expireddomains.net/${path}/?${qs}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        ...(process.env["EXPIREDDOMAINS_COOKIE"] ? { cookie: process.env["EXPIREDDOMAINS_COOKIE"] } : {}),
      },
    });
    if (!r.ok) return { domains: [] as string[], found: 0, status: r.status, walled: false, loggedIn: false };
    const html = await r.text();
    const loggedIn = /logout/i.test(html);
    const all = new Set<string>();
    const set = new Set<string>();
    for (const m of html.matchAll(/class="namelinks"[^>]*>([^<]+)</g)) {
      const d = (m[1] ?? "").trim().toLowerCase();
      all.add(d);
      if (data.tlds.some((t) => d.endsWith(`.${t}`)) && DOMAIN_RE.test(d)) set.add(d);
    }
    const avail = await pool([...set], 6, isAvailable);
    const walled = all.size === 0 && /Login to see all Domains/i.test(html);
    return { domains: [...set].filter((_, i) => avail[i]), found: all.size, status: 200, walled, loggedIn };
  });
