import { createServerFn } from "@tanstack/react-start";
import { ED_TLDS, expiredNextStart, hasExpiredAccount, requireExpiredCookie } from "./expired";
import { PUBLIC_FILTERS, repositoryCheck, resolveFilterChecks, type FilterResult } from "./filter-checker";

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

export type { FilterResult } from "./filter-checker";

export const checkFilters = createServerFn({ method: "POST" })
  .inputValidator((d: { links: string[]; filters: string[] }) => {
    const links = (d?.links ?? []).map((l) => String(l).toLowerCase().trim()).filter((l) => DOMAIN_RE.test(l)).slice(0, 12);
    const filters = (d?.filters ?? []).map(String).filter((f) => /^[a-z0-9]+$/.test(f)).slice(0, 3);
    if (!links.length || !filters.length) throw new Error("Pick at least one domain and one filter");
    return { links, filters };
  })
  .handler(async ({ data }) => {
    const key = process.env["LLLOGAN_API_KEY"];
    const results = await resolveFilterChecks(data.links, data.filters, repositoryCheck, async (links, filters) => {
    if (!key) return [];
    const r = await fetch(`${API}/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ links, filters }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Checker error (${r.status})`);
    const j: any = await r.json();
    return (j.results ?? []) as FilterResult[];
    });
    return { results };
  });

export const listFilters = createServerFn({ method: "GET" }).handler(async () => {
  const filters = [...PUBLIC_FILTERS, ...["securly", "goguardianv3", "lightspeed"].map((id) => ({ id, name: id === "goguardianv3" ? "GoGuardian v3" : id === "securly" ? "Securly" : "Lightspeed", kind: "LLLogan" }))];
  try {
    const r = await fetch(`${API}/filters`, { headers: { Authorization: `Bearer ${process.env["LLLOGAN_API_KEY"]}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json() as { filters: { id: string; name: string; kind: string }[] };
      for (const f of data.filters ?? []) if (!filters.some((existing) => existing.id === f.id)) filters.push(f);
    }
  } catch { /* keep selectable defaults */ }
  return { filters };
});

let boot: Promise<Record<string, string>> | null = null;
function rdapBase(tld: string) {
  boot ??= fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((j: any) => {
    const m: Record<string, string> = {};
    for (const [tl, urls] of j.services ?? []) for (const t of tl) m[t] = urls[0];
    return m;
  }).catch(() => { boot = null; return {}; });
  return boot.then((m) => m[tld]);
}

async function isAvailable(domain: string): Promise<boolean> {
  const tld = domain.split(".").pop() ?? "";
  let base = tld === "com" || tld === "net" ? `https://rdap.verisign.com/${tld}/v1/` : tld === "org" ? "https://rdap.publicinterestregistry.org/rdap/" : await rdapBase(tld);
  if (!base) base = "https://rdap.org/";
  if (!base.endsWith("/")) base += "/";
  try {
    const r = await fetch(`${base}domain/${domain}`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(6000) });
    return r.status === 404;
  } catch {
    return false;
  }
}

const ORDERS = ["domain", "abirth", "bl", "aentries", "whois", "changes", "domainpop", "statusnet", "statusorg", "statuscom", "statustld_registered", "related_cnobi", "dmoz"];

export const scrapeExpiredPage = createServerFn({ method: "POST" })
  .inputValidator((d: { list: string; order: string; dir: string; start: number; tlds: string[]; cookie?: string; ftld?: string }) => {
    const list = d?.list === "com" ? "com" : "all";
    const order = ORDERS.includes(d?.order) ? d.order : "";
    const dir = d?.dir === "d" ? "d" : "a";
    const start = Math.max(0, Math.floor(Number(d?.start) || 0));
    if (!Number.isSafeInteger(start)) throw new Error("Invalid page offset");
    const tlds = (d?.tlds ?? []).filter((t) => ED_TLDS.includes(t as any));
    const cookie = typeof d?.cookie === "string" ? d.cookie.slice(0, 8000) : "";
    const ftld = ED_TLDS.includes(d?.ftld as any) ? d.ftld : "";
    return { list, order, dir, start: start - (start % 25), tlds, cookie, ftld };
  })
  .handler(async ({ data }) => {
    const cookie = requireExpiredCookie(data.cookie || "");
    const path = data.ftld ? `deleted-${data.ftld}-domains` : data.list === "com" ? "deleted-com-domains" : "deleted-domains";
    const qs = new URLSearchParams({ start: String(data.start) });
    if (data.order) { qs.set("o", data.order); qs.set("r", data.dir); }
    const r = await fetch(`https://www.expireddomains.net/${path}/?${qs}`, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        ...(cookie ? { cookie } : {}),
      },
    });
    if (!r.ok) return { domains: [] as string[], found: 0, status: r.status, walled: false, loggedIn: false, nextStart: null as number | null };
    const html = await r.text();
    const loggedIn = hasExpiredAccount(html);
    if (!loggedIn) return { domains: [] as string[], found: 0, status: 200, walled: true, loggedIn: false, nextStart: null as number | null };
    const all = new Set<string>();
    const set = new Set<string>();
    for (const m of html.matchAll(/class="namelinks"[^>]*>([^<]+)</g)) {
      const d = (m[1] ?? "").trim().toLowerCase();
      all.add(d);
      if (data.tlds.some((t) => d.endsWith(`.${t}`)) && DOMAIN_RE.test(d)) set.add(d);
    }
    const avail = await pool([...set], 6, isAvailable);
    const walled = all.size === 0 && /Login to see all Domains/i.test(html);
    return { domains: [...set].filter((_, i) => avail[i]), found: all.size, status: 200, walled, loggedIn, nextStart: expiredNextStart(html, data.start) };
  });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
function jarOf(str: string) { const m = new Map<string, string>(); for (const p of str.split(";")) { const i = p.indexOf("="); if (i > 0) m.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } return m; }
function eat(jar: Map<string, string>, r: Response) { for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(";")[0] ?? ""; const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } }
const ser = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function finish(jar: Map<string, string>, r0: Response) {
  let r = r0; eat(jar, r);
  let loc = r.headers.get("location") ?? "";
  // follow redirects by hand so cookies set on every hop are kept
  for (let i = 0; i < 6 && loc && !/emailauth/.test(loc); i++) {
    r = await fetch(new URL(loc, "https://www.expireddomains.net").href, { redirect: "manual", headers: { "user-agent": UA, cookie: ser(jar) } });
    eat(jar, r);
    loc = r.headers.get("location") ?? "";
  }
  if (/emailauth/.test(loc)) {
    const authUrl = new URL(loc, "https://www.expireddomains.net").href;
    // the site emails the code when this page is opened
    eat(jar, await fetch(authUrl, { headers: { "user-agent": UA, cookie: ser(jar) } }));
    return { ok: false, needsCode: true, authUrl, cookie: ser(jar) };
  }
  const check = await fetch("https://www.expireddomains.net/", { headers: { "user-agent": UA, cookie: ser(jar) } });
  eat(jar, check);
  const ok = hasExpiredAccount(await check.text());
  const body = r === r0 && r.status === 200 ? await r.text() : "";
  const reason = ok ? "" : /not correct/i.test(body) ? "That code isn't correct" : /wrong|invalid|incorrect/i.test(body) ? "Wrong username or password" : `Sign-in not accepted (status ${r0.status})`;
  console.log("[expireddomains login]", { status: r0.status, ok, reason, cookies: [...jar.keys()] });
  return { ok, needsCode: false, authUrl: "", cookie: ok ? ser(jar) : "", reason };
}

export const loginExpired = createServerFn({ method: "POST" })
  .inputValidator((d: { login: string; password: string }) => ({ login: String(d?.login ?? "").slice(0, 200), password: String(d?.password ?? "").slice(0, 200) }))
  .handler(async ({ data }) => {
    const jar = new Map<string, string>();
    eat(jar, await fetch("https://www.expireddomains.net/login/", { headers: { "user-agent": UA } }));
    const r = await fetch("https://www.expireddomains.net/logincheck/", {
      method: "POST", redirect: "manual",
      headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", cookie: ser(jar), referer: "https://www.expireddomains.net/login/" },
      body: new URLSearchParams({ login: data.login, password: data.password, rememberme: "1" }),
    });
    return finish(jar, r);
  });

export const verifyExpiredCode = createServerFn({ method: "POST" })
  .inputValidator((d: { authUrl: string; cookie: string; code: string }) => {
    const authUrl = String(d?.authUrl ?? "");
    if (!/^https:\/\/www\.expireddomains\.net\/emailauth\/[A-Za-z0-9]+\/?$/.test(authUrl)) throw new Error("bad url");
    return { authUrl, cookie: String(d?.cookie ?? "").slice(0, 8000), code: String(d?.code ?? "").trim().slice(0, 50) };
  })
  .handler(async ({ data }) => {
    const jar = jarOf(data.cookie);
    const r = await fetch(data.authUrl, {
      method: "POST", redirect: "manual",
      headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", cookie: ser(jar), referer: data.authUrl },
      body: new URLSearchParams({ secret_code: data.code, rememberme: "1" }),
    });
    const res = await finish(jar, r);
    return { ok: res.ok, cookie: res.cookie, reason: res.reason };
  });
